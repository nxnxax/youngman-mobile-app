import { apiGet } from '../api/client';

/**
 * Server's view of the user's subscription state. Backed by `members` table
 * on cafe24; PortOne/TossPayments webhooks keep these fields in sync.
 *
 * Important quirks (per web team, 2026-05-19):
 *  - `summary_limit: null` means **unlimited** (Pro plan).
 *  - `current_period_end` is a `YYYY.MM.DD` string (cafe24 PHP convention),
 *    not ISO 8601 — parse with care.
 *  - `plan` may legacy-include `"premium"` for users grandfathered from the
 *    pre-PortOne era; treat the same as `"pro"`.
 */
export interface AuthProfile {
  email: string;
  plan: 'free' | 'plus' | 'pro' | 'trialing' | 'premium';
  plan_status: 'active' | 'trialing' | 'past_due' | 'cancelled';
  summary_used: number;
  summary_limit: number | null;
  current_period_end: string | null;
  role: string;
  status: string;
  name?: string;
  phone?: string;
  createdAt?: string;
}

interface AuthProfileResponse {
  ok: true;
  profile: AuthProfile;
}

export async function fetchAuthProfile(): Promise<AuthProfile> {
  const res = await apiGet<AuthProfileResponse>(
    '/records.php?resource=auth-profile',
  );
  return res.profile;
}
