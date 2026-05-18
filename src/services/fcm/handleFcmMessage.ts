import type { FirebaseMessagingTypes } from '@react-native-firebase/messaging';

/**
 * Central FCM message router. Called from both:
 *  - background handler (index.js: setBackgroundMessageHandler)
 *  - foreground handler (if/when we add `onMessage` for in-app banners)
 *
 * Server sends `data` payloads only (no `notification` block) so we have full
 * control over UX. Routing is by `data.type`. Add new cases below as server-
 * side notification types come online.
 *
 * Known/planned types (web team owns the contract):
 *  - `recording.processed`     M3: long-call AI summary finished server-side
 *                              (sent by the chunk-and-map-reduce worker —
 *                              see docs/BACKEND_LONG_CALL_CHUNKING.md)
 *  - `subscription.statusUpdate` PortOne webhook → server → device fan-out
 *                              when plan / plan_status / quota changes
 *                              (see docs/BILLING_INTEGRATION_TODO.md C1)
 *
 * Stays a no-op for unknown types so future server additions don't crash
 * old client versions.
 */
export async function handleFcmMessage(
  remoteMessage: FirebaseMessagingTypes.RemoteMessage,
): Promise<void> {
  const type = (remoteMessage.data?.type as string | undefined) ?? '';
  if (__DEV__) {
    console.log('[FCM] message type=', type, 'data=', remoteMessage.data);
  }
  switch (type) {
    case 'recording.processed':
      // Server signals an async summary is ready. The actual customer_log
      // row already exists DB-side; we just need to surface it to the user.
      // Implementation will land alongside the server chunking work — until
      // then this is a logged no-op so the message is acknowledged.
      // TODO(M3): pop a local notification ("통화 요약이 완료됐어요") with a
      //   deep link to the new customer_log in /customers.html.
      return;
    case 'subscription.statusUpdate':
      // Plan changed (new subscription, renewed, cancelled, past_due, etc.).
      // RN should invalidate its plan cache and refetch /api/billing/status
      // so the entitlement gates flip in lockstep with the server.
      // TODO(billing): wire to a Zustand/Redux plan store once it exists.
      return;
    default:
      return;
  }
}
