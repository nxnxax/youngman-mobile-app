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
    // 사장님 진단 (2026-05-22 PM): ErrorLog file 항상 비어있음 보고. file write
    // 흐름 logcat 으로 추적.
    val file = File(ctx.filesDir, "errors.log")
    try {
      val sb = StringBuilder()
      sb.append(ts.format(Date()))
      sb.append(" [").append(tag).append("] ")
      sb.append(message)
      if (throwable != null) {
        sb.append('\n').append(Log.getStackTraceString(throwable))
      }
      sb.append('\n')
      file.appendText(sb.toString())
      Log.d(
        "ErrorLog",
        "append OK tag=$tag bytes=${sb.length} file=${file.absolutePath} size=${file.length()}",
      )

      if (file.length() > MAX_BYTES) {
        val rotated = File(ctx.filesDir, "errors.old.log")
        if (rotated.exists()) rotated.delete()
        file.renameTo(rotated)
      }
    } catch (e: Exception) {
      Log.e(
        "ErrorLog",
        "append FAIL tag=$tag file=${file.absolutePath} canWrite=${file.canWrite()} parentExists=${file.parentFile?.exists()}",
        e,
      )
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

  /**
   * Read only the most recent N bytes — used to keep the RN bridge transfer
   * under the 1MB binder limit (TransactionTooLargeException at ~1MB). The
   * first partial line is trimmed so the result starts cleanly. 500KB ≈
   * 1000 log lines, which is plenty for a 24h monitoring window.
   */
  fun readTail(ctx: Context, maxBytes: Int = 500_000): String {
    return try {
      val file = File(ctx.filesDir, "errors.log")
      if (!file.exists()) return ""
      val len = file.length()
      if (len <= maxBytes) return file.readText()
      java.io.RandomAccessFile(file, "r").use { raf ->
        raf.seek(len - maxBytes)
        val buf = ByteArray(maxBytes)
        raf.readFully(buf)
        val text = String(buf, Charsets.UTF_8)
        val firstNewline = text.indexOf('\n')
        val trimmed =
            if (firstNewline >= 0) text.substring(firstNewline + 1) else text
        "(… 앞부분 생략 — 최근 ${maxBytes / 1024}KB만 표시 …)\n$trimmed"
      }
    } catch (e: Exception) {
      "(ErrorLog readTail failed: ${e.message})"
    }
  }

  fun clear(ctx: Context) {
    try {
      File(ctx.filesDir, "errors.log").delete()
      File(ctx.filesDir, "errors.old.log").delete()
    } catch (_: Exception) {}
  }
}
