import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

import type { AuthLoginPayload } from '../../features/webview/bridge/messageHandler';

/** isAuthReady() 가 처음 true 로 전환되는 모든 setSession 경로 (auth.login,
 *  native refresh, restoreSession) 에서 emit. outboxProcessor 가 이걸 listen
 *  해서 자동 재개. 사장님 정책 (2026-05-20): "Auth.login 또는 native refresh
 *  로 토큰 준비되는 즉시 자동 재개". */
export const SESSION_AUTH_READY_EVENT = 'youngman.session.authReady';

const STORAGE_KEY = '@youngman/auth-session-v1';

interface NativeAuthBridge {
  writeJwt(token: string): Promise<void>;
  clearJwt(): Promise<void>;
}

const authNative = (NativeModules as { AuthBridge?: NativeAuthBridge })
  .AuthBridge;

/** Mirror the JWT into native SharedPreferences so CallScreeningService and
 *  other native components can do authenticated HTTP without the RN bridge.
 *  Silent no-op on iOS / when module missing. */
function syncToNative(token: string | null): void {
  if (Platform.OS !== 'android' || !authNative) return;
  void (async () => {
    try {
      if (token) {
        await authNative.writeJwt(token);
      } else {
        await authNative.clearJwt();
      }
    } catch {
      // ignore — native cache is best-effort
    }
  })();
}

let current: AuthLoginPayload | null = null;

// Callbacks fired when setSession() runs — used by API client to wake up after
// a session refresh round-trip through the WebView. Always one-shot; the
// caller re-subscribes each time.
const sessionUpdateWaiters: Array<(payload: AuthLoginPayload) => void> = [];

function notifySessionWaiters(payload: AuthLoginPayload): void {
  const fns = sessionUpdateWaiters.splice(0);
  for (const fn of fns) {
    try {
      fn(payload);
    } catch {
      // ignore — best-effort fan-out
    }
  }
}

// === authReady barrier (2026-05-20) =========================================
//
// Race condition fix + 사장님 정책 강화 (2026-05-20):
//   "토큰 발급 자체보다 RN Native Store 에 refresh_token까지 저장 완료된
//    뒤에만 영맨 기능을 열어준다"
//
// isAuthReady = accessToken + refreshToken (in-memory) **AND** persist 완료
// (AsyncStorage write 성공 + read-back verify) 까지 만족할 때만 true.
// → autoSubmitTask / outboxProcessor / API client 가 이 게이트를 통과해야
//   API 호출. persist 완료 전엔 false → outbox 보존 + 자동 재개 흐름.
const authReadyWaiters: Array<() => void> = [];

/** in-memory current 가 갱신된 후, AsyncStorage 에 실제 write + read-back
 *  검증까지 완료되어야 true. setSession() 직후엔 false → persist verify 끝나면
 *  true 로 전환 + SESSION_AUTH_READY_EVENT broadcast. */
let _persistVerified = false;

/** 양식 전송 / customer-log 등 일반 API 호출이 안전한 상태인지.
 *  refreshToken 까지 있어야 401 시 native fallback refresh 가 가능.
 *  사장님 정책 (2026-05-20): SecureStore (= AsyncStorage) write 성공까지
 *  검증되어야 true. */
export function isAuthReady(): boolean {
  if (!current) return false;
  if (!current.accessToken) return false;
  if (!current.refreshToken) return false;
  if (!_persistVerified) return false;
  return true;
}

function notifyAuthReadyWaiters(): void {
  if (!isAuthReady()) return;
  const fns = authReadyWaiters.splice(0);
  for (const fn of fns) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
  // 전역 broadcast — outboxProcessor 와 같이 setSession 흐름 외부에서 자동
  // 재개 트리거를 받는 컴포넌트용. WebView auth.login 외에 native refresh /
  // restoreSession 도 cover.
  try {
    DeviceEventEmitter.emit(SESSION_AUTH_READY_EVENT);
  } catch {
    // ignore
  }
}

/** Resolve 시점:
 *  - true: authReady (accessToken + refreshToken 모두 있음)
 *  - false: timeoutMs 안에 도달 못 함. caller 는 그대로 진행해도 되고
 *    (기존 401 → refresh 흐름이 잡음) 별도 처리 해도 됨. */
