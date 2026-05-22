import { Linking, Platform } from 'react-native';

import { APP_VERSION } from '../../../config/env';
import {
  noteBridgeHeartbeat,
  reset as resetRefreshMutex,
  type BridgeHeartbeatPayload,
} from '../../../services/auth/refreshMutex';
import {
  clearSession,
  setSession,
} from '../../../services/auth/session';
import {
  clearExplicitlyLoggedOut,
  setExplicitlyLoggedOut,
} from '../../../services/auth/loggedOutFlag';
import {
  runGoogleSignIn,
  runGoogleSignOut,
} from '../../auth/googleSignIn';
import { deleteCustomerLog } from '../../callRecording/api/records';
import {
  scanForCallRecordings,
  simulateCallEnd,
} from '../../callRecording/scanner/recordingScanner';
import { ApiError } from '../../../services/api/client';
import { getFcmToken } from '../../../services/fcm/getFcmToken';
import {
  registerFcmTokenWithServer,
  unregisterFcmTokenWithServer,
} from '../../../services/fcm/registerFcmToken';
import {
  clearErrorLog,
  logError,
  readErrorLog,
} from '../../../services/logger/errorLog';
import {
  clearLedgerGroupsCache,
  syncLedgerGroupsToNative,
} from '../../callRecording/services/ledgerGroupsSync';
import { callWebBridge, dispatchWebBridge } from './bridgeCall';

export interface AuthLoginPayload {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  expiresAt: number;
  /** Web-side timestamp (ms) tagged on every notifyLogin. Lets the
   *  client correlate logout payloads to their corresponding login
   *  epoch when both arrive in quick succession. Added by 영맨 commit
   *  7917f43. Older WebView builds may omit this field. */
  authEpoch?: number;
}

export interface AppInfo {
  platform: 'android' | 'ios';
  appVersion: string;
  bundleId: string;
  systemVersion: string;
}

export interface BridgeContext {
  injectScript: (js: string) => void;
  onAuthLogin: (auth: AuthLoginPayload) => void;
  onAuthLogout: () => void;
  onOpenOnboarding: () => void;
}

interface RawBridgeMessage {
  type: string;
  payload?: unknown;
}

function toAuthPayload(raw: unknown): AuthLoginPayload | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const p = raw as Partial<AuthLoginPayload>;
  if (!p.userId) {
    return null;
  }
  return {
    accessToken: String(p.accessToken ?? ''),
    refreshToken: String(p.refreshToken ?? ''),
    userId: String(p.userId),
    email: String(p.email ?? ''),
    expiresAt: Number(p.expiresAt ?? 0),
    authEpoch: p.authEpoch != null ? Number(p.authEpoch) : undefined,
  };
}

export function buildAppInfo(): AppInfo {
  return {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    appVersion: APP_VERSION,
    bundleId: 'com.youngmanapp',
    systemVersion: String(Platform.Version),
  };
}

// Dedup key for auth.login bursts. WebView's bridge re-emits auth.login
// many times in quick succession (Supabase onAuthStateChange fires
// INITIAL_SESSION + SIGNED_IN + TOKEN_REFRESHED + USER_UPDATED, each
// triggers a postMessage). Without this guard, RN runs setSession +
// syncLedgerGroupsToNative + registerFcmTokenWithServer 50× per second,
// saturating the JS thread and starving native triggers like the
// post-call modal. Reset on logout so a new login is always processed.
let lastProcessedAccessToken: string | null = null;

// Timestamp of the most recent processed auth.login. Used by the
// auth.logout race guard below.
let lastLoginAt = 0;

/** auth.logout race window (ms). When the WebView spits SIGNED_OUT
 *  within this many ms after a SIGNED_IN / TOKEN_REFRESHED, treat it as
 *  a Supabase JS state-machine bug rather than a real user logout.
 *
 *  사장님 ErrorLog 2026-05-20 05:51 케이스:
 *    Auth.login → 240-280ms 후 Auth.logout → 또 Auth.login → 또 Auth.logout
 *  무한 반복. 사장님이 logout 누른 적 없는데 WebView 측에서 자동 emit.
 *
 *  영맨 웹팀이 진단 + commit 7917f43 (logout.html ?explicit=1 가드 +
 *  bridge.js notifyLogout 자체 cooldown 30s)으로 root fix 적용 — 정상
 *  사용자 logout은 ?explicit=1 으로만 도달하므로 우리도 cooldown 30s로
 *  맞추면 정책 일치. 사용자가 의도적으로 30초 안에 로그아웃 + 재로그인
 *  하는 케이스는 사실상 없으므로 안전. */
const AUTH_LOGOUT_RACE_WINDOW_MS = 30_000;

