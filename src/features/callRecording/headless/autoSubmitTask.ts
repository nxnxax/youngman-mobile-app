import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError, ensureAuthFresh } from '../../../services/api/client';
import { restoreSession, isLoggedIn } from '../../../services/auth/session';
import {
  ensureFreshProfile,
  evaluateSummaryGate,
} from '../../../services/billing/billingStore';
import { lookupContactName } from '../../../services/contacts/lookupContact';
import { logError } from '../../../services/logger/errorLog';
import {
  putIfAbsent as outboxPutIfAbsent,
  update as outboxUpdate,
  type OutboxItem,
} from '../../../services/outbox/outboxStore';
import { hideProgressOverlay } from '../../../services/overlay/progressOverlay';
import { deterministicRequestId } from '../../../shared/uuid';
import { processRecording } from '../api/processRecording';
import { fetchLedgerGroups, sendCustomerLogToGroup } from '../api/records';
import { uploadRecording } from '../api/uploadRecording';
import { extractPhoneNumber } from '../scanner/heuristics';

/** Flag set by this headless task when an auto-submit run fails with a
 *  *hard* auth failure (refresh_token invalid 등). WebViewHost picks this
 *  up on mount/foreground and pops the SESSION_DEAD prompt.
 *
 *  Policy 1 (2026-05-20 사장님): "HTTP 401 사용자 노출 금지". 따라서 일반
 *  401 / auth_pending 케이스는 이 flag 를 세우지 않는다 — 그건 outbox 의
 *  pending_auth 보존 + outboxProcessor 자동 재시도가 잡고, 사용자에겐
 *  PENDING flag (아래) 만 보여서 "세션 준비 중" 안내. */
export const AUTO_SUBMIT_AUTH_FAIL_FLAG = '@youngman/autoSubmit_authFail_v1';

/** auth_pending (또는 일반 401) 케이스 — outbox 에 pending_auth 보존됐고
 *  로그인/refresh 완료되면 자동 재시도 예정. 사용자에겐 친절한 "세션 준비
 *  중" toast 만 표시. */
export const AUTO_SUBMIT_PENDING_FLAG = '@youngman/autoSubmit_pending_v1';

/** Hand-off key. The headless task can't touch the in-memory jobStore
 *  (different React context lifetime), so it writes the active job here.
 *  WebViewHost reads + clears this on mount / AppState 'active' and
 *  registers it with jobStore so the FloatingProcessingCard appears. */
export const PENDING_JOB_KEY = '@youngman/pendingJob_v1';

export interface PendingJobPayload {
  jobId: string;
  metadata: {
    phoneNumber: string | null;
    displayName: string;
    durationSec: number;
    fromAutoSubmit: boolean;
  };
  /** Ledger group id selected upstream. Bound to the customer_log after
   *  the summary completes (FCM handler issues sendCustomerLogToGroup). */
  groupId: string | null;
}

export interface AutoSubmitTaskPayload {
  uri: string;
  name: string;
  duration: number; // ms
  dateAdded: number; // unix seconds
  mimeType: string;
  /** Optional ledger group id selected from the glass overlay dropdown. */
  groupId?: string | null;
  /** 사장님 정책 (2026-05-21): true 면 server 가 customer_log 즉시 mirror 안 하고
   *  ready_to_review 로 보존. auto-dismiss / 사용자 액션 없음 케이스. 미확인
   *  요약 화면에서 사용자가 나중에 confirm. */
  pendingReview?: boolean;
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
  // 사장님 정책 (2026-05-20): 최초 실행 시 RN 에 토큰이 없는 것은 정상.
  // 토큰 없음 ≠ 실패 = pending_auth. 통화 작업을 outbox 에 detected 로
  // 보존 + AUTO_SUBMIT_PENDING_FLAG 세팅. Auth.login / native refresh 로
  // 토큰 준비되는 즉시 outboxProcessor 가 자동 재개. 최초 사용자 첫 통화도
  // 절대 잃지 않음.
  if (!isLoggedIn()) {
    hideProgressOverlay();
    logError('AutoSubmit', 'no session — saving to outbox as pending_auth', {
      name: data.name,
      duration: data.duration,
    });
    const recordedAt = toIso8601Local(data.dateAdded);
    const phoneNumber = extractPhoneNumber(data.name);
    const localId = deterministicRequestId(data.uri);
    try {
      await outboxPutIfAbsent({
        localId,
        fileUri: data.uri,
        displayName: data.name,
        durationSec: Math.round(data.duration / 1000),
        mimeType: data.mimeType || 'audio/mp4',
        phoneNumber,
        contactName: null, // lookupContactName 은 권한 필요 — 후에 retry 시 채움
        detectedAt: Date.now(),
        audioSha256: null,
        status: 'pending_auth',
        retryCount: 0,
        lastError: 'no session at task entry — waiting for Auth.login',
        serverJobId: null,
        groupId: data.groupId ?? null,
        recordedAt,
      });
      await AsyncStorage.setItem(
        AUTO_SUBMIT_PENDING_FLAG,
        String(Date.now()),
      );
    } catch (e) {
      logError('AutoSubmit.outbox.put.noSession', e, { localId });
    }
    return;
  }

