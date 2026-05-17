import { useEffect } from 'react';
import { Linking } from 'react-native';
import type { WebView } from 'react-native-webview';
import type { RefObject } from 'react';

import { WEB_BASE_URL } from '../../../config/env';

const APP_SCHEME = 'youngman://';

function toWebUrl(deepLink: string): string | null {
  if (!deepLink.startsWith(APP_SCHEME)) {
    return null;
  }
  const tail = deepLink.slice(APP_SCHEME.length);
  if (tail.length === 0) {
    return WEB_BASE_URL;
  }
  const path = tail.startsWith('/') ? tail : `/${tail}`;
  return `${WEB_BASE_URL}${path}`;
}

export function useDeepLink(
  webViewRef: RefObject<WebView | null>,
  webViewReady: boolean,
): void {
  useEffect(() => {
    if (!webViewReady) {
      return;
    }

    let handled = false;

    Linking.getInitialURL().then(initialUrl => {
      if (handled || !initialUrl) {
        return;
      }
      if (__DEV__) {
        console.log('[DeepLink] initial', initialUrl);
      }
      const target = toWebUrl(initialUrl);
      if (target) {
        handled = true;
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(target)}; true;`,
        );
      }
    });

    const sub = Linking.addEventListener('url', ({ url }) => {
      if (__DEV__) {
        console.log('[DeepLink] event', url);
      }
      const target = toWebUrl(url);
      if (target) {
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(target)}; true;`,
        );
      }
    });

    return () => {
      sub.remove();
    };
  }, [webViewRef, webViewReady]);
}
