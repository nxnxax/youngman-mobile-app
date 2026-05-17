package com.youngmanapp.logging

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Persistent app-private error log. Native services and JS code both append
 * here so failures can be inspected later — even when USB / Metro is not
 * connected at the time of the failure.
 *
 * File location: `<app_files>/errors.log`. Rotates to `errors.old.log` once
 * the live file exceeds ~2 MB.
 *
 * Read via:
 *   - JS bridge: `window.YoungmanBridge.postToApp('debug.dumpErrorLog', {})`
 *   - ADB:       `adb shell run-as com.youngmanapp cat files/errors.log`
 */
object ErrorLog {

  private const val MAX_BYTES = 2_000_000L
  private val ts =
      SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

  fun append(ctx: Context, tag: String, message: String, throwable: Throwable? = null) {
    try {
      val file = File(ctx.filesDir, "errors.log")
      val sb = StringBuilder()
      sb.append(ts.format(Date()))
      sb.append(" [").append(tag).append("] ")
      sb.append(message)
      if (throwable != null) {
        sb.append('\n').append(Log.getStackTraceString(throwable))
      }
      sb.append('\n')
      file.appendText(sb.toString())

      if (file.length() > MAX_BYTES) {
        val rotated = File(ctx.filesDir, "errors.old.log")
        if (rotated.exists()) rotated.delete()
        file.renameTo(rotated)
      }
    } catch (e: Exception) {
      Log.e("ErrorLog", "failed to write error log", e)
    }
  }

  fun read(ctx: Context): String {
    return try {
      val file = File(ctx.filesDir, "errors.log")
      if (file.exists()) file.readText() else ""
    } catch (e: Exception) {
      "(ErrorLog read failed: ${e.message})"
    }
  }

  fun clear(ctx: Context) {
    try {
      File(ctx.filesDir, "errors.log").delete()
      File(ctx.filesDir, "errors.old.log").delete()
    } catch (_: Exception) {}
  }
}
