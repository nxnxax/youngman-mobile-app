import { NativeModules, Platform } from 'react-native';

interface NativeSuccessOverlay {
  show(): void;
}

const native = (NativeModules as { SuccessOverlay?: NativeSuccessOverlay })
  .SuccessOverlay;

/**
 * Pop a small glass-card confirmation overlay with a green check + "양식 전송
 * 완료". Only call after the server has confirmed the customer_log was
 * persisted to the ledger (send_to_group 200 OK). Silent no-op on iOS or when
 * the native module is missing.
 */
export function showSuccessOverlay(): void {
  if (Platform.OS !== 'android' || !native) {
    return;
  }
  try {
    native.show();
  } catch {
    // never let UI confetti throw upward
  }
}
