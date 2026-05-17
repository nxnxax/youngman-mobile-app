import {
  AuthorizationStatus,
  getMessaging,
  getToken,
  requestPermission,
} from '@react-native-firebase/messaging';

/**
 * Request notification permission (if not already granted) and return the
 * current FCM device token. Returns null when permission is denied or any
 * Firebase error occurs — callers should treat null as "no push for now".
 */
export async function getFcmToken(): Promise<string | null> {
  try {
    const m = getMessaging();
    const auth = await requestPermission(m);
    const granted =
      auth === AuthorizationStatus.AUTHORIZED ||
      auth === AuthorizationStatus.PROVISIONAL;
    if (!granted) {
      return null;
    }
    return await getToken(m);
  } catch (e) {
    if (__DEV__) {
      console.warn('[FCM] token retrieval failed', e);
    }
    return null;
  }
}
