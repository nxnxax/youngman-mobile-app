import { restoreSession, isLoggedIn } from '../../../services/auth/session';
import { lookupContactName } from '../../../services/contacts/lookupContact';
import { logError } from '../../../services/logger/errorLog';
import { showSuccessOverlay } from '../../../services/overlay/showSuccessOverlay';
import { uuidv4 } from '../../../shared/uuid';
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
    logError('AutoSubmit', 'no session — task aborting', {
      name: data.name,
      duration: data.duration,
    });
    return;
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
      client_request_id: uuidv4(),
      customer_name_hint: contactName,
    });

    const sent = await sendCustomerLogToGroup({
      id: processed.customer_log.id,
      group_id: data.groupId ?? null,
    });

    showSuccessOverlay();

    if (__DEV__) {
      console.log(
        '[AutoSubmit] success',
        processed.customer_log.id,
        processed.customer_log.customer_name,
        'group=',
        sent.group_title,
        sent.created_group ? '(default created)' : '',
      );
    }
  } catch (e) {
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
