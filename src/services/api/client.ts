import { DeviceEventEmitter } from 'react-native';

import { API_BASE_URL } from '../../config/env';
import {
  getAccessToken,
  isAuthReady,
  isSessionExpiringSoon,
  waitForAuthReady,
  waitForSessionUpdate,
} from '../auth/session';
// nativeRefresh import 제거 (2026-05-22 웹팀 요청):
// WebView 의 _runRefreshOnce (25s cooldown, 12s timeout) 와 RN native fallback
// 이 같은 refresh_token 을 cross-process 로 동시 소비 → cooldown 무력화 race.
// RN 은 WebView 에 위임만 하고 직접 Supabase /auth/v1/token 을 치지 않음.
// nativeRefresh.ts / refreshMutex 의 'native' owner 는 코드 보존 (future toggle).
import {
  inPostSuccessCooldown,
  isBridgeAlive,
  release as releaseMutex,
  tryAcquire as tryAcquireMutex,
} from '../auth/refreshMutex';
import { attemptSilentReauth } from '../auth/silentReauth';
import { rearmPendingAuth } from '../outbox/outboxStore';
import { logError } from '../logger/errorLog';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ServerError {
  status?: 'error';
  code?: string;
  message?: string;
}

async function parseJsonSafe<T>(res: Response): Promise<T | ServerError> {
  try {
    return (await res.json()) as T;
  } catch {
    return {} as ServerError;
  }
}

function requireToken(): string {
  const token = getAccessToken();
  if (!token) {
    throw new ApiError('unauthorized', 401, '로그인이 필요합니다.');
  }
  return token;
}

/** 사장님 정책 (2026-05-21 ChatGPT 진단): fetch 직전 Authorization header
 *  attach 검증. "Bearer 헤더 누락" 401 의 진짜 원인 추적용. 정상 케이스는
 *  dev console 만 — ErrorLog 화면 노이즈 방지. attach 실패 (token 없거나
 *  빈 string) 시에만 logError 호출. 매 호출에 정상 attach 로그가 쌓이는
 *  걸 사장님이 "Error" 로 오인 → ErrorLog 화면 노이즈로 봄. */
function logAuthAttach(path: string, token: string | null): void {
  const attached = typeof token === 'string' && token.length > 0;
  if (!attached) {
    logError(
      'api',
      new Error(
        `Authorization header MISSING token_length=${token?.length ?? 0} path=${path}`,
      ),
    );
  } else if (__DEV__) {
    console.log(
      `[api] Authorization header attached token_length=${token.length} path=${path}`,
    );
  }
}

/**
 * 사장님 정책 (2026-05-21 ChatGPT 근본 방향): AutoSubmit 시작 전 3-step
 * verify. 통과 못 하면 upload / process-recording 자체 시작 금지 → orphan
 * job 절대 생성 안 됨.
 *
 *   1. accessToken 존재 + 비어있지 않음
 *   2. Authorization header attach 가능 (typeof string)
 *   3. /me ping 성공 (cafe24 영맨 서버엔 별도 /me 없음 → 가벼운
 *      list_unreviewed?limit=1 호출로 인증 검증)
 */
export async function ensureAuthFresh(): Promise<{ ok: boolean; reason: string }> {
  // Step 1: token 존재
  const token = getAccessToken();
  if (!token || token.length === 0) {
    return { ok: false, reason: 'no_token' };
  }
  // Step 2: header attach 가능
  if (typeof token !== 'string') {
    return { ok: false, reason: 'token_not_string' };
  }
  // Step 3: light ping. records.php?action=list_unreviewed&limit=1 은
  // server 에서 가벼운 쿼리 (LIMIT 1) 라서 verify ping 으로 충분.
  try {
    const res = await fetch(
      `${API_BASE_URL}/records.php?resource=customer-log&action=list_unreviewed&limit=1`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `ping_${res.status}` };
    }
    if (res.status >= 500) {
      // 일시 server 장애 — token 자체는 OK 로 간주 (fail-open). orphan
      // job 만 만들지 않도록 ensureAuthFresh 의도와 별개.
      return { ok: false, reason: `ping_5xx_${res.status}` };
    }
    return { ok: true, reason: 'ok' };
  } catch (e) {
    return { ok: false, reason: 'ping_network_error' };
  }
}

/**
 * Bridge event the WebViewHost listens for to refresh the Supabase session.
 * The WebView is the one that owns the Supabase JS SDK (web is the auth
 * source of truth); RN's JWT cache rots on long sessions / cold starts from
 * native triggers (CallScreening, PostCallScan). When that happens, the
 * server rejects the request with 401 — the API client emits this event and
 * waits up to ~8s for the WebView to push a fresh `auth.login`.
 */