export async function waitForAuthReady(
  timeoutMs: number = 8_000,
): Promise<boolean> {
  if (isAuthReady()) return true;
  return new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    const t = setTimeout(() => finish(false), timeoutMs);
    authReadyWaiters.push(() => {
      clearTimeout(t);
      finish(true);
    });
  });
}

/**
 * Resolves on the next setSession() call, or false on timeout. Used by the
 * API client after a 401: emit a refresh request to the WebView, then await
 * here for the WebView's bridge to post a fresh auth.login. Timeout protects
 * against the WebView being dead / lacking the refresh hook.
 */
export async function waitForSessionUpdate(
  timeoutMs: number = 8_000,
): Promise<AuthLoginPayload | null> {
  return new Promise<AuthLoginPayload | null>(resolve => {
    let settled = false;
    const finish = (payload: AuthLoginPayload | null) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const t = setTimeout(() => finish(null), timeoutMs);
    sessionUpdateWaiters.push(payload => {
      clearTimeout(t);
      finish(payload);
    });
  });
}

/** Returns true if the current token is missing or within `bufferMs` of
 *  expiry. Useful for proactive refresh before a slow flow (uploads). */
export function isSessionExpiringSoon(bufferMs: number = 60_000): boolean {
  if (!current) return true;
  const exp = current.expiresAt;
  if (!exp || exp <= 0) return false; // unknown expiry, assume OK
  // Supabase expiresAt is in seconds (unix epoch). Normalize.
  const expMs = exp < 10_000_000_000 ? exp * 1000 : exp;
  return expMs - Date.now() < bufferMs;
}

/** persist + read-back verify. refreshToken 까지 실제 저장되었는지 확인 후
 *  _persistVerified=true. 사장님 정책 (2026-05-20): "로그인 직후 native
 *  fallback 테스트로 refresh_token 이 실제 저장됐는지 확인".
 *  read-back verify 가 가장 단순한 검증 — Supabase token rotation 비용 없이
 *  실제 storage 에 쓰여 있는지만 확인. */
async function persistAndVerify(value: AuthLoginPayload): Promise<boolean> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as AuthLoginPayload;
    if (
      parsed &&
      parsed.accessToken === value.accessToken &&
      parsed.refreshToken === value.refreshToken &&
      parsed.refreshToken.length > 0
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function persistClear(): void {
  void (async () => {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  })();
}

export function setSession(auth: AuthLoginPayload): void {
  current = auth;
  // 새 session 시작 — persist verify 완료 전까진 authReady=false.
  _persistVerified = false;
  syncToNative(auth.accessToken);
  notifySessionWaiters(auth);
  // persist + read-back verify (async). 완료되면 isAuthReady=true 로 전환되고
  // SESSION_AUTH_READY_EVENT broadcast. outbox 가 자동 재개.
  void (async () => {
    const ok = await persistAndVerify(auth);
    if (ok && current === auth) {
      _persistVerified = true;
      notifyAuthReadyWaiters();
    }
  })();
}

export function clearSession(): void {
  current = null;
  _persistVerified = false;
  persistClear();
  syncToNative(null);
}

export function getAccessToken(): string | null {
  return current?.accessToken ?? null;
}

export function getUserEmail(): string | null {
  return current?.email ?? null;
}

export function getSession(): Readonly<AuthLoginPayload> | null {
  return current;
}

export function isLoggedIn(): boolean {
  return current != null;
}

/**
 * Restore session from AsyncStorage. Call once on app startup (or at the
 * beginning of a headless task) before any API call. Returns true if a
 * session was restored.
 */
export async function restoreSession(): Promise<boolean> {
  if (current != null) {
    return true;
  }
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw) as AuthLoginPayload;
    if (parsed && typeof parsed.accessToken === 'string') {
      current = parsed;
      // restore 된 session = 이미 storage 에 정상 저장된 상태 — persist verify
      // 통과 (refreshToken 까지 있으면).
      _persistVerified = parsed.refreshToken?.length > 0;
      // Make sure the native cache is fresh after a process restart —
      // otherwise CallScreeningService could be using a stale or empty JWT.
      syncToNative(parsed.accessToken);
      // restore 된 session 도 refreshToken 까지 있으면 authReady 마킹.
      // headless task 가 waitForAuthReady() 로 진행 가능.
      notifyAuthReadyWaiters();
      return true;
    }
  } catch {
    // ignore — treat as no session
  }
  return false;
}
