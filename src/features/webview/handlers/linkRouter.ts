import { Linking } from 'react-native';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { ALLOWED_HOSTS } from '../../../config/env';

const SYSTEM_SCHEMES: ReadonlyArray<string> = [
  'tel:',
  'mailto:',
  'sms:',
  'intent:',
  'market:',
  'geo:',
];

const APP_SCHEMES: ReadonlyArray<string> = [
  'kakaolink:',
  'kakaoplus:',
  'kakaotalk:',
  'naversearchapp:',
  'line:',
  'fb:',
];

const DOWNLOAD_EXT_RE =
  /\.(pdf|xlsx?|docx?|pptx?|hwp|zip|csv|apk|png|jpe?g|gif|mp4|mov|m4a|mp3|wav|opus|3gp)(\?.*)?$/i;

function extractHost(url: string): string | null {
  const match = url.match(/^https?:\/\/([^/?#]+)/i);
  if (!match) {
    return null;
  }
  return match[1].toLowerCase();
}

function isInternalHost(host: string): boolean {
  return ALLOWED_HOSTS.some(
    h => host === h || host.endsWith(`.${h}`),
  );
}

export function shouldStartLoad(request: ShouldStartLoadRequest): boolean {
  const url = request.url;

  if (!url || url === 'about:blank') {
    return true;
  }

  if (SYSTEM_SCHEMES.some(s => url.startsWith(s))) {
    Linking.openURL(url).catch(() => {});
    return false;
  }

  if (APP_SCHEMES.some(s => url.startsWith(s))) {
    Linking.openURL(url).catch(() => {});
    return false;
  }

  if (!/^https?:\/\//i.test(url)) {
    Linking.openURL(url).catch(() => {});
    return false;
  }

  const host = extractHost(url);
  if (!host) {
    return true;
  }

  if (!isInternalHost(host)) {
    Linking.openURL(url).catch(() => {});
    return false;
  }

  if (DOWNLOAD_EXT_RE.test(url)) {
    Linking.openURL(url).catch(() => {});
    return false;
  }

  return true;
}
