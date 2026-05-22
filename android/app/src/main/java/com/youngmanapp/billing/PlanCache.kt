package com.youngmanapp.billing

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * SharedPreferences-backed mirror of the RN AuthProfile. Lets native code paths
 * (YoungmanCallScreeningService → CustomerLogClient fallback) decide whether
 * to surface the incoming-call banner without round-tripping to the server.
 *
 * RN owns the source of truth (`billingStore.ts`); we just keep a parallel
 * copy here that RN updates via PlanCacheModule.write() every time it refetches
 * the profile.
 *
 * The gating policy intentionally mirrors `evaluateSummaryGate` in JS:
 *   - logged out OR profile missing → block (banner won't show)
 *   - plan_status === 'past_due' / 'cancelled' → block
 *   - plan === 'free' → block
 *   - summary_used >= summary_limit (when limit set) → block
 *   - otherwise allow
 */
object PlanCache {

  private const val PREFS = "youngman_plan_v1"
  private const val KEY_JSON = "plan_json"

  /** 사장님 정책 (2026-05-21): Play Store 정식 출시 + 결제사 승인 전까지 모든
   *  사용자 무료. plan 게이트 자체 비활성. 결제 시스템 복원 시 true 로 토글하면
   *  옛 free/quota 차단 로직 자동 복원. RN env.ts 의 TESTER_MODE 와 짝. */
  private const val ENFORCE_PLAN_GATE = false

  fun write(ctx: Context, json: String) {
    try {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
          .edit()
          .putString(KEY_JSON, json)
          .apply()
    } catch (e: Exception) {
      Log.w(TAG, "write failed", e)
    }
  }

  fun clear(ctx: Context) {
    try {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
          .edit()
          .remove(KEY_JSON)
          .apply()
    } catch (e: Exception) {
      Log.w(TAG, "clear failed", e)
    }
  }

  /** True iff the cached plan permits showing the incoming-call banner.
   *
   *  Fail-OPEN — if we have no cache yet (cold start before RN syncs the
   *  profile), allow the banner. Blocking a paid user's call from showing
   *  customer context is a much worse UX failure than letting a free user
   *  glimpse the banner once before RN's gate kicks in. The next foreground
   *  pass syncs the cache and subsequent calls follow the cache verdict. */
  fun canShowIncomingCallModal(ctx: Context): Boolean {
    if (!ENFORCE_PLAN_GATE) return true
    val o = readJson(ctx) ?: return true
    val plan = o.optString("plan", "free")
    val status = o.optString("plan_status", "")
    if (status == "past_due" || status == "cancelled") return false
    if (plan == "free") return false
    if (!o.isNull("summary_limit")) {
      val limit = o.optInt("summary_limit", 0)
      val used = o.optInt("summary_used", 0)
      if (used >= limit) return false
    }
    return true
  }

  private fun readJson(ctx: Context): JSONObject? {
    return try {
      val raw =
          ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
              .getString(KEY_JSON, null)
              ?: return null
      JSONObject(raw)
    } catch (e: Exception) {
      Log.w(TAG, "read failed", e)
      null
    }
  }

  private const val TAG = "PlanCache"
}
