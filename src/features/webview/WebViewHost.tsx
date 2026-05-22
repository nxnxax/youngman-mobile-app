import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, DeviceEventEmitter, Platform, StyleSheet, ToastAndroid, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type {
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewMessageEvent,
  WebViewNavigation,
} from 'react-native-webview/lib/WebViewTypes';

import type { RootStackParamList } from '../../navigation/types';

import { CUSTOMERS_PATH, USER_AGENT_SUFFIX, WEB_BASE_URL } from '../../config/env';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { SESSION_REFRESH_REQUEST_EVENT } from '../../services/api/client';
import {
  attemptSilentReauth,
  SESSION_SYNC_TO_WEBVIEW_EVENT,
} from '../../services/auth/silentReauth';
import { consumeLongIdle } from '../../services/auth/sessionHealth';
import {
  AUTO_SUBMIT_AUTH_FAIL_FLAG,
  AUTO_SUBMIT_PENDING_FLAG,
  PENDING_JOB_KEY,
  type PendingJobPayload,
} from '../callRecording/headless/autoSubmitTask';
import { setActiveJob, getActiveJob } from '../processing/jobStore';
import { logError } from '../../services/logger/errorLog';
import {
  isLoggedIn,
  SESSION_AUTH_READY_EVENT,
} from '../../services/auth/session';
import { processOutbox } from '../../services/outbox/outboxProcessor';
import { cleanupTerminalItems } from '../../services/outbox/outboxStore';
import { refreshProfile as refreshBillingProfile } from '../../services/billing/billingStore';
import { fetchUnreviewedCount } from '../callRecording/api/unreviewed';
// TermsAgreementModal — intentionally NOT imported. Korean signup flow on
// the web (subscribe.html / signup form) already requires 이용약관 +
// 개인정보 consent at registration. Asking again in-app is redundant and
// scares off free-tier users. Policy pages remain accessible any time via
// Settings → 약관 / 정책. The component file is kept for archive in case
// web team's signup ever needs to drop the checkboxes.
import { PlanGateModal } from '../billing/components/PlanGateModal';
import { TrialIntroModal } from '../billing/components/TrialIntroModal';
// FloatingProcessingCard / useJobPolling — 사장님 정책 (2026-05-21):
// 헤더 가리는 "audio_pending · 백그라운드 OK" 카드 기능 자체 제거.
// 사용자가 미확인 요약 화면에서 처리하니까 floating 표시 불필요.
import { UsageBanner } from '../billing/components/UsageBanner';
import { PermissionBanner } from '../onboarding/PermissionBanner';
import { PendingReminderModal } from '../callRecording/components/PendingReminderModal';
import { triggerCatchUpScan } from '../callRecording/scanner/recordingScanner';
import { syncLedgerGroupsToNative } from '../callRecording/services/ledgerGroupsSync';
import { buildInjectedScript } from './bridge/injectedScript';
import type { AuthLoginPayload } from './bridge/messageHandler';
import { handleBridgeMessage } from './bridge/messageHandler';
import { ErrorView } from './components/ErrorView';
import { LoadingOverlay } from './components/LoadingOverlay';
import { OfflineView } from './components/OfflineView';
import { shouldStartLoad } from './handlers/linkRouter';
import type { NativeRoute } from './hooks/useDeepLink';
import { useDeepLink } from './hooks/useDeepLink';
import { useHardwareBack } from './hooks/useHardwareBack';
import { useNetworkStatus } from './hooks/useNetworkStatus';

