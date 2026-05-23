package com.youngmanapp.overlay

import android.content.Context

/**
 * 사장님 정책 (v53 2026-05-24): placeholder 모달 (file 매칭 전, currentUri=null)
 * 에서 사장님이 [양식에 전송] 누른 시점을 기록. CallPostActivity 는 즉시 finish 하고,
 * PostCallScanService 가 file 매칭하면 이 flag 를 consume → pendingReview=false 로
 * background autoSubmit 호출 (trigger_summarize(auto_confirm=true) 까지).
 *
 * 5분 stale guard — 다음 통화 cycle 까지 잔재하지 않도록.
 */
object PendingSubmitFlag {

  private const val PREFS = "youngman_pending_submit_v1"
  private const val KEY_TIMESTAMP = "ts"
  private const val MAX_AGE_MS = 5 * 60_000L

  fun set(ctx: Context) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putLong(KEY_TIMESTAMP, System.currentTimeMillis())
      .apply()
  }

  /** Returns true exactly once if set within the last 5 minutes; clears the flag. */
  fun consume(ctx: Context): Boolean {
    val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val ts = prefs.getLong(KEY_TIMESTAMP, 0L)
    if (ts == 0L) return false
    prefs.edit().remove(KEY_TIMESTAMP).apply()
    return System.currentTimeMillis() - ts <= MAX_AGE_MS
  }
}
