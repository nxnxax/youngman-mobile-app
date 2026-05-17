import { Linking, Platform } from 'react-native';
import {
  AuthorizationStatus,
  getMessaging,
  getToken,
  requestPermission,
} from '@react-native-firebase/messaging';

import { APP_VERSION } from '../../../config/env';
import {
  runGoogleSignIn,
  runGoogleSignOut,
} from '../../auth/googleSignIn';
import { callWebBridge, dispatchWebBridge } from './bridgeCall';

export interface AuthLoginPayload {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  expiresAt: number;
}

export interface AppInfo {
  platform: 'android' | 'ios';
  appVersion: string;
  bundleId: string;
  systemVersion: string;
}

export interface BridgeContext {
  injectScript: (js: string) => void;
  onAuthLogin: (auth: AuthLoginPayload) => void;
  onAuthLogout: () => void;
}

interface RawBridgeMessage {
  type: string;
  payload?: unknown;
}

function toAuthPayload(raw: unknown): AuthLoginPayload | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const p = raw as Partial<AuthLoginPayload>;
  if (!p.userId) {
    return null;
  }
  return {
    accessToken: String(p.accessToken ?? ''),
    refreshToken: String(p.refreshToken ?? ''),
    userId: String(p.userId),
    email: String(p.email ?? ''),
    expiresAt: Number(p.expiresAt ?? 0),
  };
}

export function buildAppInfo(): AppInfo {
  return {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    appVersion: APP_VERSION,
    bundleId: 'com.youngmanapp',
    systemVersion: String(Platform.Version),
  };
}

async function fetchFcmToken(): Promise<string | null> {
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

export async function handleBridgeMessage(
  raw: string,
  ctx: BridgeContext,
): Promise<void> {
  let msg: RawBridgeMessage | null = null;
  try {
    msg = JSON.parse(raw) as RawBridgeMessage;
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') {
    return;
  }

  switch (msg.type) {
    case 'auth.login': {
      const auth = toAuthPayload(msg.payload);
      if (auth) {
        ctx.onAuthLogin(auth);
      }
      return;
    }
    case 'auth.logout': {
      ctx.onAuthLogout();
      void runGoogleSignOut();
      return;
    }
    case 'auth.googleSignIn.request': {
      const nonce = (msg.payload as { nonce?: string } | undefined)?.nonce;
      const result = await runGoogleSignIn(nonce);
      ctx.injectScript(
        dispatchWebBridge('onGoogleSignInResult', result),
      );
      if (__DEV__) {
        if ('idToken' in result) {
          console.log('[GoogleSignIn] success (idToken length)', result.idToken.length);
        } else {
          console.log(
            '[GoogleSignIn] failure',
            result.cancelled ? 'cancelled' : result.error,
          );
        }
      }
      return;
    }
    case 'nav.openExternal': {
      const url = (msg.payload as { url?: string } | undefined)?.url;
      if (url) {
        Linking.openURL(url).catch(() => {});
      }
      return;
    }
    case 'bridge.ready': {
      // Web bridge.js handshake — bridge is loaded and ready to receive calls.
      ctx.injectScript(callWebBridge('onReady'));
      ctx.injectScript(callWebBridge('onAppInfo', buildAppInfo()));
      if (__DEV__) {
        console.log('[Bridge] ready', msg.payload);
      }
      return;
    }
    case 'app.fcm.request': {
      const token = await fetchFcmToken();
      ctx.injectScript(callWebBridge('onFcmToken', token));
      return;
    }
    case 'app.info.request': {
      ctx.injectScript(callWebBridge('onAppInfo', buildAppInfo()));
      return;
    }
    case 'debug.ping': {
      if (__DEV__) {
        console.log('[Bridge] debug.ping', msg.payload);
      }
      return;
    }
    case 'log': {
      if (__DEV__) {
        const m = (msg.payload as { msg?: string } | undefined)?.msg;
        console.log('[Web]', m);
      }
      return;
    }
    default: {
      if (__DEV__) {
        console.log('[Bridge] unknown type', msg.type, msg.payload);
      }
      return;
    }
  }
}
