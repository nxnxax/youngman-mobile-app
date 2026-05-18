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
        // Settings → "내 플랜 관리" path. Pop any modal screens, then
        // navigate the WebView to /billing. Web team owns the page;
        // until they ship it the user may see a 404 — that's expected
        // during the integration window.
        navigation.popToTop();
        const target = `${WEB_BASE_URL}/billing`;
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

  // API client emits this when a request returns 401 or the cached JWT is
  // about to expire. The WebView is the auth source of truth (Supabase JS
  // SDK lives here and auto-refreshes); we inject a script that either:
  //   1) calls a bridge hook the web team exposes, or
  //   2) calls Supabase JS directly if it's available on `window`, or
  //   3) falls back to reloading the WebView so bridge.js re-posts auth.login
  //      from the freshly-loaded Supabase session.
  // Whichever path runs, the eventual `auth.login` bridge message wakes the
  // waiter in session.ts → the failed API call retries with the new JWT.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      SESSION_REFRESH_REQUEST_EVENT,
      () => {
        if (__DEV__) {
          console.log('[Session] refresh requested — injecting');
        }
        webViewRef.current?.injectJavaScript(`
          (function() {
            try {
              if (window.__bridge && typeof window.__bridge.requestSessionRefresh === 'function') {
                window.__bridge.requestSessionRefresh();
                return;
              }
              var sb = window.supabase || window.supabaseClient || window._supabase;
              if (sb && sb.auth && typeof sb.auth.refreshSession === 'function') {
                sb.auth.refreshSession().then(function(r) {
                  var s = r && r.data && r.data.session;
                  if (!s) return;
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
                });
                return;
              }
            } catch (e) {
              // ignore — final fallback is the reload() below
            }
          })();
          true;
        `);
        // Hard fallback: if neither the bridge hook nor a global Supabase
        // client delivered a fresh auth.login, reload the WebView. Page
        // boot path always re-publishes auth.login as part of the bridge
        // handshake, so reload reliably restores tokens — at the cost of
        // wiping any in-WebView state (form drafts, scroll position).
        const counterAtRequest = sessionUpdateCounterRef.current;
        setTimeout(() => {
          if (sessionUpdateCounterRef.current !== counterAtRequest) {
            // Inline path already delivered a fresh auth.login — skip reload
            // so the user keeps their WebView state.
            return;
          }
          if (__DEV__) {
            console.log('[Session] fallback — reloading WebView');
          }
          webViewRef.current?.reload();
        }, 3_000);
      },
    );
    return () => sub.remove();
  }, []);

  const onNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    setCanGoBack(nav.canGoBack);
    if (__DEV__) {
      console.log('[WebView nav]', nav.url);
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
