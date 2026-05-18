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
 *
 * NOTE: This is a regular Service (NOT a foreground service). The user's
 * tap on the overlay button grants the app a brief background-start exemption
 * on Android 12+, which is enough to launch this service. We deliberately
 * avoid FGS here because an FGS requires a visible notification, and the
 * user found the "영맨 - 잠시만요…" entry intrusive in the notification shade
 * for long-running uploads.
 *
 * Trade-off: for very long server processing (e.g. 1hr calls → ~3min),
 * Android may reclaim this service if the device is under memory pressure.
 * That's acceptable for now; the server-side chunking work (see
 * docs/BACKEND_LONG_CALL_CHUNKING.md) brings worst-case down to ~3min and
 * the device almost always keeps a recently-started service alive that long.
 */
class AutoSubmitService : HeadlessJsTaskService() {

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val extras = intent?.extras ?: return null
    val data = Arguments.fromBundle(extras)
    return HeadlessJsTaskConfig(
        "AutoSubmitRecording",
        data,
        // 10 minutes — covers the worst-case after server chunking lands.
        // The task self-terminates as soon as the JS work is done, so for
        // typical short calls (~7-15s server processing) the service is
        // long gone before this fires.
        600_000L,
        true, // allowed in foreground
    )
  }
}
