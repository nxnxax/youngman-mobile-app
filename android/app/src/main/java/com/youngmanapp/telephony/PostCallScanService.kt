package com.youngmanapp.telephony

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import androidx.core.app.NotificationCompat
import com.youngmanapp.R
import com.youngmanapp.callrecording.CallRecordingClassifier
import com.youngmanapp.callrecording.RecordingState

/**
 * Short-lived foreground service started by [CallStateReceiver] when a call
 * ends. We poll MediaStore for up to 30s looking for a newly indexed file in
 * a known call recording folder. As soon as we find one — or hit the deadline
 * — we stop ourselves.
 */
class PostCallScanService : Service() {

  private val handler = Handler(Looper.getMainLooper())
  private val deadlineMs = 30_000L
  private val pollIntervalMs = 2_000L
  private var startedAt = 0L
  private lateinit var notifier: RecordingDetectedNotifier

  data class FoundFile(
      val uri: String,
      val displayName: String,
      val relativePath: String,
      val dateAdded: Long,
      val duration: Long,
  )

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    notifier = RecordingDetectedNotifier(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startedAt = System.currentTimeMillis()
    Log.d(TAG, "onStartCommand")
    startForeground(NOTIF_ID_ONGOING, buildOngoingNotification())
    handler.post(pollRunnable)
    return START_NOT_STICKY
  }

  private val pollRunnable =
      object : Runnable {
        override fun run() {
          try {
            val found = findNewCallRecording()
            if (found != null) {
              Log.d(TAG, "found new call recording: ${found.displayName} @ ${found.relativePath}")
              RecordingState.setBaseline(this@PostCallScanService, found.dateAdded)
              notifier.showRecordingFound(found)
              stopSelfSafely()
              return
            }
            Log.d(TAG, "poll: no new file yet (elapsed=${System.currentTimeMillis() - startedAt}ms)")
          } catch (t: Throwable) {
            Log.w(TAG, "poll exception", t)
          }
          val elapsed = System.currentTimeMillis() - startedAt
          if (elapsed >= deadlineMs) {
            Log.d(TAG, "deadline reached, stopping")
            stopSelfSafely()
          } else {
            handler.postDelayed(this, pollIntervalMs)
          }
        }
      }

  private fun stopSelfSafely() {
    handler.removeCallbacks(pollRunnable)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION") stopForeground(true)
    }
    stopSelf()
  }

  override fun onDestroy() {
    handler.removeCallbacks(pollRunnable)
    super.onDestroy()
  }

  private fun findNewCallRecording(): FoundFile? {
    val baseline = RecordingState.getBaseline(this)
    Log.d(TAG, "findNewCallRecording: baseline=$baseline")
    if (baseline == 0L) {
      val now = System.currentTimeMillis() / 1000
      RecordingState.setBaseline(this, now)
      Log.d(TAG, "no baseline — established at $now, skipping this call")
      return null
    }

    val collection =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
          MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        }

    val projection =
        mutableListOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.DATE_ADDED,
            MediaStore.Audio.Media.DURATION,
        )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      projection += MediaStore.Audio.Media.RELATIVE_PATH
    }

    val selection = "${MediaStore.Audio.Media.DATE_ADDED} > ?"
    val selectionArgs = arrayOf(baseline.toString())
    val sortOrder = "${MediaStore.Audio.Media.DATE_ADDED} DESC"

    var rowsSeen = 0
    var rowsAfterDuration = 0
    var rowsAfterClassifier = 0

    contentResolver
        .query(collection, projection.toTypedArray(), selection, selectionArgs, sortOrder)
        ?.use { c ->
          val idCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
          val nameCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
          val dateCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED)
          val durCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
          val pathCol =
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                c.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH)
              } else -1

          while (c.moveToNext() && rowsSeen < 50) {
            rowsSeen++
            val displayName = c.getString(nameCol) ?: ""
            val relativePath = if (pathCol >= 0) c.getString(pathCol) ?: "" else ""
            val duration = c.getLong(durCol)
            if (duration < 10_000) continue
            rowsAfterDuration++
            if (!CallRecordingClassifier.looksLikeCallRecording(relativePath, displayName)) continue
            rowsAfterClassifier++

            val id = c.getLong(idCol)
            val uri = ContentUris.withAppendedId(collection, id)
            Log.d(TAG, "match found after $rowsSeen rows: $displayName @ $relativePath")
            return FoundFile(
                uri = uri.toString(),
                displayName = displayName,
                relativePath = relativePath,
                dateAdded = c.getLong(dateCol),
                duration = duration,
            )
          }
        }
    Log.d(
        TAG,
        "no match: rowsSeen=$rowsSeen afterDuration=$rowsAfterDuration afterClassifier=$rowsAfterClassifier",
    )
    return null
  }

  private fun buildOngoingNotification(): Notification {
    ensureChannel(this, CHANNEL_ID_ONGOING, "통화녹음 감지", NotificationManager.IMPORTANCE_LOW)
    return NotificationCompat.Builder(this, CHANNEL_ID_ONGOING)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("영맨")
        .setContentText("통화녹음 감지 중…")
        .setOngoing(true)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .build()
  }

  companion object {
    private const val TAG = "PostCallScanService"
    private const val NOTIF_ID_ONGOING = 4001
    private const val CHANNEL_ID_ONGOING = "yk_post_call_scan"

    fun start(ctx: Context) {
      val intent = Intent(ctx, PostCallScanService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
    }

    fun ensureChannel(ctx: Context, id: String, name: String, importance: Int) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(id) == null) {
          val ch = NotificationChannel(id, name, importance)
          mgr.createNotificationChannel(ch)
        }
      }
    }
  }
}
