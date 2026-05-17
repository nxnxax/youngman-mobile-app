package com.youngmanapp.overlay

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs a headless React Native task that performs upload + STT/LLM + save
 * without opening any UI. Started from OverlayService when the user taps the
 * "양식에 전송" button.
 *
 * The matching JS task is registered as "AutoSubmitRecording" in index.js.
 */
class AutoSubmitService : HeadlessJsTaskService() {

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val extras = intent?.extras ?: return null
    val data = Arguments.fromBundle(extras)
    return HeadlessJsTaskConfig(
        "AutoSubmitRecording",
        data,
        120_000L, // task timeout 2 minutes — STT can take ~30-60s
        true, // allowed in foreground
    )
  }
}
