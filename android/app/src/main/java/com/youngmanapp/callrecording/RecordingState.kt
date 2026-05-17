package com.youngmanapp.callrecording

import android.content.Context

/**
 * SharedPreferences holder shared between the JS-triggered scanner (which
 * advances the baseline whenever the user opens a scan) and the post-call
 * foreground service (which reads the baseline to detect newly created files
 * and writes it again after notifying).
 *
 * `baseline_date_added` is the unix epoch (seconds) of the newest audio file
 * we have already accounted for. Any file with `date_added` strictly greater
 * is considered "new since the user last looked".
 */
object RecordingState {
  private const val PREF_NAME = "youngman_recording_state"
  private const val KEY_BASELINE = "baseline_date_added"

  fun getBaseline(ctx: Context): Long =
      ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getLong(KEY_BASELINE, 0L)

  fun setBaseline(ctx: Context, dateAddedSec: Long) {
    ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        .edit()
        .putLong(KEY_BASELINE, dateAddedSec)
        .apply()
  }
}