export const WebViewHost: React.FC = () => {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // useJobPolling 제거됨 (2026-05-21): FloatingProcessingCard 와 함께 삭제.
  const webViewRef = useRef<WebView | null>(null);
  const authRef = useRef<AuthLoginPayload | null>(null);
  // Bumped each time the web side pushes a fresh auth.login. The session-
  // refresh handler captures the value at request time and skips the
  // fallback reload if it sees a different value at the timer mark — i.e.
  // the inline refresh path already delivered.
  const sessionUpdateCounterRef = useRef<number>(0);
  // Last time we hard-reloaded the WebView as a 401-recovery fallback.
  // Used to throttle reloads — without this, a logged-out state where every
  // background API call returns 401 triggers a reload, which fires more
  // background calls on load, which all 401 again, → infinite reload loop
  // (user sees the main screen flicker forever). 30s cooldown is long
  // enough to break the loop but short enough to recover from a genuine
  // single-shot stale token.
  const lastReloadAtRef = useRef<number>(0);
  // How many times in a row the session-refresh handler tried to recover
  // without ever receiving a fresh auth.login back. Used to throttle
  // recovery attempts so we don't spin on a genuinely dead session.
  const refreshFailureStreakRef = useRef<number>(0);
  // Recent-success guard. auth.login arriving within the last 60s proves
  // the session is alive — late background 401 timeouts should not trigger
  // another recovery cycle.
  const lastAuthLoginAtRef = useRef<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [canGoBack, setCanGoBack] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [webViewReady, setWebViewReady] = useState<boolean>(false);
  const online = useNetworkStatus();

  // Policy 2 (2026-05-20): 네트워크 복구 시 outbox drain. offline 동안 보존된
  // failed_retryable 작업이 즉시 재시도됨.
  const prevOnlineRef = useRef<boolean>(true);
  useEffect(() => {
    if (online && !prevOnlineRef.current && isLoggedIn()) {
      void processOutbox('network.online');
    }
    prevOnlineRef.current = online;
  }, [online]);

  // Play 안정화 (2026-05-21 audit): outbox 무한 누적 방지. saved /
  // failed_permanent / dismissed 의 7일 이상 옛 항목 자동 삭제. WebView mount
  // 시 1회 fire-and-forget — cold start 영향 0.
  useEffect(() => {
    void cleanupTerminalItems();
  }, []);

  // Policy (2026-05-20 사장님): 세션이 isAuthReady 만족하는 즉시 — auth.login,
  // native refresh, restoreSession 어떤 경로든 — outbox 자동 재개. onAuthLogin
  // 콜백 (WebView postMessage 경로) 외의 모든 setSession 경로 cover. 최초
  // 사용자 첫 통화가 토큰 준비 타이밍 때문에 잃지 않음.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(SESSION_AUTH_READY_EVENT, () => {
      void processOutbox('session.authReady');
    });
    return () => sub.remove();
  }, []);

  const onNativeRoute = useCallback(
    (route: NativeRoute): boolean => {
      if (route.pathname === 'confirm') {
        navigation.popToTop();
        // v31 복원: native CallPostActivity 가 processRecording 호출 + customer_log
        // 받은 경우 query param 으로 전달. ConfirmRecording skip → SummaryReview 직접.
        const customerLogJsonRaw = route.params.customer_log_json;
        if (customerLogJsonRaw) {
          try {
            const parsed = JSON.parse(customerLogJsonRaw);
            const customerLog = parsed.customer_log ?? parsed;
            navigation.navigate('SummaryReview', {
              customerLog,
              groupId: null,
            });
            return true;
          } catch {
            // JSON 파싱 실패 시 기존 흐름으로 fallback.
          }
        }
        navigation.navigate('ConfirmRecording', {
          uri: route.params.uri ?? '',
          name: route.params.name ?? '',
          duration: Number(route.params.duration ?? '0'),
          dateAdded: Number(route.params.dateAdded ?? '0'),
          mimeType: route.params.mimeType ?? 'audio/mp4',
        });
        return true;
      }
      if (route.pathname === 'customer-ledger') {
        // Make sure the WebView is the top screen (close any modal stack —
        // SuccessOverlay's dismiss event already pops SummaryReview, but a
        // direct deep-link entry from a foreign app would still need this),
        // then tell the WebView to navigate to the customer ledger page.
        navigation.popToTop();
        const target = `${WEB_BASE_URL}${CUSTOMERS_PATH}`;
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(target)}; true;`,
        );
        return true;
      }
      if (route.pathname === 'settings') {
        navigation.navigate('Settings');
        return true;
      }
      if (route.pathname === 'tester') {
        // 사장님 정책 (2026-05-21): Play Store 출시 전 테스트 기간. 결제 권유
        // 자리에서 이 화면으로 이동. config/env.ts 의 TESTER_MODE 가 false 면
        // 결제 UI 복원, 이 deep link 는 dead path 가 됨 — 안전.
        navigation.navigate('Tester');
        return true;
      }
      if (route.pathname === 'unreviewed') {
        // 영맨 사이트 하단 nav "미확인 요약" 탭 → youngman://nav?pathname=unreviewed
        // 호출 시 native 화면으로 전환 (사장님 정책 2026-05-21).
        // 사용자가 영맨 사이트의 unreviewed.html 페이지 대신 PlanGateModal 톤
        // 의 native UI 를 보게 됨.
        navigation.navigate('UnreviewedSummaries');
        return true;
      }
      if (route.pathname === 'billing') {
        // Settings → "내 플랜 관리" path. cafe24 webroot is flat — `.html`
        // extension is mandatory (no extensionless rewrite).
        navigation.popToTop();
        const target = `${WEB_BASE_URL}/billing.html`;
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(target)}; true;`,
        );
        return true;
      }
      if (route.pathname === 'subscribe') {
        // Plan comparison + checkout entry — currently used by the
        // "체험 X회 남음" upgrade prompt and the upgrade CTAs in the gating
        // modals.
        navigation.popToTop();
        const target = `${WEB_BASE_URL}/subscribe.html`;
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(target)}; true;`,
        );
        return true;
      }
      if (route.pathname === 'policy') {
        // Generic policy-page jumper. ?page=terms|privacy|refund|auto-billing
        const page = route.params.page;
        const allowed = ['terms', 'privacy', 'refund', 'auto-billing'];
        if (!allowed.includes(page)) return false;
        navigation.popToTop();
        const target = `${WEB_BASE_URL}/${page}.html`;
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(target)}; true;`,
        );
        return true;
      }
      return false;
    },
    [navigation],
  );

  useHardwareBack(webViewRef, canGoBack);
  useDeepLink(webViewRef, webViewReady, onNativeRoute);

  // Bumped on every foreground entry so the daily pending-logs reminder can
  // re-evaluate. The reminder itself is 24h-throttled in storage so a bump
  // doesn't actually open the modal more than once a day.
  const [reminderTick, setReminderTick] = useState(0);

  // Returning to foreground does these things:
  //  1) Refresh the native ledger-groups cache (chips up-to-date).
  //  2) Trigger a catch-up scan — if Android put us to sleep and a recent call
  //     ended without PHONE_STATE reaching us, the post-call service runs now
  //     and surfaces the missed recording. Core promise: no call left behind.
  //  3) Re-evaluate the daily reminder for un-sent customer logs.
  //  4) Health-check the Supabase session — if we've been backgrounded long
  //     enough that the access_token may have rotted (the 2026-05-19 incident
  //     was exactly this: 14h sleep → token died → 401 storm). Force a
  //     pre-emptive refresh so the first API call after wake-up doesn't 401.
  const lastBackgroundedAtRef = useRef<number>(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background') {
        lastBackgroundedAtRef.current = Date.now();
        return;
      }
      if (state !== 'active') return;
      if (!isLoggedIn()) return;
      void syncLedgerGroupsToNative();
      // 사장님 정책 (2026-05-21): catchUp scan 비활성. 새 흐름은 audio_pending
      // 자동 저장 → 미확인 요약에서 처리. catchUp 으로 이전 통화녹음 다시
      // 매칭 → 모달 재표시 = 사장님이 짜증나는 "과거 모달 갑자기 뜸" 의 원인.
      // void triggerCatchUpScan();
      // Policy 2: foreground 재진입 = outbox 의 pending 작업 자동 재시도.
      // 백그라운드에서 발생했던 통화녹음이 401 / 네트워크 실패로 보존됐다면
      // 이 시점에 자동 drain.
      void processOutbox('appstate.active');
      setReminderTick(t => t + 1);

      const backgroundedFor = lastBackgroundedAtRef.current
        ? Date.now() - lastBackgroundedAtRef.current
        : 0;
      const STALE_AFTER_MS = 30 * 60 * 1000; // 30 min

      // 사장님 정책 (2026-05-22 "찰거머리" 슬로건): long-idle (기본 6h+) 후엔
      // WebView 의 refresh 도 dead 일 가능성 큼 (사장님 7h 비상 사례 = 양쪽
      // refresh_token 휘발). 그 케이스는 refresh 시도 자체를 건너뛰고 즉시
      // silent re-auth (native Google idToken → Supabase id_token grant) 로
      // 분기. 성공하면 SESSION_SYNC_TO_WEBVIEW_EVENT 가 WebView 에 새 session
      // 을 inject → 무감지 복구.
      if (consumeLongIdle() && authRef.current) {
        logError(
          'Session.healthCheck',
          new Error(
            `long-idle (${Math.round(backgroundedFor / 60_000)}min) — silent re-auth`,
          ),
        );
        void (async () => {
          const result = await attemptSilentReauth();
          if (!result.ok) {
            // silent 실패 (Google account 없음 / 명시적 로그아웃 등). WebView
            // 강제 reload → cafe24 측이 자체 인증 흐름 (필요 시 Google OAuth
            // 한 탭) 진행.
            logError(
              'Session.healthCheck',
              new Error(`silent re-auth fail (${result.reason}) — WebView reload`),
            );
            webViewRef.current?.reload();
          }
        })();
      } else if (backgroundedFor > STALE_AFTER_MS && authRef.current) {
        if (__DEV__) {
          console.log(
            '[Session] health check — backgrounded',
            Math.round(backgroundedFor / 60_000),
            'min, refreshing',
          );
        }
        logError(
          'Session.healthCheck',
          new Error(`backgrounded ${Math.round(backgroundedFor / 60_000)}min — refresh`),
        );
        injectSessionRefresh();
      }
    });
    return () => sub.remove();
    // injectSessionRefresh is defined below — stable callback, ref-based.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === SESSION REFRESH (MAX STRENGTH) ===========================
  //
  // The WebView's Supabase JS SDK is the auth source of truth — it auto-
  // refreshes access_token periodically and persists to localStorage under
  // "sb-<project>-auth-token". RN's in-memory cache rots when the app sits
  // idle for hours then gets revived by a native trigger (PostCallScan /
  // CallScreening / overlay tap), so we must re-sync.
  //
  // Path A 1번 — single source of truth (웹팀 의뢰, 2026-05-20):
  //   WebView's Supabase JS is the ONLY refresh actor. RN must not call
  //   supabase.auth.refreshSession() directly — that creates two refresh
  //   token consumers, one of which gets invalidated the moment the other
  //   wins the race (사장님의 "첫 refresh 8.7초 후 즉시 logout" 케이스).
  //
  //   영맨 웹측이 노출한 hook (commit 15f0959):
  //     window.YoungmanBridge.refreshSession()
  //     · Promise 반환, _refreshInflight + 25초 cooldown 자동 적용
  //     · 동시 N건 호출 → 1건으로 합쳐짐, 25초 내 재호출 → 캐시 즉시 반환
  //     · TOKEN_REFRESHED 이벤트 → _bridgeLogin() → auth.login 메시지로 RN에 전달
  //
  // Strategy:
  //   1) localStorage 빠른 path (Supabase JS가 이미 복원해둔 세션이 있으면 즉시 사용)
  //   2) YoungmanBridge.refreshSession() 호출 (단일 refresh 주체)
  //   3) Hard reload 폴백 (둘 다 실패 시. authRef null이면 skip)
  const injectSessionRefresh = useCallback(() => {
    const ref = webViewRef.current;
    if (!ref) return;
    ref.injectJavaScript(`
      (function() {
        var post = function(s) {
          if (!s || !s.access_token) return false;
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'auth.login',
            payload: {
              accessToken: s.access_token,
              refreshToken: s.refresh_token,
              userId: s.user && s.user.id,
              email: s.user && s.user.email,
              expiresAt: s.expires_at,
            }
          }));
          return true;
        };
        try {
          // (1) Fast path: localStorage read. If Supabase JS already
          // restored a fresh session (e.g. WebView just reloaded), use
          // it immediately — no need to wait on refresh round-trip.
          var keys = Object.keys(localStorage || {});
          for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k.indexOf('sb-') !== 0 || k.indexOf('-auth-token') < 0) continue;
            var raw = localStorage.getItem(k);
            if (!raw) continue;
            var s;
            try { s = JSON.parse(raw); } catch (e) { continue; }
            if (s && s.access_token) {
              post(s);
              break;
            }
          }
          // (2) Single source of truth: ask the bridge hook to refresh.
          // 영맨 웹측 _refreshInflight + 25초 cooldown으로 단일 호출 보장.
          // Result flows back via TOKEN_REFRESHED → _bridgeLogin() →
          // 'auth.login' postMessage. We do NOT call supabase.auth.refreshSession()
          // directly here — that's exactly the dual-consumer race that
          // Path A 1번 fixes.
          if (window.YoungmanBridge && typeof window.YoungmanBridge.refreshSession === 'function') {
            try { window.YoungmanBridge.refreshSession(); } catch (e) {}
          }
        } catch (e) {
          // swallow — reload fallback below handles total failure
        }
      })();
      true;
    `);
    // (3): hard reload — fires unconditionally so a stale page (Supabase JS
    // dead, localStorage empty) still recovers. Reloading is idempotent and
    // bridge.js republishes auth.login on every load, so even when paths
    // (1)/(2) succeed, the redundant reload at most refreshes the WebView
    // page once. We minimize the user's perception by deferring 1s — if
    // localStorage read works, the API retry kicks off well before reload
    // completes anyway.
    const counterAtRequest = sessionUpdateCounterRef.current;
    setTimeout(() => {
      if (sessionUpdateCounterRef.current !== counterAtRequest) {
        // a fresh auth.login already arrived — recovery worked.
        refreshFailureStreakRef.current = 0;
        return;
      }
      // Logged-out short-circuit: if the user explicitly logged out (or
      // never logged in this session), reloading the WebView just bounces
      // them to the login page that's already showing. Skip the reload
      // entirely. The WebView already shows the login screen — the user
      // sees what they need without a separate alert.
      if (authRef.current == null) {
        if (__DEV__) {
          console.log('[Session] logged out — skipping reload');
        }
        return;
      }
      // Reload cooldown — see lastReloadAtRef comment for why this exists.
      const sinceLast = Date.now() - lastReloadAtRef.current;
      const RELOAD_COOLDOWN_MS = 30_000;
      if (sinceLast < RELOAD_COOLDOWN_MS) {
        if (__DEV__) {
          console.log(
            '[Session] reload cooldown active — skipping (last reload',
            Math.round(sinceLast / 1000),
            's ago)',
          );
        }
        return;
      }
      // Recent-success guard. If we received a fresh auth.login within the
      // last 60s, the session is demonstrably alive; this timeout is most
      // likely a stale parallel 401 burst. Don't escalate.
      const sinceLastLogin = Date.now() - lastAuthLoginAtRef.current;
      if (lastAuthLoginAtRef.current > 0 && sinceLastLogin < 60_000) {
        if (__DEV__) {
          console.log(
            '[Session] recent auth.login (',
            Math.round(sinceLastLogin / 1000),
            's ago) — ignoring stale refresh timeout',
          );
        }
        return;
      }
      // Track failure streak. After several consecutive attempts that never
      // produced a fresh auth.login, fall back to a silent WebView reload —
      // the underlying login page will be presented by the web layer.
      refreshFailureStreakRef.current += 1;
      if (__DEV__) {
        console.log('[Session] hard fallback — reloading WebView');
      }
      lastReloadAtRef.current = Date.now();
      webViewRef.current?.reload();
    }, 1_000);
  }, []);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      SESSION_REFRESH_REQUEST_EVENT,
      () => {
        if (__DEV__) {
          console.log('[Session] refresh requested — firing all paths');
        }
        injectSessionRefresh();
      },
    );
    return () => sub.remove();
  }, [injectSessionRefresh]);

  // Native fallback refresh has succeeded — push the new tokens into the
  // WebView so its Supabase JS doesn't run a redundant refresh and stays
  // consistent with the in-memory RN session. Best-effort: older site
  // builds without `window.YoungmanBridge.setSession` will silently no-op.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      SESSION_SYNC_TO_WEBVIEW_EVENT,
      (auth: AuthLoginPayload) => {
        const ref = webViewRef.current;
        if (!ref || !auth) return;
        if (__DEV__) {
          console.log('[Session] syncing native-refreshed tokens to WebView');
        }
        // Send tokens as a JSON-encoded literal so any special characters
        // are escaped safely.
        const payloadJson = JSON.stringify({
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken,
          expiresAt: auth.expiresAt,
        });
        ref.injectJavaScript(`
          (function() {
            try {
              var p = ${payloadJson};
              if (window.YoungmanBridge && typeof window.YoungmanBridge.setSession === 'function') {
                window.YoungmanBridge.setSession(p);
              } else if (window.supabase && window.supabase.auth && typeof window.supabase.auth.setSession === 'function') {
                window.supabase.auth.setSession({
                  access_token: p.accessToken,
                  refresh_token: p.refreshToken
                });
              }
            } catch (e) {}
          })();
          true;
        `);
      },
    );
    return () => sub.remove();
  }, []);

  // Show a one-shot "log in again" alert when auto-recovery has given up.
  // The flag prevents the alert from re-triggering every time another
  // background API call hits 401 in quick succession (which is exactly what
  // happens after a logout — see the infinite-reload incident).
  // 사장님 정책 1 (2026-05-20): 사용자에게 401 노출 금지. headless 에서 떨어진
  // hardFail / pending flag 모두 silent 로 회수 — outbox 가 재시도하거나
  // WebView 가 로그인 화면을 자체적으로 노출함. pending 케이스에만 친절한
  // "세션 준비 중" toast (사장님 정책 2026-05-21).
  useEffect(() => {
    void (async () => {
      try {
        const hardFail = await AsyncStorage.getItem(AUTO_SUBMIT_AUTH_FAIL_FLAG);
        if (hardFail) {
          await AsyncStorage.removeItem(AUTO_SUBMIT_AUTH_FAIL_FLAG);
        }
        const pending = await AsyncStorage.getItem(AUTO_SUBMIT_PENDING_FLAG);
        if (pending) {
          await AsyncStorage.removeItem(AUTO_SUBMIT_PENDING_FLAG);
          logError(
            'AutoSubmit',
            new Error('pending_auth flag found on foreground → friendly toast'),
          );
          if (Platform.OS === 'android') {
            ToastAndroid.showWithGravity(
              '세션을 준비 중입니다. 곧 자동으로 이어서 처리됩니다.',
              ToastAndroid.LONG,
              ToastAndroid.CENTER,
            );
          }
        }
      } catch {
        // best-effort
      }
    })();
  }, []);

  // Hand-off from the AutoSubmit headless task to the in-memory jobStore.
  // Headless can't touch jobStore directly, so it persisted the job to
  // AsyncStorage and we pick it up here on mount + every foreground entry.
  // Idempotent — jobStore ignores set calls for an already-active job id.
  useEffect(() => {
    const adoptPending = async () => {
      try {
        const raw = await AsyncStorage.getItem(PENDING_JOB_KEY);
        if (!raw) return;
        const pending = JSON.parse(raw) as PendingJobPayload;
        await AsyncStorage.removeItem(PENDING_JOB_KEY);
        if (getActiveJob()?.jobId === pending.jobId) return;
        setActiveJob(pending.jobId, pending.metadata);
      } catch {
        // ignore — malformed payload just gets dropped
      }
    };
    void adoptPending();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') void adoptPending();
    });
    return () => sub.remove();
  }, []);

  // Whenever the WebView finishes loading, pre-emptively pull the current
  // Supabase session out of localStorage. This keeps RN's cache fresh
  // *before* any 401 ever happens — covers the cold-start case where a
  // native trigger (post-call modal tap) revives a stale AsyncStorage
  // token while the WebView quietly loads in the background.
  useEffect(() => {
    if (!webViewReady) return;
    if (__DEV__) {
      console.log('[Session] WebView ready — pulling localStorage session');
    }
    // Just the read path — don't reload here (we just finished loading).
    webViewRef.current?.injectJavaScript(`
      (function() {
        try {
          var keys = Object.keys(localStorage || {});
          for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k.indexOf('sb-') !== 0 || k.indexOf('-auth-token') < 0) continue;
            var raw = localStorage.getItem(k);
            if (!raw) continue;
            var s;
            try { s = JSON.parse(raw); } catch (e) { continue; }
            if (!s || !s.access_token) continue;
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'auth.login',
              payload: {
                accessToken: s.access_token,
                refreshToken: s.refresh_token,
                userId: s.user && s.user.id,
                email: s.user && s.user.email,
                expiresAt: s.expires_at,
              }
            }));
            return;
          }
        } catch (e) {}
      })();
      true;
    `);
  }, [webViewReady]);

  // 사장님 정책 (2026-05-21): cafe24 페이지의 "미확인 요약" 메뉴 항목에 빨간
  // badge 표시. RN 측에서 list_unreviewed count 폴링 후 WebView 에 inject.
  // 웹팀은 window.YoungmanBridge.setUnreviewedCount(N) 받으면 메뉴 항목에
  // badge UI 렌더 (커밋 협의 필요).
  useEffect(() => {
    if (!webViewReady) return;
    let stopped = false;
    const sync = async () => {
      if (stopped || !isLoggedIn()) return;
      const count = await fetchUnreviewedCount();
      if (stopped) return;
      webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            if (window.YoungmanBridge && typeof window.YoungmanBridge.setUnreviewedCount === 'function') {
              window.YoungmanBridge.setUnreviewedCount(${count});
            }
          } catch (e) {}
        })();
        true;
      `);
    };
    // 즉시 1회 + 30초마다.
    void sync();
    const id = setInterval(() => { void sync(); }, 30_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [webViewReady]);

  const onNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    setCanGoBack(nav.canGoBack);
    if (__DEV__) {
      console.log('[WebView nav]', nav.url);
    }
    // PortOne 결제 성공 → web team's verify-payment.php → redirect to
    // /billing.html?success=1. Detect this and refresh the plan cache so
    // gating modals + usage indicators flip to the new plan immediately,
    // without waiting for the next AppState 'active' tick.
    if (
      nav.url.includes('/billing.html') &&
      /[?&]success=1\b/.test(nav.url)
    ) {
      if (__DEV__) {
        console.log('[Billing] success URL — refreshing plan');
      }
      void refreshBillingProfile();
    }
  }, []);

  const onAuthLogin = useCallback((auth: AuthLoginPayload) => {
    authRef.current = auth;
    sessionUpdateCounterRef.current += 1;
    // Fresh login arrived — reset 401 recovery throttles so a genuine future
    // token expiry can re-trigger the full recovery flow again.
    refreshFailureStreakRef.current = 0;
    lastReloadAtRef.current = 0;
    lastAuthLoginAtRef.current = Date.now();
    // 사장님 정책 (2026-05-20 late): Auth.login 은 정상 이벤트. errors.log 에
    // 기록하면 사용자가 "에러" 로 인지. dev console 만.
    if (__DEV__) {
      console.log('[Auth] login', auth.userId, auth.email);
    }
    // Policy 2 (2026-05-20): 로그인 완료 = outbox 의 pending_auth 작업
    // 모두 자동 재시도. 사장님 슬로건 "단 한 건의 누락도 없이 관리" 보장.
    void processOutbox('auth.login');
  }, []);

  const onAuthLogout = useCallback(() => {
    authRef.current = null;
    // 정상 이벤트 — errors.log 기록 X. dev console 만.
    if (__DEV__) {
      console.log('[Auth] logout');
    }
  }, []);

  const onOpenOnboarding = useCallback(() => {
    navigation.navigate('OnboardingDemo');
  }, [navigation]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      void handleBridgeMessage(event.nativeEvent.data, {
        injectScript: js => webViewRef.current?.injectJavaScript(js),
        onAuthLogin,
        onAuthLogout,
        onOpenOnboarding,
      });
    },
    [onAuthLogin, onAuthLogout, onOpenOnboarding],
  );

  const onLoadStart = useCallback(() => {
    setLoadError(null);
    setLoading(true);
  }, []);

  const onLoadEnd = useCallback(() => {
    setLoading(false);
    setWebViewReady(true);
  }, []);

  const onError = useCallback((event: WebViewErrorEvent) => {
    const desc = event.nativeEvent.description;
    setLoadError(desc && desc.length > 0 ? desc : '알 수 없는 오류');
    setLoading(false);
  }, []);

  const onHttpError = useCallback((event: WebViewHttpErrorEvent) => {
    const code = event.nativeEvent.statusCode;
    if (code >= 500) {
      setLoadError(`서버 오류 (${code})`);
      setLoading(false);
    }
  }, []);

  const reload = useCallback(() => {
    setLoadError(null);
    setLoading(true);
    webViewRef.current?.reload();
  }, []);

  const onContentProcessDidTerminate = useCallback(() => {
    if (__DEV__) {
      console.warn('[WebView] content process terminated — reloading');
    }
    webViewRef.current?.reload();
  }, []);

  const onRenderProcessGone = useCallback(() => {
    if (__DEV__) {
      console.warn('[WebView] render process gone — reloading');
    }
    webViewRef.current?.reload();
  }, []);

  if (!online) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <OfflineView onRetry={reload} />
      </SafeAreaView>
    );
  }

  return (
    // No `bottom` edge — the web shell already renders its own sticky bottom
    // nav (홈 / 고객관리대장 / 신규 양식 / 신규 양식) and pinning that bar to
    // a safe-area inset leaves a tall white gap below it on devices with a
    // system navigation bar. The WebView painting through to the screen edge
    // matches the mobile-browser experience that the web team designs against.
    <SafeAreaView style={styles.container} edges={['top']}>
      <PermissionBanner />
      <UsageBanner />
      <View style={styles.flex}>
        <WebView
          ref={webViewRef}
          source={{ uri: WEB_BASE_URL }}
          originWhitelist={['https://*', 'http://*']}
          // 세션 유지 (쿠키 + localStorage)
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          domStorageEnabled
          cacheEnabled
          javaScriptEnabled
          // UA 마킹 (웹에서 "앱 모드" 식별용)
          applicationNameForUserAgent={USER_AGENT_SUFFIX}
          // 새창/외부링크 처리
          allowsBackForwardNavigationGestures
          // 미디어
          allowsFullscreenVideo
          mediaPlaybackRequiresUserAction={false}
          // 보안: https 페이지에서 http 콘텐츠 차단
          mixedContentMode="never"
          // JS↔Native 브리지 주입 (페이지 로드 직후 1회)
          injectedJavaScriptBeforeContentLoaded={buildInjectedScript()}
          onMessage={onMessage}
          // 외부 URL/스킴 라우팅
          onShouldStartLoadWithRequest={shouldStartLoad}
          // 상태
          onNavigationStateChange={onNavigationStateChange}
          onLoadStart={onLoadStart}
          onLoadEnd={onLoadEnd}
          onError={onError}
          onHttpError={onHttpError}
          onContentProcessDidTerminate={onContentProcessDidTerminate}
          onRenderProcessGone={onRenderProcessGone}
          // Android 렌더링 성능
          androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
          style={styles.webview}
        />
        {loading && !loadError ? <LoadingOverlay /> : null}
        {loadError ? <ErrorView message={loadError} onRetry={reload} /> : null}
      </View>
      <PendingReminderModal triggerKey={reminderTick} />
      <TrialIntroModal />
      <PlanGateModal />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  flex: {
    flex: 1,
  },
  webview: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
});
