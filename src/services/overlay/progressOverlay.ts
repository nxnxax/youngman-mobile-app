import { NativeModules, Platform } from 'react-native';

interface NativeProgressOverlay {
  show(): void;
  hide(): void;
}

const native = (NativeModules as { ProgressOverlay?: NativeProgressOverlay })
  .ProgressOverlay;

/** Show the thin top progress bar. No-op on iOS / missing module. */
export function showProgressOverlay(): void {
  if (Platform.OS !== 'android' || !native) return;
  try {
    native.show();
  } catch {
    // never let UI affordances throw
  }
}

/** Hide the thin top progress bar. Safe to call when it isn't showing. */
export function hideProgressOverlay(): void {
  if (Platform.OS !== 'android' || !native) return;
  try {
    native.hide();
  } catch {
    // ignore
  }
}
