import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AuthLoginPayload } from '../../features/webview/bridge/messageHandler';

const STORAGE_KEY = '@youngman/auth-session-v1';

let current: AuthLoginPayload | null = null;

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
}

export function clearSession(): void {
  current = null;
  persist(null);
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
      return true;
    }
  } catch {
    // ignore — treat as no session
  }
  return false;
}
