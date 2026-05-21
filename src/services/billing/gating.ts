import { DeviceEventEmitter } from 'react-native';

import { isLoggedIn } from '../auth/session';
import type { AuthProfile } from './api';
import {
  ensureFreshProfile,
  evaluateSummaryGate,
  type SummaryGate,
} from './billingStore';

export type { SummaryGate } from './billingStore';

/** Event fired when a plan-blocked action is attempted. PlanGateModal
 *  listens at the WebViewHost root and renders the styled card. */
export const PLAN_GATE_SHOW_EVENT = 'youngman.planGate.show';

export function showPlanGate(
  gate: SummaryGate,
  profile: AuthProfile | null,
): void {
  DeviceEventEmitter.emit(PLAN_GATE_SHOW_EVENT, { gate, profile });
}

/**
 * Centralized gating UX. Both the post-call modal "양식에 전송" path
 * (autoSubmitTask) and the in-app "요약보기" path (ConfirmRecording) call
 * `assertCanRunSummary()` BEFORE upload to avoid burning server credits on
 * blocked accounts. Server still enforces via `plan_required` 403 — this
 * client-side check is purely UX.
 *
 * Returns true when the user is allowed to run AI summary. Returns false +
 * shows an Alert with an upgrade CTA when blocked. Callers should bail
 * silently when this returns false (the Alert handles user comms).
 */
export async function assertCanRunSummary(): Promise<boolean> {
  // Fail-open principle: if we KNOW the user can't run summary (profile
  // says free / quota_exceeded / past_due), block here. If we DON'T know
  // (network failed, server unreachable), let the request through — the
  // server enforces with `plan_required` 403 and SummaryReview will pop
  // the same modal there.
  const profile = await ensureFreshProfile();
  if (!profile) {
    // No profile loaded. If logged out, block; otherwise let server decide.
    if (!isLoggedIn()) {
      showPlanGate({ allowed: false, reason: 'not_logged_in' }, null);
      return false;
    }
    return true;
  }
  const gate = evaluateSummaryGate(profile);
  if (gate.allowed) {
    return true;
  }
  showPlanGate(gate, profile);
  return false;
}

/** Returns the user-facing copy for a closed gate. Exported so non-modal
 *  paths (e.g. inline error messages) can reuse the same wording. */
export function gateCopy(
  gate: SummaryGate,
  profile: AuthProfile | null,
): { title: string; body: string; cta?: string; ctaDeepLink?: string } {
  switch (gate.reason) {
    case 'not_logged_in':
      return {
        title: '로그인이 필요해요',
        body: '영맨 앱을 열고 로그인 후 다시 시도해주세요.',
      };
    case 'plan_free':
      return {
        title: 'Plus 구독부터 사용 가능해요',
        body:
          '통화 AI 요약은 Plus(월 19,000원, 월 20회) 또는 Pro(월 39,000원, 무제한) 구독부터 사용할 수 있어요.',
        cta: '요금제 보기',
        ctaDeepLink: 'youngman://record/subscribe',
      };
    case 'trial_exhausted':
      return {
        title: '체험이 끝났어요',
        body:
          '무료 체험 5회를 모두 사용했어요. Plus 또는 Pro 구독으로 계속 이용해주세요.',
        cta: '요금제 보기',
        ctaDeepLink: 'youngman://record/subscribe',
      };
    case 'plus_quota_exceeded': {
      const used = profile?.summary_used ?? 0;
      const limit = profile?.summary_limit ?? 0;
      const nextDate = profile?.current_period_end ?? '';
      return {
        title: '이번 달 한도를 모두 사용했어요',
        body: `Plus 플랜 ${used}/${limit}회 사용. Pro(무제한)로 업그레이드하거나 ${
          nextDate ? `${nextDate}에 ` : ''
        }다음 결제일까지 기다려주세요.`,
        cta: 'Pro로 업그레이드',
        ctaDeepLink: 'youngman://record/subscribe',
      };
    }
    case 'past_due':
      return {
        title: '결제가 처리되지 않았어요',
        body: '결제 정보를 업데이트하면 바로 다시 사용할 수 있어요.',
        cta: '결제 정보 업데이트',
        ctaDeepLink: 'youngman://record/billing',
      };
    case 'cancelled_expired':
      return {
        title: '구독이 종료되었어요',
        body:
          '구독을 다시 시작하면 통화 AI 요약을 이어서 사용할 수 있어요.',
        cta: '재구독 하기',
        ctaDeepLink: 'youngman://record/subscribe',
      };
    default:
      return {
        title: '사용할 수 없어요',
        body: '잠시 후 다시 시도해주세요.',
      };
  }
}


