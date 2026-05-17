package com.youngmanapp.callrecording

/**
 * Lightweight server-side classifier used by the post-call foreground service
 * to decide if a newly indexed audio file looks like a call recording. This is
 * intentionally a strict subset of the JS heuristics — the service only needs
 * a path-based pre-filter so it doesn't surface noisy non-call audio in the
 * heads-up notification.
 */
object CallRecordingClassifier {

  private val PATH_HINTS =
      arrayOf(
          "Recordings/Call",
          "Recordings/Call Recordings",
          "Recordings/TPhoneCallRecords",
          "MIUI/sound_recorder/call_rec",
          "recordings/MIUI",
          "Record/Call",
          "PhoneRecord",
          "CallRecordings",
          "ACR",
          "CubeCallRecorder",
          "CallApp",
          "TCallRecord",
          "Documents/CallRecordings",
      )

  // Filenames like "01012345678_20260517171626.m4a" that recorders generate
  // with a phone-number prefix.
  private val FILENAME_PHONE_PREFIX =
      Regex(
          "^\\d{2,4}[-_ ]?\\d{3,4}[-_ ]?\\d{4}.*\\.(m4a|amr|mp3|opus|aac|wav)$",
          RegexOption.IGNORE_CASE,
      )

  fun looksLikeCallRecording(relativePath: String?, displayName: String): Boolean {
    if (!relativePath.isNullOrEmpty()) {
      for (hint in PATH_HINTS) {
        if (relativePath.contains(hint, ignoreCase = true)) {
          return true
        }
      }
    }
    return FILENAME_PHONE_PREFIX.matches(displayName)
  }
}
