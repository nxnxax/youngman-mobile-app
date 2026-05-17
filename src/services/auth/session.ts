// Module-level holder for the user session received from the web via the
// `auth.login` bridge event. API callers (upload, process-recording, records)
// read the access token from here.
//
// The session is in-memory only — it does not persist across app restarts.
// If the user kills and reopens the app, the WebView's cookie-backed Supabase
// session will re-fire `auth.login` once the web detects the active session.

import type { AuthLoginPayload } from '../../features/webview/bridge/messageHandler';

let current: AuthLoginPayload | null = null;

export function setSession(auth: AuthLoginPayload): void {
  current = auth;
}

export function clearSession(): void {
  current = null;
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
