import { useEffect } from 'react';
import type { RefObject } from 'react';
import { BackHandler, Platform } from 'react-native';
import type WebView from 'react-native-webview';

import { callWebBridge } from '../bridge/bridgeCall';

export function useHardwareBack(
  webViewRef: RefObject<WebView | null>,
  canGoBack: boolean,
): void {
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    const onBackPress = (): boolean => {
      webViewRef.current?.injectJavaScript(callWebBridge('onBack'));
      if (canGoBack && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, [canGoBack, webViewRef]);
}
