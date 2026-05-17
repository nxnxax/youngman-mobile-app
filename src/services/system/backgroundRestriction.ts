import { NativeModules, Platform } from 'react-native';

export type BackgroundStatus =
  | 'restricted'
  | 'optimized'
  | 'unrestricted'
  | 'unknown';

export interface BackgroundStatusInfo {
  status: BackgroundStatus;
  isSamsung: boolean;
  manufacturer: string;
  sdkInt: number;
}

interface NativeBackgroundRestriction {
  getStatus(): Promise<BackgroundStatusInfo>;
  openAppSettings(): Promise<void>;
  requestIgnoreBatteryOptimizations(): Promise<void>;
  hasOverlayPermission(): Promise<boolean>;
  requestOverlayPermission(): Promise<void>;
}

const native = (
  NativeModules as { BackgroundRestriction?: NativeBackgroundRestriction }
).BackgroundRestriction;

export async function getBackgroundStatus(): Promise<BackgroundStatusInfo> {
  if (Platform.OS !== 'android' || !native) {
    return {
      status: 'unknown',
      isSamsung: false,
      manufacturer: '',
      sdkInt: 0,
    };
  }
  try {
    return await native.getStatus();
  } catch {
    return {
      status: 'unknown',
      isSamsung: false,
      manufacturer: '',
      sdkInt: 0,
    };
  }
}

export async function openAppSettings(): Promise<void> {
  if (Platform.OS !== 'android' || !native) {
    return;
  }
  try {
    await native.openAppSettings();
  } catch {
    // ignore
  }
}

export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  if (Platform.OS !== 'android' || !native) {
    return;
  }
  try {
    await native.requestIgnoreBatteryOptimizations();
  } catch {
    // ignore — user can still go to settings manually
  }
}

export async function hasOverlayPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || !native) {
    return true;
  }
  try {
    return await native.hasOverlayPermission();
  } catch {
    return false;
  }
}

export async function requestOverlayPermission(): Promise<void> {
  if (Platform.OS !== 'android' || !native) {
    return;
  }
  try {
    await native.requestOverlayPermission();
  } catch {
    // ignore
  }
}
