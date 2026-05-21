import { apiGet } from '../../../services/api/client';

/**
 * Server-side job lifecycle for AI summary processing. The server runs
 * STT + LLM asynchronously and exposes status via /job-status.php so the
 * app can show progress instead of staring at a 2-3 minute spinner.
 *
 * Contract owner: 영맨 서버팀 (commits 15f0959 / 97caac3 / 1069ef7).
 */
export type JobStatus =
  | 'queued'
  | 'uploading'
  | 'stt_processing'
  | 'llm_processing'
  | 'completed'
  | 'failed'
  | 'failed_retryable'
  | 'failed_permanent';

export interface JobInfo {
  id: string;
  status: JobStatus;
  /** Korean human-readable label, server-translated (e.g. "음성 텍스트 변환 중...") */
  step_label: string;
  /** 0-100, auto-stepped by server on each status transition */
  progress_pct: number;
  /** Set on `completed` so the client can navigate to the saved row */
  customer_log_id: string | null;
  duration_sec: number;
  retry_count: number;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}

interface JobStatusResponse {
  ok: true;
  job: JobInfo;
}

/** Fetch the current state of a job. The auth gate is owner_email-bound on
 *  the server, so a 401 / 403 means the job doesn't belong to us (or the
 *  session is dead — the api client's 401 recovery kicks in either way). */
export async function fetchJobStatus(jobId: string): Promise<JobInfo> {
  const res = await apiGet<JobStatusResponse>(
    `/job-status.php?job_id=${encodeURIComponent(jobId)}`,
  );
  return res.job;
}

/** True when the job is in a terminal state — polling should stop. */
export function isTerminal(status: JobStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'failed_permanent'
  );
}

/** True when the user should be told "we'll keep trying" vs hard failure. */
export function isRetrying(status: JobStatus): boolean {
  return status === 'failed_retryable';
}
