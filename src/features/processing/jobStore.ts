import { DeviceEventEmitter } from 'react-native';

import type { JobInfo } from '../callRecording/api/jobStatus';

/**
 * Active processing-job registry. One job at a time for now (영맨 사용자가
 * 동시 통화 시나리오는 드뭄). Carrying call-side metadata (phone, name,
 * duration) lets the floating card show context without an extra API
 * round-trip.
 */

export const JOB_STORE_UPDATED_EVENT = 'youngman.jobStore.updated';

export interface JobMetadata {
  /** Phone number extracted from the recording filename (e.g. "010-1234-5678") */
  phoneNumber: string | null;
  /** Contact name from phone book lookup, falls back to the phone number */
  displayName: string;
  /** Original audio duration in seconds — drives the card's "X분 X초 통화" line */
  durationSec: number;
  /** Set when AutoSubmit was used (vs 요약보기 path). UI tweaks the post-
   *  completion landing accordingly: AutoSubmit → SuccessOverlay only,
   *  ConfirmRecording → SummaryReview screen. */
  fromAutoSubmit: boolean;
}

export interface ActiveJob {
  jobId: string;
  metadata: JobMetadata;
  /** Latest known server state, undefined until first poll lands */
  job?: JobInfo;
  /** Local timestamp of last successful poll — used to detect stale state */
  lastPolledAt: number;
}

let active: ActiveJob | null = null;

export function getActiveJob(): ActiveJob | null {
  return active;
}

export function setActiveJob(jobId: string, metadata: JobMetadata): void {
  active = { jobId, metadata, lastPolledAt: 0 };
  DeviceEventEmitter.emit(JOB_STORE_UPDATED_EVENT, active);
}

export function updateActiveJob(job: JobInfo): void {
  if (!active || active.jobId !== job.id) return;
  active = { ...active, job, lastPolledAt: Date.now() };
  DeviceEventEmitter.emit(JOB_STORE_UPDATED_EVENT, active);
}

export function clearActiveJob(): void {
  if (!active) return;
  active = null;
  DeviceEventEmitter.emit(JOB_STORE_UPDATED_EVENT, null);
}
