import { AppState, DeviceEventEmitter, NativeModules, Platform } from 'react-native';

import { listCustomerLogs } from '../api/records';
import type { CustomerLogRow } from '../api/types';
import { isLoggedIn } from '../../../services/auth/session';
import {
  ensureFreshProfile,
  evaluateSummaryGate,
  getCachedProfile,
} from '../../../services/billing/billingStore';

interface NativeIncomingCallOverlay {
  show(customerLabel: string, summary: string): Promise<void>;
  dismiss(): Promise<void>;
}

const native = (
  NativeModules as { IncomingCallOverlay?: NativeIncomingCallOverlay }
).IncomingCallOverlay;

/** Strip non-digits and the Korea country prefix so 010-1234-5678 / +82
 *  10-1234-5678 / 01012345678 all compare equal. */
function normalize(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  // +82 (Korea) → 0
  if (digits.startsWith('82') && digits.length >= 11) {
    return '0' + digits.slice(2);
  }
  return digits;
}

function shortSummary(row: CustomerLogRow): string {
  const summary = (row.summary ?? '').trim();
  if (!summary) return '이전 통화 요약이 없습니다.';
  // Keep it terse — the banner only has ~2 lines.
  return summary.length > 70 ? summary.slice(0, 70) + '…' : summary;
}

// In-memory cache of the user's customer_logs. Populated proactively (on app
// boot, on AppState 'active', after each send_to_group). Incoming-call lookup
// hits this cache for an instant match instead of waiting on a 500-1000ms
// server roundtrip — that latency is the difference between the banner
// showing up before vs after the user picks up.
let cache: ReadonlyArray<CustomerLogRow> = [];
let cachePromise: Promise<ReadonlyArray<CustomerLogRow>> | null = null;

async function refreshCache(): Promise<ReadonlyArray<CustomerLogRow>> {
  if (!isLoggedIn()) {
    cache = [];
    return cache;
  }
  if (cachePromise) return cachePromise;
  cachePromise = (async () => {
    try {
      const res = await listCustomerLogs({ limit: 300 });
      cache = res.items;
      return cache;
    } catch {
      return cache;
    } finally {
      cachePromise = null;
    }
  })();
  return cachePromise;
}

function lookupMatchesInCache(wanted: string): ReadonlyArray<CustomerLogRow> {
  return cache.filter(r => normalize(r.phone_number) === wanted);
}

/** Match the incoming number against the user's customer_logs and, if there's
 *  a hit, pop the native in-call banner. Uses the in-memory cache first
 *  (instant); falls back to a fresh server query if the cache is empty.
 *
 *  Plan gate: pre-call banner is bundled with the post-call AI summary as
 *  one billable unit. Free plan / quota-exhausted users see neither — the
 *  banner is suppressed here and the post-call modal's 요약보기 path is
 *  gated separately by `assertCanRunSummary()` in ConfirmRecording. */
async function handleIncomingCall(rawNumber: string): Promise<void> {
  if (!isLoggedIn()) return;
  if (!native) return;
  const wanted = normalize(rawNumber);
  if (!wanted) return;
  // Fail-OPEN on plan gate: if we have a profile cached, respect the gate
  // verdict. If we don't (cold start, refresh in flight), allow the banner —
  // blocking a paid user from seeing customer context is a worse failure
  // than letting a free user glimpse the banner once. Kick a refresh in the
  // background so the next call sees the cache.
  const cached = getCachedProfile();
  if (!cached) {
    void ensureFreshProfile();
  } else if (!evaluateSummaryGate(cached).allowed) {
    return;
  }
  try {
    let matches = lookupMatchesInCache(wanted);
    if (matches.length === 0 && cache.length === 0) {
      // Cache was never populated — fetch with a hard race timeout. The
      // 2026-05-20 사장님 케이스: 94분 background 후 첫 통화에서
      // proactive refresh(3.3s)와 customer-log fetch가 동시에 inflight
      // 였고 await가 banner 가능 시간을 다 잡아먹음. RN path가 1.5s
      // 안에 못 끝나면 포기 — YoungmanCallScreeningService 가 같은
      // 통화에 대해 native HTTP path 도 병렬로 진행 중이므로 banner는
      // 그쪽에서 표시될 수 있고, IncomingCallOverlayService 가 idempotent
      // 라 race 해도 단일 banner 가 보장됨.
      await Promise.race([
        refreshCache(),
        new Promise<void>(resolve => setTimeout(resolve, 1500)),
      ]);
      matches = lookupMatchesInCache(wanted);
    }
    if (matches.length === 0) {
      // Refresh in the background in case the cache is stale; do not block
      // the banner on it though — there's nothing to show right now anyway.
      void refreshCache();
      return;
    }
    // The list is date-desc; first match is the most recent contact.
    const latest = matches[0];
    const customerName = latest.customer_name?.trim() || rawNumber;
    const label = `${customerName} (${matches.length}번째 통화)`;
    await native.show(label, shortSummary(latest));
  } catch {
    // best-effort — never throw from incoming-call path
  }
}

let attached = false;
let subscription: { remove: () => void } | null = null;
let appStateSub: { remove: () => void } | null = null;

/** Subscribe once at app start. Idempotent. Also kicks off the cache and
 *  refreshes it whenever the app returns to the foreground so the next
 *  incoming-call lookup is instant. */
export function attachIncomingCallListener(): void {
  if (attached || Platform.OS !== 'android') return;
  attached = true;
  subscription = DeviceEventEmitter.addListener(
    'youngmanIncomingCall',
    (number: string) => {
      void handleIncomingCall(number);
    },
  );
  // Warm the customer-log cache immediately + on every foreground entry.
  // Also ensure the billing profile is loaded — the gate check at the top of
  // handleIncomingCall reads it synchronously and bails when missing.
  void refreshCache();
  void ensureFreshProfile();
  appStateSub = AppState.addEventListener('change', state => {
    if (state === 'active') {
      void refreshCache();
    }
  });
}

export function detachIncomingCallListener(): void {
  subscription?.remove();
  subscription = null;
  appStateSub?.remove();
  appStateSub = null;
  attached = false;
}
