import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';

const STORAGE_KEY = '@youngman/settings-v1';

export type ModalDwell = 10 | 15 | 20;
export type ModalSound = 'on' | 'off';
export type PopupFrequency = 'formal' | 'keyword' | 'always';

export interface AppSettings {
  /** Modal auto-dismiss time in seconds. */
  modalDwellSec: ModalDwell;
  /** Whether to play a notification sound when the modal pops. */
  modalSound: ModalSound;
  /** Trigger condition for showing the post-call modal. */
  popupFrequency: PopupFrequency;
  /** Comma-separated keywords used when `popupFrequency === 'keyword'`. */
  keywords: string;
  /** Master switch — when off, the CallStateReceiver path is bypassed. */
  realtimeDetection: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  modalDwellSec: 15,
  modalSound: 'off',
  popupFrequency: 'always',
  keywords: '사장님, 사모님',
  realtimeDetection: true,
};

interface NativeSettingsBridge {
  write(json: string): Promise<void>;
  isCallScreeningRoleHeld(): Promise<boolean>;
  requestCallScreeningRole(): Promise<boolean>;
}

const native = (
  NativeModules as { SettingsBridge?: NativeSettingsBridge }
).SettingsBridge;

export async function getSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Update settings and mirror them into the native SharedPreferences so that
 * OverlayService / CallStateReceiver (which run outside the RN bundle) can
 * read them synchronously.
 */
export async function updateSettings(
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore — in-memory copy will still be returned
  }
  if (Platform.OS === 'android' && native) {
    try {
      await native.write(JSON.stringify(next));
    } catch {
      // ignore — overlay will fall back to defaults
    }
  }
  return next;
}

/**
 * Resync the native side with whatever is in AsyncStorage. Call once at boot
 * so a fresh process picks up the user's persisted choices.
 */
export async function syncSettingsToNative(): Promise<void> {
  if (Platform.OS !== 'android' || !native) {
    return;
  }
  try {
    const s = await getSettings();
    await native.write(JSON.stringify(s));
  } catch {
    // ignore
  }
}

/** Whether the user has granted Youngman the call-screening role
 *  (system category — used for caller ID; we never block or screen). */
export async function isCallScreeningRoleHeld(): Promise<boolean> {
  if (Platform.OS !== 'android' || !native) return false;
  try {
    return await native.isCallScreeningRoleHeld();
  } catch {
    return false;
  }
}

/** Open the OS dialog (or fallback settings page) so the user can grant the
 *  call-screening role. Resolves true when the RoleManager dialog fired
 *  inline, false when we fell back to opening the settings page. */
export async function requestCallScreeningRole(): Promise<boolean> {
  if (Platform.OS !== 'android' || !native) return false;
  try {
    return await native.requestCallScreeningRole();
  } catch {
    return false;
  }
}
