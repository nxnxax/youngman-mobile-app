// Silent re-authentication via native Google Sign-In + Supabase id_token grant.
//
// 사장님 정책 (2026-05-22 "찰거머리" 슬로건):
//   "365일 만에 접속해도 영맨은 사용자한테 딱붙어서 AI 정보를 흐트러짐 없이
//    보여줘야 한다."
//
// 토큰 만료 / 8h+ idle 후 양쪽 refresh_token 사라진 케이스 (사장님 7h 비상)
// 자동 복구 경로. WebView 의 refresh 와 *완전히 무관* — Google idToken 을
// 새로 발급받아 Supabase native sign-in endpoint 로 새 session 생성.
// 그러므로 refresh_token rotation race 와 무관 (이전 Stage 2 native fallback
// 의 cross-process race 문제와 다른 메커니즘).
//
// 전제 조건:
//   1. user_logged_out 플래그 false (명시적 로그아웃 상태 아님)
//   2. device 에 Google account 가 sign-in 되어 있음 (영맨은 Google OAuth
//      가입 강제라 사실상 보장)
//
// 실패 케이스:
//   - logged_out          : 사용자 명시적 로그아웃 상태 — silent 자동 시도 금지
//   - no_credential       : silentSignIn 이 noSavedCredentialFound 반환
//                           (앱 재설치 / Google account 제거 등)
//   - no_id_token         : Google 이 idToken 없이 반환 (드문 케이스)
//   - http_<status>       : Supabase 응답 비-200
//   - network             : fetch 자체 실패
//   - invalid_response    : Supabase 응답 파싱 실패
//
// 실패 시 caller 는 outbox pending_auth 보존 + 다음 사용자 진입에서 명시적
// 로그인 화면을 보여주는 흐름으로 떨어진다.

import { DeviceEventEmitter } from 'react-native';

import { GOOGLE_WEB_CLIENT_ID, SUPABASE_ANON_KEY, SUPABASE_URL } from '../../config/env';
import type { AuthLoginPayload } from '../../features/webview/bridge/messageHandler';
import { logError } from '../logger/errorLog';
import { isExplicitlyLoggedOut } from './loggedOutFlag';
import { setSession } from './session';

/** Emitted after a successful silent re-auth so the WebView can reconcile its
 *  localStorage / Supabase JS state. WebViewHost listens and injects a
 *  setSession call into the page. (Same event name kept from the old native
 *  refresh fallback — WebViewHost already subscribes.) */
export const SESSION_SYNC_TO_WEBVIEW_EVENT = 'youngman.session.syncToWebView';

export type SilentReauthResult =
  | { ok: true; session: AuthLoginPayload }
  | { ok: false; reason: string };

// Lazy-load to avoid hard dep at module load time. Test environments without
// Google Play Services should be able to import this module without crashing.
async function silentlySignInForIdToken(): Promise<
  { ok: true; idToken: string } | { ok: false; reason: string }
> {
  try {
    const sdk = await import('@react-native-google-signin/google-signin');
    const { GoogleSignin } = sdk;
    // configure() is idempotent and cheap — call it here so callers don't need
    // to wire up bootstrap order. googleSignIn.ts also calls configure() for
    // the interactive path; both can coexist.
    GoogleSignin.configure({
      webClientId: GOOGLE_WEB_CLIENT_ID,
      offlineAccess: false,
    });
    const response = await GoogleSignin.signInSilently();
    if (response.type === 'noSavedCredentialFound') {
      return { ok: false, reason: 'no_credential' };
    }
    const idToken = response.data?.idToken ?? null;
    if (!idToken) {
      return { ok: false, reason: 'no_id_token' };
    }
    return { ok: true, idToken };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `sdk_error:${message}` };
  }
}

interface SupabaseTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  user?: { id?: string; email?: string };
}

async function exchangeIdTokenForSupabaseSession(
  idToken: string,
): Promise<SilentReauthResult> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=id_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ provider: 'google', id_token: idToken }),
    });
  } catch (e) {
    return { ok: false, reason: `network:${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `http_${res.status}` };
  }
  let body: SupabaseTokenResponse;
  try {
    body = (await res.json()) as SupabaseTokenResponse;
  } catch {
    return { ok: false, reason: 'invalid_response' };
  }
  if (!body.access_token || !body.refresh_token || !body.user?.id) {
    return { ok: false, reason: 'incomplete_response' };
  }
  const expiresAt =
    body.expires_at ??
    (body.expires_in ? Math.floor(Date.now() / 1000) + body.expires_in : 0);
  const session: AuthLoginPayload = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    userId: body.user.id,
    email: body.user.email ?? '',
    expiresAt,
  };
  return { ok: true, session };
}

/** 토큰 만료 / 세션 만료 시 사용자 interaction 없이 새 Supabase session 자동
 *  복구 시도. 성공하면 setSession() + SESSION_SYNC_TO_WEBVIEW_EVENT emit.
 *
 *  사장님 정책: user_logged_out=true 인 경우 자동 시도 금지 (caller 가 호출
 *  자체 안 하도록 게이트해도 되지만 모듈 내부에서도 안전망으로 한 번 더 체크).
 */
export async function attemptSilentReauth(): Promise<SilentReauthResult> {
  if (await isExplicitlyLoggedOut()) {
    return { ok: false, reason: 'logged_out' };
  }
  const t0 = Date.now();
  logError('SilentReauth', new Error('start'));

  const idTokenResult = await silentlySignInForIdToken();
  if (!idTokenResult.ok) {
    logError(
      'SilentReauth',
      new Error(`silentSignIn fail (${idTokenResult.reason}) in ${Date.now() - t0}ms`),
    );
    return { ok: false, reason: idTokenResult.reason };
  }

  const exchangeResult = await exchangeIdTokenForSupabaseSession(idTokenResult.idToken);
  const elapsed = Date.now() - t0;
  if (!exchangeResult.ok) {
    logError(
      'SilentReauth',
      new Error(`Supabase exchange fail (${exchangeResult.reason}) in ${elapsed}ms`),
    );
    return exchangeResult;
  }

  setSession(exchangeResult.session);
  DeviceEventEmitter.emit(SESSION_SYNC_TO_WEBVIEW_EVENT, exchangeResult.session);
  logError('SilentReauth', new Error(`ok in ${elapsed}ms`));
  return exchangeResult;
}
