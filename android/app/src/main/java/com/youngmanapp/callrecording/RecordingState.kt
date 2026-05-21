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
  /** fs fallback 의 시간 윈도우 기반 매칭은 같은 파일이 윈도우 안에 있는 동안
   *  반복 매칭 가능. 처리한 path 기록해서 즉시 dedup. */
  private const val KEY_LAST_PROCESSED_PATH = "last_processed_file_path"

  fun getBaseline(ctx: Context): Long =
      ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getLong(KEY_BASELINE, 0L)

  fun setBaseline(ctx: Context, dateAddedSec: Long) {
    ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        .edit()
        .putLong(KEY_BASELINE, dateAddedSec)
        .apply()
  }

  fun getLastProcessedPath(ctx: Context): String? =
      ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
          .getString(KEY_LAST_PROCESSED_PATH, null)

  fun setLastProcessedPath(ctx: Context, path: String) {
    ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        .edit()
        .putString(KEY_LAST_PROCESSED_PATH, path)
        .apply()
  }

  /** 사장님 정책 (2026-05-21): 통화 후 모달은 통화 1회 = 1회 표시. 노액션
   *  으로 사라진 모달이 catch-up scan / cold start 로 다시 뜨면 안 됨. 한
   *  번 표시된 displayName 은 영구 dedup. 어차피 미확인 요약에 저장됨. */
  private const val KEY_SHOWN_FILES = "shown_files_set"

  fun isFileShown(ctx: Context, displayName: String): Boolean {
    if (displayName.isBlank()) return false
    val set =
        ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .getStringSet(KEY_SHOWN_FILES, emptySet())
            ?: emptySet()
    return set.contains(displayName)
  }

  fun markFileShown(ctx: Context, displayName: String) {
    if (displayName.isBlank()) return
    val prefs = ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
    val current = prefs.getStringSet(KEY_SHOWN_FILES, emptySet()) ?: emptySet()
    if (current.contains(displayName)) return
    val next = HashSet(current)
    next.add(displayName)
    // Cap at 500 — 영구 누적 방지. 오래된 항목부터 drop.
    if (next.size > 500) {
      val iter = next.iterator()
      while (next.size > 500 && iter.hasNext()) {
        iter.next()
        iter.remove()
      }
    }
    prefs.edit().putStringSet(KEY_SHOWN_FILES, next).apply()
  }
}
