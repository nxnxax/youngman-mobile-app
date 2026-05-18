import { restoreSession, isLoggedIn } from '../../../services/auth/session';
import {
  ensureFreshProfile,
  evaluateSummaryGate,
} from '../../../services/billing/billingStore';
import { lookupContactName } from '../../../services/contacts/lookupContact';
import { logError } from '../../../services/logger/errorLog';
import { hideProgressOverlay } from '../../../services/overlay/progressOverlay';
import { showSuccessOverlay } from '../../../services/overlay/showSuccessOverlay';
import { deterministicRequestId } from '../../../shared/uuid';
import { processRecording } from '../api/processRecording';
import { sendCustomerLogToGroup } from '../api/records';
import { uploadRecording } from '../api/uploadRecording';
import { extractPhoneNumber } from '../scanner/heuristics';

export interface AutoSubmitTaskPayload {
  uri: string;
  name: string;
  duration: number; // ms
  dateAdded: number; // unix seconds
  mimeType: string;
  /** Optional ledger group id selected from the glass overlay dropdown. */
  groupId?: string | null;
}

function toIso8601Local(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const local = new Date(d.getTime() + offsetMin * 60_000);
  return local.toISOString().replace('Z', `${sign}${hh}:${mm}`);
}

export async function autoSubmitTask(
  data: AutoSubmitTaskPayload,
): Promise<void> {
  await restoreSession();
  if (!isLoggedIn()) {
    hideProgressOverlay();
    logError('AutoSubmit', 'no session — task aborting', {
      name: data.name,
      duration: data.duration,
    });
    return;
  }

  // Plan gating BEFORE the upload — no point burning Clova/LLM credits if
  // the server is going to reject with `plan_required` anyway. The headless
  // task can't pop an Alert (no UI thread) so we just abort silently. The
  // user gets the same outcome they would from the pre-call dialog: nothing
  // happens. They'll discover via the Settings indicator the next time
  // they open the app.
  //
  // Fail-open: if profile fetch failed (network glitch), let the upload
  // run — the server enforces `plan_required` 403 anyway, and we shouldn't
  // silently drop the recording on transient network failures.
  const profile = await ensureFreshProfile();
  if (profile) {
    const gate = evaluateSummaryGate(profile);
    if (!gate.allowed) {
      hideProgressOverlay();
      if (__DEV__) {
        console.log('[AutoSubmit] gate closed:', gate.reason);
      }
      logError('AutoSubmit', 'plan gate closed', {
        reason: gate.reason ?? 'unknown',
        plan: profile.plan,
        plan_status: profile.plan_status,
      });
      return;
    }
  }

  const recordedAt = toIso8601Local(data.dateAdded);
  const phoneNumber = extractPhoneNumber(data.name);
  const contactName = await lookupContactName(phoneNumber);

  try {
    const uploaded = await uploadRecording({
      contentUri: data.uri,
      displayName: data.name,
      mimeType: data.mimeType || 'audio/mp4',
      recordedAt,
    });

    const processed = await processRecording({
      storage_path: uploaded.storage_path,
      duration_sec: Math.round(data.duration / 1000),
      original_filename: data.name,
      recorded_at: recordedAt,
      phone_number: phoneNumber,
      client_request_id: deterministicRequestId(data.uri),
      customer_name_hint: contactName,
    });

    const sent = await sendCustomerLogToGroup({
      id: processed.customer_log.id,
      group_id: data.groupId ?? null,
    });

    hideProgressOverlay();
    showSuccessOverlay();

    if (__DEV__) {
      console.log(
        '[AutoSubmit] success',
        processed.customer_log.id,
        processed.customer_log.customer_name,
        'group=',
        sent.group_title,
        sent.created_group ? '(default created)' : '',
        'backfilled=',
        sent.backfilled_count ?? 0,
      );
    }
  } catch (e) {
    hideProgressOverlay();
    logError('AutoSubmit', e, {
      name: data.name,
      duration: data.duration,
      phoneNumber,
      hasContact: contactName != null,
      groupId: data.groupId ?? null,
    });
    // Future: enqueue retry / show error notification.
  }
}
