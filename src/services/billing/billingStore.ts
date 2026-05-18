import { AppState, DeviceEventEmitter } from 'react-native';

import { ApiError } from '../api/client';
import { isLoggedIn } from '../auth/session';
import { logError } from '../logger/errorLog';
import { fetchAuthProfile, type AuthProfile } from './api';

/**
 * In-memory plan + usage cache. Refreshed on:
 *  - app start (after session restore)
 *  - app foreground transition
 *  - WebView redirect to /billing.html?success=1 (handled in WebViewHost)
 *  - manual call from gating UI
 *
 * Other components subscribe via DeviceEventEmitter on
 * BILLING_PROFILE_UPDATED_EVENT and re-render their entitlement / usage UI.
 *
 * Anything stale-tolerant (post-call gating modal copy, usage indicator)
 * reads the cache synchronously via `getCachedProfile()`. The pre-call
 * gating check uses `ensureFreshProfile()` to refetch if cache is older
 * than ~30s.
 */

export const BILLING_PROFILE_UPDATED_EVENT = 'youngman.billing.profileUpdated';

interface CacheEntry {
  profile: AuthProfile;
  fetchedAt: number; // ms epoch
}

let cache: CacheEntry | null = null;
let inflight: Promise<AuthProfile | null> | null = null;

export function getCachedProfile(): AuthProfile | null {
  return cache?.profile ?? null;
}

export function clearCachedProfile(): void {
  cache = null;
}

/** Always hit the server. Use sparingly — prefer `ensureFreshProfile()`. */
export async function refreshProfile(): Promise<AuthProfile | null> {
  if (!isLoggedIn()) {
    cache = null;
    return null;
  }
  // De-dupe concurrent refreshes — the post-call autoSubmit task and the
  // WebView success-URL handler may both fire near-simultaneously.
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    try {
      const profile = await fetchAuthProfile();
      cache = { profile, fetchedAt: Date.now() };
      DeviceEventEmitter.emit(BILLING_PROFILE_UPDATED_EVENT, profile);
      if (__DEV__) {
        console.log(
          '[Billing] profile',
          profile.plan,
          profile.plan_status,
          `${profile.summary_used}/${profile.summary_limit ?? '∞'}`,
        );
      }
      return profile;
    } catch (e) {
      // Non-401 errors mean we keep showing the cached value (or nothing).
      // 401 is already handled by api/client.ts auto-refresh.
      if (e instanceof ApiError && e.httpStatus !== 401) {
        logError('Billing.refresh', e);
      }
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const FRESH_WINDOW_MS = 30_000;

/** Returns the cached profile if it's recent, otherwise refetches. */
export async function ensureFreshProfile(): Promise<AuthProfile | null> {
  if (cache && Date.now() - cache.fetchedAt < FRESH_WINDOW_MS) {
    return cache.profile;
  }
  return refreshProfile();
}

// === entitlement helpers (consumed by gating UI / pre-call check) ====

export interface SummaryGate {
  /** `true` = user can run AI summary right now (no charge / under quota). */
  allowed: boolean;
  /** Reason the gate is closed — drives the modal copy. */
  reason?:
    | 'not_logged_in'
    | 'plan_free'
    | 'trial_exhausted'
    | 'plus_quota_exceeded'
    | 'past_due'
    | 'cancelled_expired';
}

function isUnlimited(profile: AuthProfile): boolean {
  return profile.summary_limit == null;
}

function quotaRemaining(profile: AuthProfile): number {
  if (isUnlimited(profile)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (profile.summary_limit ?? 0) - profile.summary_used);
}

export function evaluateSummaryGate(profile: AuthProfile | null): SummaryGate {
  if (!profile) {
    return { allowed: false, reason: 'not_logged_in' };
  }
  // Past due / cancelled-and-expired both lock features. (Cancelled but
  // still within current_period_end keeps active=true server-side.)
  if (profile.plan_status === 'past_due') {
    return { allowed: false, reason: 'past_due' };
  }
  if (profile.plan_status === 'cancelled') {
    return { allowed: false, reason: 'cancelled_expired' };
  }
  if (profile.plan === 'free') {
    return { allowed: false, reason: 'plan_free' };
  }
  if (profile.plan_status === 'trialing' && quotaRemaining(profile) <= 0) {
    return { allowed: false, reason: 'trial_exhausted' };
  }
  if (quotaRemaining(profile) <= 0 && !isUnlimited(profile)) {
    return { allowed: false, reason: 'plus_quota_exceeded' };
  }
  return { allowed: true };
}

/** UI helper — "이번 달 7/20" 같은 짧은 표시용 문자열. null = 표시 안 함. */
export function usageDisplayString(profile: AuthProfile | null): string | null {
  if (!profile) return null;
  if (isUnlimited(profile)) {
    return 'AI 요약 무제한';
  }
  if (profile.plan_status === 'trialing') {
    return `체험 ${quotaRemaining(profile)}회 남음`;
  }
  return `이번 달 ${profile.summary_used}/${profile.summary_limit}회`;
}

// === lifecycle hookup ===============================================

let attached = false;
let appStateSub: { remove: () => void } | null = null;

/** Wire the cache to app lifecycle — call once on app start. Idempotent. */
export function attachBillingLifecycle(): void {
  if (attached) return;
  attached = true;

  // Refresh whenever the app comes to the foreground. AppState 'active' is
  // the natural moment for the user to check / use entitled features.
  appStateSub = AppState.addEventListener('change', state => {
    if (state === 'active' && isLoggedIn()) {
      void refreshProfile();
    }
  });
}

export function detachBillingLifecycle(): void {
  appStateSub?.remove();
  appStateSub = null;
  attached = false;
}