export const SESSION_REFRESH_REQUEST_EVENT = 'youngman.session.refreshRequest';

/** Fire-and-forget: ask the WebView to push us a fresh session. Awaiting the
 *  response is done by waitForSessionUpdate(). */
function requestSessionRefresh(): void {
  DeviceEventEmitter.emit(SESSION_REFRESH_REQUEST_EVENT);
}

/** authReady 게이트 wait 시간.
 *
 *  사장님 정책 (2026-05-20 late, 무한반복 fix 다음):
 *    "지금 문제는 세션이 안 오는 게 아니라, 세션이 1~2초 늦게 왔을 때
 *     작업을 먼저 실패시키는 문제다. timeout 자체를 짧게 잡고 즉시 outbox
 *     보존 + Auth.login 시 자동 resume."
 *
 *  사장님 logcat 기준 Auth.login 도착 1.5~2초. 2초 wait 면 대부분 즉시
 *  통과. timeout 후엔 auth_pending throw → outbox pending_auth 보존 →
 *  SESSION_AUTH_READY_EVENT 자동 resume. 사용자 체감 지연 ↓. */
const AUTH_READY_WAIT_MS = 2_000;

/** API 호출 직전 호출 — accessToken + refreshToken 둘 다 채워졌는지 확인.
 *  안 채워져 있으면 짧게 대기. 사장님 정책 1 (2026-05-20):
 *  timeout 시 fail-open 금지 — 작업이 401 사용자 노출되지 않도록 명시적
 *  `auth_pending` ApiError 로 throw. caller(autoSubmitTask 등)가 catch
 *  해서 outbox 에 pending_auth 보존 + 사용자에게 친절한 "세션 준비 중" 안내. */
async function ensureAuthReady(): Promise<void> {
  if (isAuthReady()) return;
  const t0 = Date.now();
  const ready = await waitForAuthReady(AUTH_READY_WAIT_MS);
  const elapsed = Date.now() - t0;
  if (!ready) {
    // 사장님 정책 (2026-05-20 late): auth_pending 은 정상 흐름이지 실패 아님.
    // outbox 가 보존 + SESSION_AUTH_READY_EVENT 자동 resume. errors.log 에
    // 기록하면 사장님이 "에러" 로 인지 → logError 호출 X. dev console 만.
    if (__DEV__) {
      console.log(`[api] authReady timeout ${elapsed}ms — auth_pending (정상)`);
    }
    throw new ApiError(
      'auth_pending',
      401,
      '세션 준비 중입니다. 로그인 완료 후 자동 전송됩니다.',
    );
  }
  // 통과 케이스도 noise — dev console 만.
  if (__DEV__ && elapsed > 100) {
    console.log(`[api] authReady ok after ${elapsed}ms wait`);
  }
}

/** WebView-side refresh wait window.
 *
 *  사장님 정책 (2026-05-22, 웹팀 인계 [1]): WebView _runRefreshOnce 는 자체
 *  12s timeout + 25s cooldown 을 가짐. RN 은 WebView 에 위임만 하고 native
 *  REST 직접 호출 안 함. 그러므로 RN 측은 WebView 의 12s timeout 보다 살짝
 *  넉넉히 (15s) 기다린 뒤 실패 처리. bridge dead 면 즉시 false → outbox
 *  pending_auth 보존 → Auth.login 자동 resume. */
const WEBVIEW_REFRESH_WINDOW_MS = 15_000;

// Inflight refresh dedup. Without this, concurrent 401s (e.g. billing
// refresh + ledger sync + upload + FCM register + customer-log lookup all
// firing within ~50ms) each spawn their own refresh attempt, spamming the
// log with "start ×5" / "timeout ×5" entries and confusing diagnosis.
// Sharing one promise lets all callers await the same recovery round.
let inflightRefresh: Promise<boolean> | null = null;

/** Two-stage session recovery (2026-05-22 "찰거머리" 슬로건):
 *
 *  Stage 1 — WebView bridge:
 *    heartbeat 살아있으면 WebView 의 _runRefreshOnce (25s cooldown + 12s
 *    timeout) 에 위임. cross-process race 없음 (RN 은 직접 refresh 안 함).
 *
 *  Stage 2 — Silent re-auth (native Google idToken → Supabase id_token grant):
 *    bridge 사망 (8h+ idle, WebView never loaded, invalid_grant) 시 발동.
 *    refresh_token 의존 없이 Google account 의 새 idToken 으로 새 Supabase
 *    session 발급. user_logged_out 플래그 true 면 자동 시도 차단 (사장님
 *    명시적 로그아웃 의도 존중).
 *
 *  Stage 2 도 실패하면 false → outbox pending_auth 보존 → 다음 사용자 진입
 *  에서 명시적 로그인 화면. */
