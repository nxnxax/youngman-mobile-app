import { useEffect } from 'react';
import { Linking } from 'react-native';
import type { WebView } from 'react-native-webview';
import type { RefObject } from 'react';

import { WEB_BASE_URL } from '../../../config/env';

const APP_SCHEME = 'youngman://';
const NATIVE_HOST = 'record';

export interface NativeRoute {
  pathname: string; // e.g. "confirm"
  params: Record<string, string>;
}

interface ParsedDeepLink {
  host: string;
  tail: string; // everything after "host" (may start with `/` or `?`)
}

function splitDeepLink(deepLink: string): ParsedDeepLink | null {
  if (!deepLink.startsWith(APP_SCHEME)) {
    return null;
  }
  const rest = deepLink.slice(APP_SCHEME.length);
  const slashIdx = rest.indexOf('/');
  const queryIdx = rest.indexOf('?');
  const cut =
    slashIdx >= 0 && (queryIdx < 0 || slashIdx < queryIdx)
      ? slashIdx
      : queryIdx;
  if (cut < 0) {
    return { host: rest, tail: '' };
  }
  return { host: rest.slice(0, cut), tail: rest.slice(cut) };
}

function parseNativeRoute(deepLink: string): NativeRoute | null {
  const split = splitDeepLink(deepLink);
  if (!split || split.host !== NATIVE_HOST) {
    return null;
  }
  // tail is like "/confirm?uri=..." — strip leading slash if present
  const cleaned = split.tail.startsWith('/') ? split.tail.slice(1) : split.tail;
  const [pathname, queryStr] = cleaned.split('?');
  const params: Record<string, string> = {};
  if (queryStr) {
    for (const pair of queryStr.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) {
        continue;
      }
      try {
        const key = decodeURIComponent(pair.slice(0, eq));
        const value = decodeURIComponent(pair.slice(eq + 1));
        params[key] = value;
      } catch {
        // skip malformed pair
      }
    }
  }
  return { pathname, params };
}

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
  onNativeRoute: (route: NativeRoute) => boolean,
): void {
  useEffect(() => {
    if (!webViewReady) {
      return;
    }

    let handled = false;

    const handle = (url: string) => {
      const native = parseNativeRoute(url);
      if (native) {
        if (__DEV__) {
          console.log('[DeepLink] native', native.pathname, native.params);
        }
        if (onNativeRoute(native)) {
          return;
        }
      }
      const target = toWebUrl(url);
      if (target) {
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(target)}; true;`,
        );
      }
    };

    Linking.getInitialURL().then(initialUrl => {
      if (handled || !initialUrl) {
        return;
      }
      if (__DEV__) {
        console.log('[DeepLink] initial', initialUrl);
      }
      handled = true;
      handle(initialUrl);
    });

    const sub = Linking.addEventListener('url', ({ url }) => {
      if (__DEV__) {
        console.log('[DeepLink] event', url);
      }
      handle(url);
    });

    return () => {
      sub.remove();
    };
  }, [webViewRef, webViewReady, onNativeRoute]);
}
