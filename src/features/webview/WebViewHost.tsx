import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type {
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewMessageEvent,
  WebViewNavigation,
} from 'react-native-webview/lib/WebViewTypes';

import type { RootStackParamList } from '../../navigation/types';

import { USER_AGENT_SUFFIX, WEB_BASE_URL } from '../../config/env';
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
  const [loading, setLoading] = useState<boolean>(true);
  const [canGoBack, setCanGoBack] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [webViewReady, setWebViewReady] = useState<boolean>(false);
  const online = useNetworkStatus();

  const onNativeRoute = useCallback(
    (route: NativeRoute): boolean => {
      if (route.pathname === 'confirm') {
        navigation.navigate('ConfirmRecording', {
          uri: route.params.uri ?? '',
          name: route.params.name ?? '',
          duration: Number(route.params.duration ?? '0'),
          dateAdded: Number(route.params.dateAdded ?? '0'),
          mimeType: route.params.mimeType ?? 'audio/mp4',
        });
        return true;
      }
      return false;
    },
    [navigation],
  );

  useHardwareBack(webViewRef, canGoBack);
  useDeepLink(webViewRef, webViewReady, onNativeRoute);

  const onNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    setCanGoBack(nav.canGoBack);
  }, []);

  const onAuthLogin = useCallback((auth: AuthLoginPayload) => {
    authRef.current = auth;
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
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
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