async function tryRefreshSession(timeoutMs: number = 20_000): Promise<boolean> {
  if (inflightRefresh) {
    if (__DEV__) {
      console.log('[api] refresh already inflight — reusing');
    }
    return inflightRefresh;
  }
  inflightRefresh = (async () => {
    // Skip if we just succeeded — 401 burst from N parallel requests
    // shouldn't each trigger their own refresh round when the cached token
    // is already fresh.
    if (inPostSuccessCooldown()) {
      if (__DEV__) {
        console.log('[api] post-success cooldown — skipping refresh');
      }
      return true;
    }
    const overallStart = Date.now();
    const bridgeAlive = isBridgeAlive();
    logError(
      'Session.refresh',
      new Error(`start (bridgeAlive=${bridgeAlive})`),
    );

    // === Stage 1: WebView bridge ===
    if (bridgeAlive && tryAcquireMutex('webview')) {
      try {
        requestSessionRefresh();
        const window = Math.min(WEBVIEW_REFRESH_WINDOW_MS, timeoutMs);
        const next = await waitForSessionUpdate(window);
        const elapsed = Date.now() - overallStart;
        if (next != null) {
          releaseMutex('success');
          logError('Session.refresh', new Error(`ok bridge in ${elapsed}ms`));
          void rearmPendingAuth();
          return true;
        }
        releaseMutex('failure', `bridge timeout ${elapsed}ms`);
        logError(
          'Session.refresh',
          new Error(`bridge timeout ${elapsed}ms — falling back to silent re-auth`),
        );
      } catch (e) {
        releaseMutex('failure', e instanceof Error ? e.message : String(e));
        logError('Session.refresh', e);
        // fall through to Stage 2
      }
    } else if (bridgeAlive) {
      // Another caller already holds the webview mutex — wait briefly for it.
      const remaining = Math.max(0, timeoutMs - (Date.now() - overallStart));
      const next = await waitForSessionUpdate(Math.min(remaining, WEBVIEW_REFRESH_WINDOW_MS));
      if (next != null) return true;
      // still nothing — try silent re-auth.
    }

    // === Stage 2: silent re-auth via native Google idToken ===
    const reauth = await attemptSilentReauth();
    if (reauth.ok) {
      const elapsed = Date.now() - overallStart;
      logError('Session.refresh', new Error(`ok silent-reauth in ${elapsed}ms`));
      void rearmPendingAuth();
      return true;
    }
    logError(
      'Session.refresh',
      new Error(`silent-reauth fail (${reauth.reason}) — outbox 에서 Auth.login resume 대기`),
    );
    return false;
  })().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

// SESSION_SYNC_TO_WEBVIEW_EVENT 의 정의/emit 은 services/auth/silentReauth.ts
// 로 이동 (2026-05-22 "찰거머리" 구조). 동일 string event name 유지하여 기존
// WebViewHost listener 는 그대로 동작.

/** Quietly try to refresh BEFORE a slow flow if the cached token looks stale.
 *  Best-effort — caller can ignore the return.
 *
 *  Widened the window from 60s → 5min after the 2026-05-19 401 storm: the
 *  user's session was already invalid by the time any request hit the wire,
 *  so a 60s lookahead never helped. 5min gives the WebView a real chance
 *  to refresh in advance of expiry. */
async function maybeProactiveRefresh(): Promise<void> {
  if (!isSessionExpiringSoon(5 * 60_000)) return;
  await tryRefreshSession(10_000);
}

interface RequestOptions {
  /** Internal — counts retry attempts. Allow up to 2 retries (initial +
   *  2 refresh attempts) before giving up. Each retry re-requests session
   *  refresh, so a transient WebView load delay on the first attempt can
   *  still recover on the second. */
  _retryCount?: number;
}

const MAX_RETRIES = 2;

export async function apiGet<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (!opts._retryCount) {
    // authReady 게이트 — 첫 로그인 직후 양식 전송 race 방지 (2026-05-20).
    // refreshToken 까지 채워질 때까지 짧게 대기 (대부분 즉시 통과).
    await ensureAuthReady();
    await maybeProactiveRefresh();
  }
  const token = requireToken();
  logAuthAttach(path, token);
  const t0 = Date.now();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const parsed = (await parseJsonSafe<T>(res)) as T & ServerError;
  const elapsed = Date.now() - t0;
  if (__DEV__) {
    console.log(
      '[api] GET',
      path,
      'status=',
      res.status,
      'time=',
      `${elapsed}ms`,
      'body=',
      JSON.stringify(parsed).slice(0, 800),
    );
  }
  if (res.status === 401 && (opts._retryCount ?? 0) < MAX_RETRIES) {
    if (await tryRefreshSession()) {
      return apiGet<T>(path, { _retryCount: (opts._retryCount ?? 0) + 1 });
    }
  }
  // 사장님 정책 (2026-05-21 emergency): 5xx 일시 부하는 자동 retry. 503/502
  // 은 cafe24 의 부하 분산 / 재시작 중에 흔히 발생 — 1.5초 후 한 번 더 시도
  // 하면 대부분 복구. 첫 attempt 만 retry, 두 번째에도 5xx 면 진짜 다운.
  if (res.status >= 500 && (opts._retryCount ?? 0) === 0) {
    await new Promise<void>(r => setTimeout(() => r(), 1_500));
    return apiGet<T>(path, { _retryCount: 1 });
  }
  if (!res.ok) {
    const apiError = new ApiError(
      parsed.code ?? 'http_error',
      res.status,
      parsed.message ?? `HTTP ${res.status}`,
    );
    if (res.status < 500) {
      logError('api', apiError, { path, status: res.status });
    }
    throw apiError;
  }
  return parsed;
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  if (!opts._retryCount) {
    // authReady 게이트 — 첫 로그인 직후 양식 전송 race 방지 (2026-05-20).
    // refreshToken 까지 채워질 때까지 짧게 대기 (대부분 즉시 통과).
    await ensureAuthReady();
    await maybeProactiveRefresh();
  }
  const token = requireToken();
  logAuthAttach(path, token);
  const t0 = Date.now();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const parsed = (await parseJsonSafe<T>(res)) as T & ServerError;
  const elapsed = Date.now() - t0;
  if (__DEV__) {
    console.log(
      '[api] POST',
      path,
      'status=',
      res.status,
      'time=',
      `${elapsed}ms`,
      'body=',
      JSON.stringify(parsed).slice(0, 800),
    );
  }
  if (res.status === 401 && (opts._retryCount ?? 0) < MAX_RETRIES) {
    if (await tryRefreshSession()) {
      return apiPost<T>(path, body, {
        _retryCount: (opts._retryCount ?? 0) + 1,
      });
    }
  }
  if (!res.ok) {
    const apiError = new ApiError(
      parsed.code ?? 'http_error',
      res.status,
      parsed.message ?? `HTTP ${res.status}`,
    );
    // 사장님 정책 (2026-05-21): 5xx 는 일시 서버 에러 — ErrorLog 안 쌓음.
    if (res.status < 500) {
      logError('api', apiError, { path, status: res.status });
    }
    throw apiError;
  }
  return parsed;
}

