import { Linking, Platform } from 'react-native';

import { APP_VERSION } from '../../../config/env';
import {
  clearSession,
  setSession,
} from '../../../services/auth/session';
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
        setSession(auth);
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
