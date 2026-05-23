import { apiPost } from '../../../services/api/client';
import type { ProcessRecordingResponse } from './types';

// 사장님 정책 (2026-05-23 spec): /process-recording.php 가 lazy-STT 모드로 변경.
// 통화 종료 직후 자동 STT 안 함. audio_pending 응답만 받고 사용자 trigger 시점에
// trigger_summarize 로 STT 시작. customer_log 필드 없음, job_id + job_status 만.
//
// 사장님 정책 (2026-05-23 웹팀 회신 추가): audio_sha256 dedup hit 시
//   { duplicate: true, error_code: 'JOB_DUPLICATE', job_id, ... } 반환.
//   같은 audio 재전송 케이스 (PoC 중 재시도 등) 만 — 정상 통화는 미발생.
//   client 는 동일 job_id 로 UnreviewedPreview navigate (Toast 로 알림).
export interface ProcessRecordingAudioPendingResponse {
  status: 'ok';
  ok: true;
  job_id: string;
  job_status: 'audio_pending';
  mode?: 'audio_pending';
  placeholder?: false;
  server_elapsed_ms?: number;
  duplicate?: boolean;
  error_code?: 'JOB_DUPLICATE' | string;
}

export interface ProcessRecordingInput {
  storage_path: string;
  duration_sec: number;
  original_filename: string;
  recorded_at: string;
  phone_number: string | null;
  client_request_id: string;
  /** Optional: app-resolved contact name from phone book lookup. Server uses
   *  this as ground truth and overrides LLM customer_name extraction. */
  customer_name_hint?: string | null;
  /** Optional ledger group id to attach when summary completes. Server
   *  stores this on `recording_jobs.group_id` and echoes it in the
   *  `call_summary_ready` FCM payload — the client then calls
   *  sendCustomerLogToGroup without having to track state across the
   *  background processing window. Hybrid hand-off agreed with 영맨 서버측
   *  to avoid touching the lock-in customer_log_send_to_group flow. */
  group_id?: string | null;
  /** 사장님 정책 (2026-05-21 웹팀 ship): true 면 server 가 customer_log 즉시
   *  mirror 하지 않고 ready_to_review 상태로 보존. 미확인 요약 화면 노출용.
   *  - true: auto-dismiss / 취소 시 (사용자가 명시적으로 그룹 전송 안 한 경우)
   *  - false (or 누락) + group_id 명시: 즉시 mirror (기존 동작)
   *  - false (or 누락) + group_id 없음: 서버가 ready_to_review 로 처리 */
  pending_review?: boolean;
}

/**
 * Server contract: when `mode: 'async'` is set, /process-recording.php
 * returns HTTP 202 with { ok, status: 'queued', job_id, duplicate? } and
 * runs STT + LLM in the background. The client tracks progress via
 * /job-status.php polling (or FCM in background). When omitted (or
 * `mode: 'sync'`), the legacy synchronous flow returns the full
 * customer_log 2-3 minutes later — kept for backward compat but
 * deprecated by 영맨 서버측 (commit 1069ef7).
 */
export interface ProcessRecordingAsyncResponse {
  ok: true;
  status: 'queued';
  job_id: string;
  /** Server idempotency hit — same audio_sha256 already processed. */
  duplicate?: boolean;
}

export async function processRecording(
  input: ProcessRecordingInput,
): Promise<ProcessRecordingResponse> {
  return apiPost<ProcessRecordingResponse>('/process-recording.php', input);
}

/** 사장님 정책 (2026-05-23 spec): lazy-STT 모드. 영맨 backend 가 audio_pending
 *  으로 응답 (customer_log 없음). 사용자가 "요약보기" 누를 때 trigger_summarize
 *  호출해서 STT 시작. v39+ 호환. */
export async function processRecordingAudioPending(
  input: ProcessRecordingInput,
): Promise<ProcessRecordingAudioPendingResponse> {
  return apiPost<ProcessRecordingAudioPendingResponse>(
    '/process-recording.php',
    input,
  );
}

/** Async path — returns immediately with a job_id. Caller polls
 *  /job-status.php (or waits for FCM `recording.processed`) for the
 *  final customer_log. */
export async function processRecordingAsync(
  input: ProcessRecordingInput,
): Promise<ProcessRecordingAsyncResponse> {
  return apiPost<ProcessRecordingAsyncResponse>('/process-recording.php', {
    ...input,
    mode: 'async',
  });
}
