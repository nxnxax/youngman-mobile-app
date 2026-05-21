import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { ApiError } from '../../services/api/client';
import { logError } from '../../services/logger/errorLog';
import {
  fetchJobStatus,
  isTerminal,
} from '../callRecording/api/jobStatus';
import {
  clearActiveJob,
  getActiveJob,
  updateActiveJob,
} from './jobStore';

const MAX_POLLING_MS = 5 * 60 * 1000; // 5min, then bail to FCM

/** Pick the next poll interval based on elapsed time. Fast at first (user
 *  is actively watching), backs off as the job drags on (cafe24 load +
 *  user likely backgrounded the app). Jitter prevents thundering herd. */
function nextDelay(elapsedMs: number): number {
  let base: number;
  if (elapsedMs < 10_000) base = 1_500;
  else if (elapsedMs < 60_000) base = 2_000;
  else base = 3_000;
  // ±200ms jitter
  return base + Math.floor((Math.random() - 0.5) * 400);
}

/**
 * Drive a polling loop against /job-status.php for the currently active
 * job. Stops on terminal status, AppState 'background', or 5-min timeout.
 * Resumes on 'active' transition (catch-up poll + restart).
 *
 * Idempotent — mount this once at the WebViewHost root.
 */
export function useJobPolling(): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef<number>(0);
  const stoppedRef = useRef<boolean>(false);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const tick = async () => {
      if (stoppedRef.current) return;
      const active = getActiveJob();
      if (!active) return;

      const elapsed = Date.now() - startedAtRef.current;
      if (elapsed > MAX_POLLING_MS) {
        // 사장님 정책 (2026-05-21 근본 원인): polling 멈추고 jobStore 도 clear.
        // 안 그러면 FloatingProcessingCard 가 영원히 sticky 로 떠 있어서 헤더
        // 가림. 결과는 미확인 요약 / FCM 알림으로 따로 받음.
        logError(
          'JobPolling',
          new Error(`5min timeout — handing off to FCM (job=${active.jobId})`),
        );
        clearActiveJob();
        return;
      }

      try {
        const job = await fetchJobStatus(active.jobId);
        if (stoppedRef.current) return;
        updateActiveJob(job);
        if (isTerminal(job.status)) {
          // Card UI will pick up the terminal state via JOB_STORE_UPDATED.
          // It decides when to dismiss (user reads the result first).
          return;
        }
      } catch (e) {
        // 401 / 403 / network — keep polling but slow down. 401 recovery
        // is handled inside the api client; if the session is truly dead,
        // the SESSION_DEAD modal fires and Path B (cron worker) finishes
        // the job server-side. We just bail to FCM mode.
        if (e instanceof ApiError && (e.httpStatus === 401 || e.httpStatus === 403)) {
          // 사장님 정책 (2026-05-21 근본 원인): 401/403 hand-off 시도 jobStore clear.
          // FloatingProcessingCard sticky 방지. 결과는 FCM / 미확인 요약에서.
          logError(
            'JobPolling',
            new Error(`auth ${e.httpStatus} — handing off to FCM (job=${active.jobId})`),
          );
          clearActiveJob();
          return;
        }
        if (__DEV__) console.log('[JobPolling] tick failed', e);
      }

      const delay = nextDelay(elapsed);
      timerRef.current = setTimeout(tick, delay);
    };

    const start = () => {
      const active = getActiveJob();
      if (!active) return;
      stoppedRef.current = false;
      startedAtRef.current = startedAtRef.current || Date.now();
      clearTimer();
      void tick();
    };

    const stop = () => {
      stoppedRef.current = true;
      clearTimer();
    };

    // Re-evaluate whenever a new job is set or the current one is cleared.
    const sub = require('react-native').DeviceEventEmitter.addListener(
      'youngman.jobStore.updated',
      (payload: unknown) => {
        if (!payload) {
          stop();
          startedAtRef.current = 0;
          return;
        }
        if (startedAtRef.current === 0) {
          start();
        }
      },
    );

    // AppState — pause when backgrounded (FCM takes over), catch-up on resume.
    const appStateSub = AppState.addEventListener('change', state => {
      if (state === 'background' || state === 'inactive') {
        stop();
      } else if (state === 'active' && getActiveJob()) {
        start();
      }
    });

    // Initial start in case a job is already active (e.g. WebViewHost remount)
    if (getActiveJob()) start();

    return () => {
      stop();
      sub.remove();
      appStateSub.remove();
    };
  }, []);
}

/** Helper for the card / navigation layer — clears the store and any
 *  in-flight timers. */
export function dismissActiveJob(): void {
  clearActiveJob();
}
