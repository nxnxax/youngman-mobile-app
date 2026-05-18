import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';

import type { AuthLoginPayload } from '../../features/webview/bridge/messageHandler';

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

function persist(value: AuthLoginPayload | null): void {
  void (async () => {
    try {
      if (value) {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } else {
        await AsyncStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // ignore storage write errors
    }
  })();
}

export function setSession(auth: AuthLoginPayload): void {
  current = auth;
  persist(auth);
  syncToNative(auth.accessToken);
  notifySessionWaiters(auth);
}

export function clearSession(): void {
  current = null;
  persist(null);
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
      // Make sure the native cache is fresh after a process restart —
      // otherwise CallScreeningService could be using a stale or empty JWT.
      syncToNative(parsed.accessToken);
      return true;
    }
  } catch {
    // ignore — treat as no session
  }
  return false;
}
