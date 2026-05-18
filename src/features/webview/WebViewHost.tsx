import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, DeviceEventEmitter, Platform, StyleSheet, View } from 'react-native';
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
import { SESSION_REFRESH_REQUEST_EVENT } from '../../services/api/client';
import { isLoggedIn } from '../../services/auth/session';
import { refreshProfile as refreshBillingProfile } from '../../services/billing/billingStore';
import { TermsAgreementModal } from '../billing/components/TermsAgreementModal';
import { TrialIntroModal } from '../billing/components/TrialIntroModal';
import { UsageBanner } from '../billing/components/UsageBanner';
import { BackgroundPermissionBanner } from '../callRecording/components/BackgroundPermissionBanner';
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
  const webViewRef = useRef<WebView | null>(null);
  const authRef = useRef<AuthLoginPayload | null>(null);
  // Bumped each time the web side pushes a fresh auth.login. The session-
  // refresh handler captures the value at request time and skips the
  // fallback reload if it sees a different value at the timer mark — i.e.
  // the inline refresh path already delivered.
  const sessionUpdateCounterRef = useRef<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [canGoBack, setCanGoBack] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [webViewReady, setWebViewReady] = useState<boolean>(false);
  const online = useNetworkStatus();

  const onNativeRoute = useCallback(
    (route: NativeRoute): boolean => {
      if (route.pathname === 'confirm') {
        // Clear any stale modal stack first — if the user opened a previous
        // call's SummaryReview but never sent it, leaving that screen alive
        // would let it shadow the new call's flow on failure / back press.
        navigation.popToTop();
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

  // Returning to foreground does three things:
  //  1) Refresh the native ledger-groups cache (chips up-to-date).
  //  2) Trigger a catch-up scan — if Android put us to sleep and a recent call
  //     ended without PHONE_STATE reaching us, the post-call service runs now
  //     and surfaces the missed recording. Core promise: no call left behind.
  //  3) Re-evaluate the daily reminder for un-sent customer logs.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' && isLoggedIn()) {
        void syncLedgerGroupsToNative();
        void triggerCatchUpScan();
        setReminderTick(t => t + 1);
      }
    });
    return () => sub.remove();
  }, []);

  // === SESSION REFRESH (MAX STRENGTH) ===========================
  //
  // The WebView's Supabase JS SDK is the auth source of truth — it auto-
  // refreshes access_token periodically and persists to localStorage under
  // "sb-<project>-auth-token". RN's in-memory cache rots when the app sits
  // idle for hours then gets revived by a native trigger (PostCallScan /
  // CallScreening / overlay tap), so we must aggressively re-sync.
  //
  // Strategy: when refresh is requested, fire EVERY recovery path in
  // parallel and accept whichever delivers first:
  //   1) Inject JS that reads Supabase session from localStorage and
  //      re-posts auth.login. Almost instant (<50ms) if WebView is loaded.
  //   2) Inject JS that calls Supabase refreshSession() to force a new
  //      access_token (in case localStorage is also stale).
  //   3) Hard reload WebView so bridge.js handshake re-publishes auth.login
  //      from scratch. Slower (~2-3s) but always works.
  //
  // Caller (api/client.ts) waits up to 20 seconds — the longest path is
  // the reload which usually finishes in ~3s.
  const injectSessionRefresh = useCallback(() => {
    const ref = webViewRef.current;
    if (!ref) return;
    // (1) + (2): try localStorage AND Supabase refresh in the same script.
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
          // Path A: localStorage read (fast — works if Supabase JS is alive)
          var keys = Object.keys(localStorage || {});
          var localHit = null;
          for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k.indexOf('sb-') !== 0 || k.indexOf('-auth-token') < 0) continue;
            var raw = localStorage.getItem(k);
            if (!raw) continue;
            try { localHit = JSON.parse(raw); } catch (e) {}
            if (localHit && localHit.access_token) {
              post(localHit);
              break;
            }
          }
          // Path B: force-refresh via Supabase JS if reachable globally
          var sb = window.supabase || window.supabaseClient || window._supabase
                 || (window.YoungmanBridge && window.YoungmanBridge.supabase);
          if (sb && sb.auth && typeof sb.auth.refreshSession === 'function') {
            sb.auth.refreshSession().then(function(r) {
              var s = r && r.data && r.data.session;
              if (s) post(s);
            }).catch(function() {});
          }
          // Path C: ask web-team bridge hook if it exists
          if (window.YoungmanBridge && typeof window.YoungmanBridge.refreshSession === 'function') {
            try { window.YoungmanBridge.refreshSession(); } catch (e) {}
          }
        } catch (e) {
          // swallow — caller has reload fallback
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
        return; // a fresh auth.login already arrived — skip reload
      }
      if (__DEV__) {
        console.log('[Session] hard fallback — reloading WebView');
      }
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
    if (__DEV__) {
      console.log('[Auth] login', auth.userId, auth.email);
    }
  }, []);

  const onAuthLogout = useCallback(() => {
    authRef.current = null;
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
      <BackgroundPermissionBanner />
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
      <TermsAgreementModal />
      <TrialIntroModal />
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
