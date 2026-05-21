// Native Supabase refresh fallback.
//
// Triggered by api/client.ts tryRefreshSession() when the WebView bridge is
// dead / stuck / never started (heartbeat absent). Calls Supabase's REST
// token endpoint directly from RN, bypassing the WebView entirely.
//
// 2026-05-20 비상 사례: 사장님 8h idle 후 첫 통화 → bridge.js 응답 없음 →
// 6연속 timeout → 통화 녹음 업로드 401 → "처리 실패 HTTP 401" 모달. 이
// 모듈이 그 케이스에서 WebView 없이 access_token 을 살린다.
//
// Single-consumer 원칙 (Path A 1번): WebView 와 Native 가 동시에 같은
// refresh_token 을 소비하지 않게 refreshMutex 로 게이팅. 이 모듈 자체는
// mutex 를 관리하지 않음 — caller(api/client.ts) 가 acquire/release 책임.

import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../../config/env';
import type { AuthLoginPayload } from '../../features/webview/bridge/messageHandler';
import { logError } from '../logger/errorLog';

/** Supabase REST 응답 shape (관련 필드만 추출). */
interface SupabaseTokenResponse {
  access_token?: string;
  refresh_token?: string;
  /** Unix seconds. Supabase 가 함께 보내주는 절대 만료 시각. */
  expires_at?: number;
  /** Seconds from now. expires_at 이 없을 때 fallback. */
  expires_in?: number;
  user?: {
    id?: string;
    email?: string;
  };
  error?: string;
  error_description?: string;
}

export type NativeRefreshResult =
  | { ok: true; session: AuthLoginPayload }
  /** refresh_token 자체가 invalid — 재로그인 필요. session.dead 신호. */
  | { ok: false; reason: 'invalid_grant'; message: string }
  /** 일시 실패 (네트워크/서버) — 다음 기회에 재시도. */
  | { ok: false; reason: 'transient'; message: string }
  /** SUPABASE_URL/ANON_KEY 가 비어있음 — config 누락. */
  | { ok: false; reason: 'not_configured'; message: string };

/** Native fallback 이 사용 가능한 상태인지. env 가 채워져 있어야 함. */
export function isNativeRefreshConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

/** refresh_token 으로 새 access_token 발급. mutex 는 caller 가 책임. */
export async function nativeRefreshSession(
  refreshToken: string,
): Promise<NativeRefreshResult> {
  if (!isNativeRefreshConfigured()) {
    return {
      ok: false,
      reason: 'not_configured',
      message:
        'SUPABASE_URL / SUPABASE_ANON_KEY 가 env 에 채워지지 않았습니다.',
    };
  }
  if (!refreshToken || refreshToken.length < 16) {
    return {
      ok: false,
      reason: 'invalid_grant',
      message: 'refresh_token 누락',
    };
  }

  const url = `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        // Supabase REST는 anon key를 Bearer 로 받기도 함. apikey 헤더 단독
        // 으로 충분하지만, 일부 게이트웨이 (Cloudflare 등) 가 Authorization
        // 헤더가 없을 때 redirect 하는 경우가 있어 둘 다 보냄.
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError(
      'NativeRefresh',
      new Error(`network error after ${Date.now() - t0}ms: ${msg}`),
    );
    return { ok: false, reason: 'transient', message: msg };
  }

  let body: SupabaseTokenResponse;
  try {
    body = (await res.json()) as SupabaseTokenResponse;
  } catch {
    body = {};
  }

  const elapsed = Date.now() - t0;

  // 400 with invalid_grant — refresh_token 자체가 무효 / 만료 / 이미 회수됨.
  // 재로그인 필요. session.dead 신호로 escalate.
  if (
    res.status === 400 ||
    body.error === 'invalid_grant' ||
    body.error === 'refresh_token_not_found' ||
    body.error === 'refresh_token_expired'
  ) {
    const reason = body.error ?? `HTTP ${res.status}`;
    const message = body.error_description ?? reason;
    logError(
      'NativeRefresh',
      new Error(`invalid_grant in ${elapsed}ms: ${reason} — ${message}`),
    );
    return { ok: false, reason: 'invalid_grant', message };
  }

  if (!res.ok || !body.access_token) {
    const reason = body.error ?? `HTTP ${res.status}`;
    const message = body.error_description ?? reason;
    logError(
      'NativeRefresh',
      new Error(`transient in ${elapsed}ms: ${reason} — ${message}`),
    );
    return { ok: false, reason: 'transient', message };
  }

  // 성공 — 정규화해서 AuthLoginPayload 로 반환.
  // expires_at 우선, 없으면 expires_in 으로 계산. 단위는 seconds (unix epoch).
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt =
    typeof body.expires_at === 'number' && body.expires_at > 0
      ? body.expires_at
      : typeof body.expires_in === 'number' && body.expires_in > 0
        ? nowSec + body.expires_in
        : nowSec + 3600;

  const session: AuthLoginPayload = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshToken,
    userId: body.user?.id ?? '',
    email: body.user?.email ?? '',
    expiresAt,
  };

  logError('NativeRefresh', new Error(`ok in ${elapsed}ms`));
  return { ok: true, session };
}
