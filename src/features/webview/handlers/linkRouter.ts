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
  // Korean card-issuer / 간편결제 app schemes for PortOne(포트원)+토스페이먼츠
  // 3DS / 모바일 인증 step. WebView must hand these off to Linking.openURL —
  // refusing them breaks payment mid-flow. PoC may reveal additional schemes
  // (특히 BC카드, 페이북) — add them here.
  // Cards
  'kb-acp:',                       // KB국민
  'mpocket.online.ansimclick:',    // 삼성 / BC 안심클릭 (공유 스킴)
  'tauthlink:',                    // 삼성 모바일 인증
  'shinhan-sr-ansimclick:',        // 신한 안심클릭
  'shinhan-sr-ansimclick-iss:',    // 신한 ISP
  'hdcardappcardansimclick:',      // 현대카드
  'smhyundaiansimclick:',          // 현대 SmS 안심클릭
  'lotteappcard:',                 // 롯데앱카드
  'lottesmartpay:',                // 롯데 스마트페이
  'cloudpay:',                     // 하나카드 (클라우드페이)
  'nhappcardansimclick:',          // NH농협
  'nonghyupcardansimclick:',       // NH농협 구버전
  'citispay:',                     // 씨티
  'citimobileapp:',                // 씨티 모바일앱
  'wooripay:',                     // 우리페이
  'newsmartpib:',                  // 우리은행 스마트뱅킹
  // 공통 인증
  'ispmobile:',                    // KISA ISP 모바일 (공인)
  // 간편결제
  'samsungpay:',                   // 삼성페이
  'kakaopay:',                     // 카카오페이
  'payco:',                        // PAYCO
  'paybooc:',                      // 페이북 (BC카드)
  'supertoss:',                    // 토스
  'tswauthticket:',                // 토스 인증
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