export async function handleBridgeMessage(
  raw: string,
  ctx: BridgeContext,
): Promise<void> {
  let msg: RawBridgeMessage | null = null;
  try {
    msg = JSON.parse(raw) as RawBridgeMessage;
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') {
    return;
  }

  switch (msg.type) {
    case 'auth.login': {
      const auth = toAuthPayload(msg.payload);
      if (auth) {
        if (auth.accessToken === lastProcessedAccessToken) {
          // Same token, just a spam re-emit — skip everything.
          return;
        }
        lastProcessedAccessToken = auth.accessToken;
        lastLoginAt = Date.now();
        // 영맨 사이트 bridge.js 가 fresh 로그인 직후 첫 auth.login 에
        // refresh_token 누락한 채로 push 하는 케이스 추적용 breadcrumb. 두
        // 번째 auth.login 가 채워서 다시 오면 authReady 게이트가 정상 진입.
        // 누락이 잦으면 웹팀에 spec 보완 요청 근거 자료.
        if (!auth.refreshToken) {
          logError(
            'Auth.login',
            new Error('refreshToken missing in payload — waiting for next emit'),
          );
        }
        setSession(auth);
        // 사장님 정책 (2026-05-22 "찰거머리"): 로그인 성공 = "명시적 로그아웃"
        // 상태 해제. 다음 토큰 만료 시 silent re-auth 자동 발동 허용.
        void clearExplicitlyLoggedOut();
        ctx.onAuthLogin(auth);
        // Fire-and-forget: populate the native ledger-groups cache so the
        // post-call glass overlay can render the chip selector immediately.
        void syncLedgerGroupsToNative();
        // Register the FCM token with the backend so server-driven push
        // (async processing, M2/M3) can target this device.
        void registerFcmTokenWithServer();
      }
      return;
    }
    case 'auth.logout': {
      // Race guard: if a fresh auth.login just landed, ignore this logout.
      // WebView occasionally emits SIGNED_OUT right after SIGNED_IN /
      // TOKEN_REFRESHED in a race that's not a real user-initiated logout
      // (사장님 ErrorLog 2026-05-20 05:51 — login → 240ms → logout 무한 반복).
      const sinceLogin = Date.now() - lastLoginAt;
      if (lastLoginAt > 0 && sinceLogin < AUTH_LOGOUT_RACE_WINDOW_MS) {
        if (__DEV__) {
          console.log(
            '[Auth] ignoring logout — race with recent login',
            sinceLogin,
            'ms ago',
          );
        }
        return;
      }
      lastProcessedAccessToken = null;
      lastLoginAt = 0;
      // Clear any lingering refresh-mutex state — otherwise a half-finished
      // refresh from the previous session could block the next login's
      // first refresh attempt.
      resetRefreshMutex();
      // 사장님 정책 (2026-05-22 "찰거머리"): 사용자가 의도적으로 로그아웃했다.
      // silent re-auth 가 다음 토큰 만료 시 자동으로 재로그인시키면 사장님 의도
      // 위배. 명시적 로그아웃 플래그를 켜서 silent 자동 시도 차단.
      void setExplicitlyLoggedOut();
      // Unregister BEFORE clearing the session — apiPost needs the JWT.
      void unregisterFcmTokenWithServer().finally(() => {
        clearSession();
        ctx.onAuthLogout();
        void runGoogleSignOut();
        void clearLedgerGroupsCache();
      });
      return;
    }
    case 'auth.googleSignIn.request': {
      const nonce = (msg.payload as { nonce?: string } | undefined)?.nonce;
      if (__DEV__) {
        console.log(
          '[GoogleSignIn] payload.nonce',
          nonce ? `present (len=${nonce.length})` : 'MISSING',
        );
      }
      const result = await runGoogleSignIn(nonce);
      ctx.injectScript(
        dispatchWebBridge('onGoogleSignInResult', result),
      );
      if (__DEV__) {
        if ('idToken' in result) {
          console.log('[GoogleSignIn] success (idToken length)', result.idToken.length);
        } else {
          console.log(
            '[GoogleSignIn] failure',
            result.cancelled ? 'cancelled' : result.error,
          );
        }
      }
      return;
    }
    case 'nav.openExternal': {
      const url = (msg.payload as { url?: string } | undefined)?.url;
      if (url) {
        Linking.openURL(url).catch(() => {});
      }
      return;
    }
    case 'bridge.ready': {
      // Web bridge.js handshake — bridge is loaded and ready to receive calls.
      ctx.injectScript(callWebBridge('onReady'));
      ctx.injectScript(callWebBridge('onAppInfo', buildAppInfo()));
      if (__DEV__) {
        console.log('[Bridge] ready', msg.payload);
      }
      return;
    }
    case 'bridge.heartbeat': {
      // 2026-05-20 신규 — WebView 가 살아있다는 주기적 신호. 영맨 사이트의
      // bridge.js 가 30초마다 + 상태 변경 시 발송 (WEB_TEAM_REQUEST_2026-05-20.md
      // §1.5). 미수신 = WebView 사망 가정 → api/client.ts 가 native fallback
      // 우선. 구버전 사이트엔 이 메시지가 없으므로 미수신이 곧 native fallback
      // 으로 가는 자연스러운 fallback 경로.
      const raw = (msg.payload ?? {}) as Partial<BridgeHeartbeatPayload>;
      noteBridgeHeartbeat({
        bridgeReady: !!raw.bridgeReady,
        hasSession: !!raw.hasSession,
        expiresAt:
          typeof raw.expiresAt === 'number' && raw.expiresAt > 0
            ? raw.expiresAt
            : null,
        refreshInflight: !!raw.refreshInflight,
        timestamp:
          typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
      });
      return;
    }
    case 'app.fcm.request': {
      const token = await getFcmToken();
      ctx.injectScript(callWebBridge('onFcmToken', token));
      return;
    }
    case 'app.info.request': {
      ctx.injectScript(callWebBridge('onAppInfo', buildAppInfo()));
      return;
    }
    case 'debug.ping': {
      if (__DEV__) {
        console.log('[Bridge] debug.ping', msg.payload);
      }
      return;
    }
    case 'demo.openOnboarding': {
      ctx.onOpenOnboarding();
      return;
    }
    case 'debug.simulateCallEnd': {
      await simulateCallEnd();
      if (__DEV__) {
        console.log('[Bridge] simulateCallEnd dispatched');
      }
      return;
    }
    case 'debug.dumpErrorLog': {
      const log = await readErrorLog();
      if (__DEV__) {
        console.log('--- ErrorLog (start) ---');
        // Split into 3KB chunks so each log line fits in one logcat entry
        const chunkSize = 3000;
        for (let i = 0; i < log.length; i += chunkSize) {
          console.log(log.slice(i, i + chunkSize));
        }
        console.log('--- ErrorLog (end, bytes=' + log.length + ') ---');
      }
      ctx.injectScript(
        dispatchWebBridge('onDebugErrorLog', {
          bytes: log.length,
          content: log,
        }),
      );
      return;
    }
    case 'debug.clearErrorLog': {
      await clearErrorLog();
      if (__DEV__) {
        console.log('[Bridge] errorLog cleared');
      }
      return;
    }
    case 'debug.deleteCustomerLog': {
      const id = (msg.payload as { id?: string } | undefined)?.id;
      if (!id) {
        if (__DEV__) console.log('[Bridge] deleteCustomerLog: missing id');
        return;
      }
      try {
        await deleteCustomerLog(id);
        if (__DEV__) console.log('[Bridge] deleted customer_log', id);
        ctx.injectScript(
          dispatchWebBridge('onDebugDeleteResult', { status: 'ok', id }),
        );
      } catch (e) {
        const code = e instanceof ApiError ? e.code : 'unknown';
        const message =
          e instanceof ApiError ? e.message : String(e);
        if (__DEV__) console.log('[Bridge] delete failed', code, message);
        ctx.injectScript(
          dispatchWebBridge('onDebugDeleteResult', {
            status: 'error',
            id,
            code,
            message,
          }),
        );
      }
      return;
    }
    case 'debug.scan': {
      const opts = (msg.payload as { limit?: number; maxAgeDays?: number } | undefined) ?? {};
      const result = await scanForCallRecordings(opts);
      if (__DEV__) {
        console.log(
          '[Scan]',
          'status=', result.status,
          'returned=', result.recordings.length,
          'totalFound=', result.totalFound,
          result.error ? `err=${result.error}` : '',
        );
        result.recordings.forEach(r => {
          console.log(
            '[Scan]',
            r.classification.source,
            r.classification.confidence,
            r.displayName,
            `path="${r.relativePath}"`,
            `${Math.round(r.duration / 1000)}s`,
          );
        });
      }
      ctx.injectScript(
        dispatchWebBridge('onDebugScanResult', {
          status: result.status,
          count: result.recordings.length,
          totalFound: result.totalFound,
          error: result.error ?? null,
          sample: result.recordings.map(r => ({
            displayName: r.displayName,
            relativePath: r.relativePath,
            durationSec: Math.round(r.duration / 1000),
            source: r.classification.source,
            confidence: r.classification.confidence,
          })),
        }),
      );
      return;
    }
    case 'log': {
      if (__DEV__) {
        const m = (msg.payload as { msg?: string } | undefined)?.msg;
        console.log('[Web]', m);
      }
      return;
    }
    default: {
      if (__DEV__) {
        console.log('[Bridge] unknown type', msg.type, msg.payload);
      }
      return;
    }
  }
}
