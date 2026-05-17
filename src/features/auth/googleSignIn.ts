import {
  GoogleSignin,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';

import { GOOGLE_WEB_CLIENT_ID } from '../../config/env';

export interface GoogleSignInSuccess {
  idToken: string;
}

export interface GoogleSignInFailure {
  cancelled: boolean;
  error: string | null;
}

export type GoogleSignInResult = GoogleSignInSuccess | GoogleSignInFailure;

let configured = false;

function ensureConfigured(): void {
  if (configured) {
    return;
  }
  GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    offlineAccess: false,
  });
  configured = true;
}

function isCancellation(err: { code?: unknown; message?: string }): boolean {
  if (err.code === statusCodes.SIGN_IN_CANCELLED) {
    return true;
  }
  return /cancel/i.test(err.message ?? '');
}

export async function runGoogleSignIn(
  nonce?: string,
): Promise<GoogleSignInResult> {
  ensureConfigured();
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn(nonce ? { nonce } : undefined);

    if (!isSuccessResponse(response)) {
      return { cancelled: true, error: null };
    }

    const { idToken } = response.data;
    if (!idToken) {
      return { cancelled: false, error: 'No ID token returned' };
    }

    return { idToken };
  } catch (e) {
    const err = e as { code?: unknown; message?: string };
    const cancelled = isCancellation(err);
    return {
      cancelled,
      error: cancelled ? null : String(err.message ?? err),
    };
  }
}

export async function runGoogleSignOut(): Promise<void> {
  ensureConfigured();
  try {
    await GoogleSignin.signOut();
  } catch {
    // ignore
  }
}