export async function apiPostMultipart<T>(
  path: string,
  form: FormData,
  opts: RequestOptions = {},
): Promise<T> {
  if (!opts._retryCount) {
    // authReady 게이트 — 첫 로그인 직후 양식 전송 race 방지 (2026-05-20).
    // refreshToken 까지 채워질 때까지 짧게 대기 (대부분 즉시 통과).
    await ensureAuthReady();
    await maybeProactiveRefresh();
  }
  const token = requireToken();
  logAuthAttach(path, token);
  const t0 = Date.now();
  // 사장님 정책 (2026-05-21 근본 원인): multipart upload 에 timeout 없으면
  // fetch 가 영원히 hang. AutoSubmitService 가 3분+ stuck → server 도달 못
  // 함 → recording_jobs row 없음 → 미확인 요약 빈. 60초 abort 로 보장.
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 60_000);
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      // Do NOT set Content-Type — fetch must set it with the multipart boundary.
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (ctrl.signal.aborted) {
      throw new ApiError(
        'upload_timeout',
        408,
        '업로드 시간이 초과되었습니다 (60초). 잠시 후 자동 재시도됩니다.',
      );
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
  const parsed = (await parseJsonSafe<T>(res)) as T & ServerError;
  const elapsed = Date.now() - t0;
  if (__DEV__) {
    console.log(
      '[api] POST multipart',
      path,
      'status=',
      res.status,
      'time=',
      `${elapsed}ms`,
      'body=',
      JSON.stringify(parsed).slice(0, 800),
    );
  }
  if (res.status === 401 && (opts._retryCount ?? 0) < MAX_RETRIES) {
    if (await tryRefreshSession()) {
      return apiPostMultipart<T>(path, form, {
        _retryCount: (opts._retryCount ?? 0) + 1,
      });
    }
  }
  if (!res.ok) {
    const apiError = new ApiError(
      parsed.code ?? 'http_error',
      res.status,
      parsed.message ?? `HTTP ${res.status}`,
    );
    logError('api', apiError, { path, status: res.status });
    throw apiError;
  }
  return parsed;
}