  // 사장님 정책 (2026-05-21 ChatGPT 근본 방향): AutoSubmit 시작 전 3-step
  // verify. token + header + light ping. 통과 못 하면 upload/process 시작
  // 금지 → orphan job 절대 안 생김. 실패 시 outbox 에 pending_auth 보존 →
  // outboxProcessor 가 Auth.login / native refresh 후 자동 재시도.
  const authFresh = await ensureAuthFresh();
  if (!authFresh.ok) {
    hideProgressOverlay();
    logError(
      'AutoSubmit',
      new Error(`ensureAuthFresh failed: ${authFresh.reason} — saving to outbox`),
      { name: data.name, duration: data.duration },
    );
    const recordedAt = toIso8601Local(data.dateAdded);
    const phoneNumber = extractPhoneNumber(data.name);
    const localId = deterministicRequestId(data.uri);
    try {
      await outboxPutIfAbsent({
        localId,
        fileUri: data.uri,
        displayName: data.name,
        durationSec: Math.round(data.duration / 1000),
        mimeType: data.mimeType || 'audio/mp4',
        phoneNumber,
        contactName: null,
        detectedAt: Date.now(),
        audioSha256: null,
        status: 'pending_auth',
        retryCount: 0,
        lastError: `ensureAuthFresh: ${authFresh.reason}`,
        serverJobId: null,
        groupId: data.groupId ?? null,
        recordedAt,
      });
      await AsyncStorage.setItem(AUTO_SUBMIT_PENDING_FLAG, String(Date.now()));
    } catch (e) {
      logError('AutoSubmit.outbox.put.authFresh', e, { localId });
    }
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
  // localId = deterministic per file URI. Same recording re-entering the
  // task (e.g. PostCallScan re-fires, or app restart while the row is still
  // pending) maps to the same outbox row — putIfAbsent stays a no-op so
  // status / retry_count don't get clobbered.
  const localId = deterministicRequestId(data.uri);
  const durationSec = Math.round(data.duration / 1000);

  // 사장님 정책 (2026-05-21 비상): 모달 "양식으로 전송" 직격 케이스 fix.
  // server (commit 37c3261) 가 group_id 누락 시 default 그룹 자동 채우는
  // fallback 을 깔았지만 사장님 PoC 결과 customer_log INSERT 안 됨 (callback
  // review_required=1 분기 잔재 추정). native 에서 사장님 main group (또는
  // first) 을 명시 전송해 review_required=0 분기 강제. SummaryReview 의 modal
  // picker default 와 동일 정책 (is_main 우선). fetch 실패 시 null 로 fall
  // back — 옛 동작 유지 (웹팀 fallback 의존).
  let resolvedGroupId: string | null = data.groupId ?? null;
  if (!resolvedGroupId) {
    try {
      const res = await fetchLedgerGroups('customer');
      const main = res.groups.find(g => g.is_main) ?? res.groups[0];
      resolvedGroupId = main?.id ?? null;
    } catch (e) {
      if (__DEV__) {
        console.log(
          '[AutoSubmit] fetchLedgerGroups failed — proceeding without group_id',
          e,
        );
      }
    }
  }

  // Outbox first — durable record before any network. 2026-05-20 비상 원칙:
  // 통화녹음 발견 후엔 무조건 local outbox 에 남긴다. 401 / 네트워크 /
  // WebView 사망 / 앱 종료 어떤 경우에도 잃지 않는다.
  let outboxItem: OutboxItem;
  try {
    outboxItem = await outboxPutIfAbsent({
      localId,
      fileUri: data.uri,
      displayName: data.name,
      durationSec,
      mimeType: data.mimeType || 'audio/mp4',
      phoneNumber,
      contactName,
      detectedAt: Date.now(),
      audioSha256: null,
      status: 'detected',
      retryCount: 0,
      lastError: null,
      serverJobId: null,
      groupId: resolvedGroupId,
      recordedAt,
    });
  } catch (e) {
    // outbox 쓰기 자체가 실패하면 어차피 다음 단계도 못 감. 로그만 남기고
    // 계속 진행 — 인메모리 상태로라도 한 번 시도해 보고, 실패하면 그대로 끝.
    logError('AutoSubmit.outbox.put', e, { localId });
    outboxItem = {
      localId,
      fileUri: data.uri,
      displayName: data.name,
      durationSec,
      mimeType: data.mimeType || 'audio/mp4',
      phoneNumber,
      contactName,
      detectedAt: Date.now(),
      audioSha256: null,
      status: 'detected',
      retryCount: 0,
      lastError: null,
      serverJobId: null,
      groupId: resolvedGroupId,
      recordedAt,
      updatedAt: Date.now(),
    };
  }

  // 사장님 상태머신 정책 (2026-05-20 late):
  // 진행 중 / 완료 / 사용자 종료 / 영구 실패 상태는 모두 skip.
  // autoSubmitTask 는 (detected | pending_auth | failed_retryable |
  //                     user_selected_submit) 만 진행한다.
  const skipStatuses: ReadonlyArray<typeof outboxItem.status> = [
    'modal_shown',           // 사용자 액션 대기 중 — 자동 진행 X
    'user_selected_summary', // 요약보기 선택 — autoSubmit 흐름 아님
    'uploading',             // 진행 중
    'uploaded',              // 서버에 이미 있음
    'processing',            // 서버 처리 중 (process-recording.php 재호출 = 409)
    'ready_to_review',       // 완료, 검토 대기
    'ready',                 // legacy alias
    'saved',                 // 종료
    'dismissed',             // 사용자 취소 (재표시 / 재시도 금지)
    'failed_permanent',      // 영구 실패 (수동 retry 만 허용)
  ];
  if (skipStatuses.includes(outboxItem.status)) {
    hideProgressOverlay();
    if (__DEV__) {
      console.log(
        '[AutoSubmit] outbox item status =',
        outboxItem.status,
        '— skipping',
      );
    }
    return;
  }

  try {
    await outboxUpdate(localId, { status: 'uploading' });
    const uploaded = await uploadRecording({
      contentUri: data.uri,
      displayName: data.name,
      mimeType: data.mimeType || 'audio/mp4',
      recordedAt,
    });
    await outboxUpdate(localId, { status: 'uploaded' });

    // Async path: server returns job_id immediately, processes STT+LLM in
    // the background, and fan-outs the final result via FCM
    // `recording.processed`. We hand the job off to WebViewHost via
    // AsyncStorage so the FloatingProcessingCard can pick it up the next
    // time the app is foregrounded. Group assignment is handled
    // server-side using `client_request_id` + group_id passed up here.
    // 사장님 정책 (2026-05-21 비상 fix, 사장님 직접 제안): "1번 흐름 (모달 →
    // 요약보기 → 양식전송) 이 잘 되면 똑같은 chain 을 백그라운드로 돌려라."
    // SummaryReviewScreen 의 흐름과 100% 동일:
    //   1) processRecording (sync mode) → customer_log row 받음
    //   2) sendCustomerLogToGroup → ledger_records 에 그룹 mirror
    // 옛 processRecordingAsync (audio_pending 흐름) 은 미확인요약 시스템 폐기로
    // sendCustomerLogToGroup 까지 가지 못해 사장님 화면에 데이터 안 보임. sync
    // 흐름은 7-30초 server 처리 동안 headless task 가 wait — 사용자 UI 안 막힘.
    const result = await processRecording({
      storage_path: uploaded.storage_path,
      duration_sec: durationSec,
      original_filename: data.name,
      recorded_at: recordedAt,
      phone_number: phoneNumber,
      client_request_id: localId,
      customer_name_hint: contactName,
    });

    await outboxUpdate(localId, {
      status: 'processing',
      serverJobId: result.customer_log.id,
    });
    try {
      await AsyncStorage.removeItem(PENDING_JOB_KEY);
    } catch {}

    // 2단계: ledger 그룹 mirror. SummaryReview 의 onSave 와 동일 호출.
    // 실패 시 customer_log 는 이미 INSERT 됐고 ledger mirror 만 빠짐 →
    // outboxProcessor 다음 사이클 retry 또는 사장님이 수동으로 그룹 보내기.
    try {
      await sendCustomerLogToGroup({
        id: result.customer_log.id,
        group_id: resolvedGroupId,
      });
      await outboxUpdate(localId, { status: 'saved' });
    } catch (mirrorErr) {
      logError('AutoSubmit.sendCustomerLogToGroup', mirrorErr, {
        customerLogId: result.customer_log.id,
        groupId: resolvedGroupId,
      });
      // customer_log 자체는 server 에 들어감 — failed_retryable 보다는
      // ready_to_review 로 마킹해 사장님이 화면에서 수동 그룹 전송 가능.
      await outboxUpdate(localId, { status: 'ready_to_review' });
    }

    hideProgressOverlay();

    if (__DEV__) {
      console.log(
        '[AutoSubmit] customer_log saved',
        result.customer_log.id,
        '→ group',
        resolvedGroupId,
      );
    }
  } catch (e) {
    hideProgressOverlay();
    const errMessage = e instanceof Error ? e.message : String(e);
    const isAuthPending =
      e instanceof ApiError && e.code === 'auth_pending';
    const isHardAuthFail =
      e instanceof ApiError &&
      e.code !== 'auth_pending' &&
      (e.httpStatus === 401 || e.code === 'unauthorized');
    const isDuplicate = e instanceof ApiError && e.httpStatus === 409;
    const isLlmParseFail = e instanceof ApiError && e.httpStatus === 502;

    // 사장님 정책 (2026-05-20 late): auth_pending / 409 (중복) 는 정상 흐름.
    // errors.log 에 기록 X (사용자가 "에러" 로 오해 방지). 진짜 실패만 기록.
    //
    // Play Store PII compliance (2026-05-21 audit): phoneNumber 직접 기록 X.
    // hasPhone 플래그 + 끝 4자리만 (예: "...5678") 으로 redact. errors.log 가
    // 사용자 노출되는 화면이므로 PII 최소화. hasContact 는 디버그 가치 유지.
    if (!isAuthPending && !isDuplicate) {
      const phoneRedacted = phoneNumber
        ? `...${phoneNumber.replace(/\D/g, '').slice(-4)}`
        : null;
      logError('AutoSubmit', e, {
        name: data.name,
        duration: data.duration,
        phoneRedacted,
        hasContact: contactName != null,
        groupId: data.groupId ?? null,
        localId,
      });
    }

    const newRetryCount = outboxItem.retryCount + 1;
    let newStatus: OutboxItem['status'];
    if (isAuthPending || isHardAuthFail) {
      newStatus = 'pending_auth';
    } else if (isDuplicate) {
      // 서버가 이미 처리 중. 클라이언트는 더 이상 process-recording.php 안 부름.
      // FCM (call_summary_ready) / job-status.php 폴링이 결과 알려줄 것.
      newStatus = 'processing';
    } else if (isLlmParseFail) {
      newStatus = newRetryCount >= 2 ? 'failed_permanent' : 'failed_retryable';
    } else {
      newStatus = newRetryCount >= 4 ? 'failed_permanent' : 'failed_retryable';
    }

    await outboxUpdate(localId, {
      status: newStatus,
      retryCount: newRetryCount,
      lastError: errMessage,
    });

    if (isAuthPending) {
      // 세션 준비 중 (영맨 로그인 미완료 / refreshToken 누락). 사용자에게
      // SESSION_DEAD 모달 띄우지 말고 친절한 "세션 준비 중" toast 만 안내.
      // outboxProcessor 가 로그인/refresh 완료 후 자동 재시도.
      try {
        await AsyncStorage.setItem(
          AUTO_SUBMIT_PENDING_FLAG,
          String(Date.now()),
        );
      } catch {
        // best-effort
      }
    } else if (isHardAuthFail) {
      // refresh_token 자체 무효 등 진짜 재로그인 필요 케이스만 SESSION_DEAD.
      try {
        await AsyncStorage.setItem(
          AUTO_SUBMIT_AUTH_FAIL_FLAG,
          String(Date.now()),
        );
      } catch {
        // best-effort
      }
    }
  }
}
