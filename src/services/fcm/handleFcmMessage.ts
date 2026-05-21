import type { FirebaseMessagingTypes } from '@react-native-firebase/messaging';
import { DeviceEventEmitter, ToastAndroid } from 'react-native';

import {
  fetchJobStatus,
  type JobInfo,
} from '../../features/callRecording/api/jobStatus';
import { sendCustomerLogToGroup } from '../../features/callRecording/api/records';
import { updateActiveJob, getActiveJob } from '../../features/processing/jobStore';
import { refreshProfile } from '../billing/billingStore';
import { showSuccessOverlay } from '../overlay/showSuccessOverlay';
import { logError } from '../logger/errorLog';

/**
 * Central FCM message router. Called from both:
 *  - background handler (index.js: setBackgroundMessageHandler)
 *  - foreground handler (if/when we add `onMessage` for in-app banners)
 *
 * Server sends `data` payloads only (no `notification` block) so we have full
 * control over UX. Routing is by `data.type`. **All `data` field values
 * are strings per FCM contract** — parseInt where needed.
 *
 * Active types (영맨 서버측 ship 완료):
 *  - `call_summary_ready`     AI 요약 완료 (commit 1069ef7 / process-recording.php
 *                              async path + cron-process-jobs.php)
 *  - `subscription.statusUpdate` PortOne webhook → server → device fan-out
 *  - `usage_warning`           월 분 한도 80/90/100% 도달 (commit ee7138b)
 *  - `overage_charged`         자동 충전 성공 (commit ee7138b)
 *
 * Stays a no-op for unknown types so future server additions don't crash
 * old client versions.
 */
export async function handleFcmMessage(
  remoteMessage: FirebaseMessagingTypes.RemoteMessage,
): Promise<void> {
  const data = remoteMessage.data ?? {};
  const type = (data.type as string | undefined) ?? '';
  if (__DEV__) {
    console.log('[FCM] message type=', type, 'data=', data);
  }
  switch (type) {
    case 'call_summary_ready': {
      // AI summary finished server-side. Three things happen here:
      //  1) Bind customer_log → selected group (hybrid hand-off — server
      //     persisted group_id on recording_jobs and echoes it here, so
      //     the client doesn't have to track that state across the
      //     background processing window).
      //  2) Update in-memory jobStore so FloatingProcessingCard flips to
      //     "완료" and auto-dismisses (and SuccessOverlay shows if this
      //     job came from the AutoSubmit "양식에 전송" path).
      //  3) Refresh the billing profile so minute usage indicator catches
      //     up (this completion likely consumed quota).
      const jobId = data.job_id as string | undefined;
      const customerLogId = data.customer_log_id as string | undefined;
      const groupIdRaw = data.group_id as string | undefined;
      const groupId =
        groupIdRaw && groupIdRaw.length > 0 ? groupIdRaw : null;
      if (!jobId) {
        logError('FCM.call_summary_ready', new Error('missing job_id'));
        return;
      }

      // (1) Bind to group. Empty string from FCM is treated as null →
      // server's default group rule applies. customer_log_send_to_group
      // is the lock-in flow (8-field mapping + phone merge + backfill);
      // we delegate to it instead of touching that logic.
      if (customerLogId) {
        try {
          await sendCustomerLogToGroup({
            id: customerLogId,
            group_id: groupId,
          });
        } catch (e) {
          logError('FCM.call_summary_ready', e, { jobId, customerLogId });
          // Don't bail — the card update below is still useful.
        }
      }

      // (2) Update card + maybe SuccessOverlay.
      const active = getActiveJob();
      const fromAutoSubmit = active?.metadata.fromAutoSubmit === true;
      if (active && active.jobId === jobId) {
        try {
          const job = await fetchJobStatus(jobId);
          updateActiveJob(job);
        } catch (e) {
          if (__DEV__) console.log('[FCM] fetchJobStatus failed', e);
          // Synthesize minimal terminal state so the card progresses.
          const synthetic: JobInfo = {
            id: jobId,
            status: 'completed',
            step_label: '완료',
            progress_pct: 100,
            customer_log_id: customerLogId ?? null,
            duration_sec: active.job?.duration_sec ?? 0,
            retry_count: 0,
            started_at: active.job?.started_at ?? new Date().toISOString(),
            completed_at: new Date().toISOString(),
            error_message: null,
          };
          updateActiveJob(synthetic);
        }
      }

      // AutoSubmit path expects the visible success overlay — this is the
      // user's only confirmation that the "양식에 전송" actually worked.
      if (fromAutoSubmit) {
        try {
          showSuccessOverlay();
        } catch {
          // overlay is best-effort; the floating card already flipped
        }
      }

      // (3) Usage indicator.
      void refreshProfile();
      return;
    }

    case 'subscription.statusUpdate':
      // PortOne webhook fired → refresh entitlement cache so gating modals
      // + UsageBanner flip immediately.
      await refreshProfile();
      return;

    case 'usage_warning': {
      // 80 / 90 / 100% 도달. UsageBanner가 알아서 상태 갱신 + 사용자에게
      // 토스트로 한 번 알림. 모든 data field는 string이므로 parseInt 필요.
      const threshold = parseInt((data.threshold as string) ?? '0', 10);
      const usedMin = parseInt((data.used_min as string) ?? '0', 10);
      const limitMin = parseInt((data.limit_min as string) ?? '0', 10);
      const periodEnd = (data.period_end as string) ?? '';
      const msg =
        threshold >= 100
          ? `이번 달 ${usedMin}/${limitMin}분 한도 도달`
          : `사용량 ${threshold}% — ${usedMin}/${limitMin}분 사용`;
      try {
        ToastAndroid.show(msg, ToastAndroid.LONG);
      } catch {
        // foreground 아닐 때는 토스트 안 뜨는 게 정상 — FCM의 notification
        // payload가 시스템 알림으로 떠 있음
      }
      // Refresh profile so UsageBanner re-renders with the new used_min.
      void refreshProfile();
      // Emit event so any active screen can react (Settings의 사용량
      // 인디케이터 등). Period_end는 그대로 string 전달.
      DeviceEventEmitter.emit('youngman.usageWarning', {
        threshold,
        usedMin,
        limitMin,
        periodEnd,
      });
      return;
    }

    case 'overage_charged': {
      // 자동 충전 결제 성공. 성공 토스트 + profile 갱신.
      const amount = parseInt((data.amount as string) ?? '0', 10);
      const addedMin = parseInt((data.added_min as string) ?? '0', 10);
      const newBalanceMin = parseInt(
        (data.new_balance_min as string) ?? '0',
        10,
      );
      const msg = `₩${amount.toLocaleString()} 결제 완료 — ${addedMin}분 추가 (잔액 ${newBalanceMin}분)`;
      try {
        ToastAndroid.show(msg, ToastAndroid.LONG);
      } catch {
        // foreground 아닐 때는 시스템 알림이 대신
      }
      void refreshProfile();
      DeviceEventEmitter.emit('youngman.overageCharged', {
        amount,
        addedMin,
        newBalanceMin,
      });
      return;
    }

    default:
      return;
  }
}
