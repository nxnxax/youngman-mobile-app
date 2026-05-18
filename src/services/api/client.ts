import { DeviceEventEmitter } from 'react-native';

import { API_BASE_URL } from '../../config/env';
import {
  getAccessToken,
  isSessionExpiringSoon,
  waitForSessionUpdate,
} from '../auth/session';
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

/** Wait at most `timeoutMs` for the WebView to post `auth.login`. Returns
 *  true if the session was updated (so the caller may retry).
 *
 *  Max strength: 20s allows the slowest path (full WebView reload + page
 *  load + bridge handshake) to complete on a slow network. localStorage
 *  read path usually wins in <100ms; this timeout is the safety net for
 *  cold-start scenarios where the WebView wasn't loaded yet. */
async function tryRefreshSession(timeoutMs: number = 20_000): Promise<boolean> {
  if (__DEV__) {
    console.log('[api] 401 → requesting session refresh');
  }
  requestSessionRefresh();
  const next = await waitForSessionUpdate(timeoutMs);
  if (__DEV__) {
    console.log('[api] session refresh result:', next ? 'fresh' : 'timeout');
  }
  return next != null;
}

/** Quietly try to refresh BEFORE a slow flow if the cached token looks stale.
 *  Best-effort — caller can ignore the return. */
async function maybeProactiveRefresh(): Promise<void> {
  if (!isSessionExpiringSoon(60_000)) return;
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
    await maybeProactiveRefresh();
  }
  const token = requireToken();
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

export async function apiPost<T>(
  path: string,
  body: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  if (!opts._retryCount) {
    await maybeProactiveRefresh();
  }
  const token = requireToken();
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
    logError('api', apiError, { path, status: res.status });
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
    await maybeProactiveRefresh();
  }
  const token = requireToken();
  const t0 = Date.now();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    // Do NOT set Content-Type — fetch must set it with the multipart boundary.
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
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
