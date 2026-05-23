// 미확인 요약 (recording_jobs.status='ready_to_review') 관련 API.
//
// 영맨 웹팀 ship (commit 89a7bf4) 의 3개 endpoint 호출.
// 사장님 정책 (2026-05-21): review_mode='review' 인 사용자는 통화 종료 후
// summary 가 customer_log 에 자동 저장되지 않고 ready_to_review 로 대기.
// 이 화면에서 사용자가 확인 후 confirm.

import { apiGet, apiPost } from '../../../services/api/client';

export interface UnreviewedItem {
  /** recording_jobs.id (UUID). preview/confirm 호출 시 사용. */
  id: string;
  /** 사장님 정책 (2026-05-21 STT On-Demand): audio_pending 도 미확인 요약에
   *  포함. server 의 list_unreviewed 확장으로 두 상태 모두 반환됨. */
  status: 'ready_to_review' | 'audio_pending';
  customer_name: string | null;
  /** summary 의 180자 미만 cut. audio_pending 이면 placeholder. */
  summary_preview: string;
  duration_sec: number;
  /** ISO8601. */
  recorded_at: string;
  group_id: string | null;
  /** STT 완료 여부 (audio_pending=false, ready_to_review=true). */
  stt_done?: boolean;
  /** 통화 상대 번호. server 가 새 list_unreviewed 응답에 포함. */
  phone_number?: string | null;
}

interface ListResponse {
  status: 'ok';
  items: ReadonlyArray<UnreviewedItem>;
  count: number;
}

/** 사장님 정책 (2026-05-21 STT 흐름 근본 구조 개선, 웹팀 commit 4256cbd):
 *  trigger_summarize / confirm / summary_status 모두 같은 detail 필드 포함.
 *  ok/processing/error_code flag 로 client 분기. top-level customer_name /
 *  duration_sec / recorded_at / phone_number 도 항상 포함 (summary 안 거침). */
export interface UnreviewedDetail {
  status: 'ok';
  /** true = 결과 준비됨. false + processing=true → polling. false + processing=false → 실패. */
  ok: boolean;
  processing: boolean;
  error_code?: 'PROCESSING' | 'STT_FAILED' | null;
  retryable?: boolean;
  retry_after_seconds?: number;
  job_id: string;
  job_status:
    | 'audio_pending'
    | 'queued'
    | 'stt_processing'
    | 'llm_processing'
    | 'ready_to_review'
    | 'saved'
    | 'failed_permanent';
  review_required?: boolean;
  duration_sec: number;
  recorded_at: string | null;
  group_id?: string | null;
  phone_number: string | null;
  /** Top-level — 항상 포함 (summary 가 null 이어도). */
  customer_name: string;
  summary: {
    customer_name: string;
    summary: string;
    interest: string;
    inquiry: string;
    budget_condition: string;
    next_action: string;
    transcript: string;
    ai_model: string;
  } | null;
  last_error?: string;
  customer_log_id?: string | null;
}

export interface ConfirmOverrides {
  customer_name?: string;
  summary?: string;
  phone_number?: string;
  interest?: string;
  inquiry?: string;
  budget_condition?: string;
  next_action?: string;
}

interface ConfirmResponse {
  status: 'ok';
  job_id: string;
  job_status: 'saved';
  customer_log_id: string;
  customer_log: Record<string, unknown>;
  /** Idempotency hit — 이미 confirm 한 작업. */
  error_code?: 'JOB_EXISTS';
  duplicate?: boolean;
}

export async function listUnreviewed(
  limit: number = 50,
): Promise<ListResponse> {
  return apiGet<ListResponse>(
    `/records.php?resource=customer-log&action=list_unreviewed&limit=${limit}`,
  );
}

/** 사장님 정책 (2026-05-21): cafe24 페이지의 "미확인 요약" 메뉴 항목에 빨간
 *  badge 표시용. server 의 count 필드는 distinct (고유 번호 기준) 일 수
 *  있어서 신뢰하지 않고 items.length 로 진짜 '건수' 표시. 사장님 정책:
 *  같은 번호여도 통화 건수마다 1. */
export async function fetchUnreviewedCount(): Promise<number> {
  try {
    const res = await apiGet<ListResponse>(
      `/records.php?resource=customer-log&action=list_unreviewed&limit=200`,
    );
    return res.items?.length ?? 0;
  } catch {
    return 0;
  }
}

export async function previewUnreviewed(
  jobId: string,
): Promise<UnreviewedDetail> {
  return apiGet<UnreviewedDetail>(
    `/records.php?resource=customer-log&action=preview&job_id=${encodeURIComponent(jobId)}`,
  );
}

export async function confirmUnreviewed(
  jobId: string,
  overrides?: ConfirmOverrides,
): Promise<ConfirmResponse> {
  return apiPost<ConfirmResponse>('/records.php?resource=customer-log', {
    action: 'confirm',
    job_id: jobId,
    overrides: overrides ?? {},
  });
}

/** 사장님 정책 (2026-05-21): 미확인 요약 화면에서 사용자가 선택 삭제.
 *  server 의 recording_jobs row 를 'dismissed' 상태로 변경 또는 hard
 *  delete. 웹팀과 endpoint 명세 협의 필요. */
export async function discardUnreviewed(jobId: string): Promise<void> {
  await apiPost('/records.php?resource=customer-log', {
    action: 'discard',
    job_id: jobId,
  });
}

/** 사장님 정책 (2026-05-21): 사용자가 "요약보기" 누를 때 server 가 STT
 *  발동. 캐시 있으면 즉시 ok=true 반환 (30초 안). 처리 길어지면 processing=true
 *  반환 → caller 가 5초 후 summary_status polling.
 *
 *  사장님 정책 (v43 2026-05-23 spec 변경 #1): auto_confirm 파라미터 추가.
 *    - false (default): 기존 흐름 — callback 도착 시 ready_to_review.
 *    - true: callback 도착 시 영맨이 자동 customer_log INSERT + send_to_group
 *      → status='saved'. 사용자 검토 없이 바로 고객관리대장 들어감.
 *    "양식에 전송" 모달 click 시 true. "요약보기" 흐름은 false. */
export async function triggerSummarize(
  jobId: string,
  options?: { autoConfirm?: boolean },
): Promise<UnreviewedDetail> {
  return apiPost<UnreviewedDetail>('/records.php?resource=customer-log', {
    action: 'trigger_summarize',
    job_id: jobId,
    auto_confirm: options?.autoConfirm ?? false,
  });
}

/** 사장님 정책 (2026-05-21 웹팀 commit 4256cbd): 빠른 row 조회 (<500ms).
 *  trigger_summarize 가 processing=true 반환 시 5초 간격으로 polling. */
export async function fetchSummaryStatus(jobId: string): Promise<UnreviewedDetail> {
  return apiGet<UnreviewedDetail>(
    `/records.php?resource=customer-log&action=summary_status&job_id=${encodeURIComponent(jobId)}`,
  );
}
