import { Platform } from 'react-native';

import { apiPost } from '../api/client';
import { isLoggedIn } from '../auth/session';
import { logError } from '../logger/errorLog';
import { getFcmToken } from './getFcmToken';

interface RegisterResponse {
  status: 'ok';
  fcm_token: {
    id: number;
    token_masked: string;
    device_id: string | null;
    platform: 'android' | 'ios';
    last_seen_at: string;
    created_at: string;
  };
}

interface UnregisterResponse {
  status: 'ok';
  deleted: number;
}

/**
 * Register the current FCM device token with the cafe24 backend so server-side
 * push (async processing completion, etc.) can target this device.
 *
 * UPSERT-safe — calling repeatedly with the same token is fine. Requires a
 * valid Supabase session; bails silently when logged out.
 */
export async function registerFcmTokenWithServer(): Promise<string | null> {
  if (!isLoggedIn()) {
    return null;
  }
  const token = await getFcmToken();
  if (!token) {
    return null;
  }
  try {
    await apiPost<RegisterResponse>(
      '/records.php?resource=app-fcm-token',
      {
        action: 'register',
        token,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
      },
    );
    if (__DEV__) {
      console.log('[FCM] token registered with server (len)', token.length);
    }
    return token;
  } catch (e) {
    logError('FCM.register', e);
    return null;
  }
}

/**
 * Tell the server to drop this device's FCM token. Called on sign-out.
 * UPSERT semantics on the server mean this is optional — if the same token
 * is later registered by a different account, ownership transfers — but
 * explicit cleanup keeps the table tidy.
 */
export async function unregisterFcmTokenWithServer(): Promise<void> {
  const token = await getFcmToken();
  if (!token) {
    return;
  }
  try {
    await apiPost<UnregisterResponse>(
      '/records.php?resource=app-fcm-token',
      { action: 'unregister', token },
    );
    if (__DEV__) {
      console.log('[FCM] token unregistered with server');
    }
  } catch (e) {
    logError('FCM.unregister', e);
  }
}
