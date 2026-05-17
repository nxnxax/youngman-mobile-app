package com.youngmanapp.telephony

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.youngmanapp.R

class RecordingDetectedNotifier(private val ctx: Context) {

  fun showRecordingFound(file: PostCallScanService.FoundFile) {
    PostCallScanService.ensureChannel(
        ctx, CHANNEL_ID, "통화녹음 발견", NotificationManager.IMPORTANCE_HIGH)

    val deepLink = buildDeepLink(file)
    val intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(deepLink)).apply {
          flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
          `package` = ctx.packageName
        }
    val pending =
        PendingIntent.getActivity(
            ctx,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    val notif =
        NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("통화녹음을 발견했어요")
            .setContentText("탭하면 고객관리대장에 기록할 수 있어요")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()

    try {
      NotificationManagerCompat.from(ctx).notify(NOTIF_ID, notif)
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS not granted — silent fail; user won't see the
      // prompt until they grant it. The recording is still tracked via the
      // baseline so we won't lose it on the next scan.
    }
  }

  private fun buildDeepLink(file: PostCallScanService.FoundFile): String =
      Uri.Builder()
          .scheme("youngman")
          .authority("record")
          .appendPath("confirm")
          .appendQueryParameter("uri", file.uri)
          .appendQueryParameter("name", file.displayName)
          .appendQueryParameter("duration", file.duration.toString())
          .appendQueryParameter("dateAdded", file.dateAdded.toString())
          .appendQueryParameter("mimeType", "audio/mp4")
          .build()
          .toString()

  companion object {
    private const val CHANNEL_ID = "yk_call_recording_found"
    private const val NOTIF_ID = 4002
    private const val REQUEST_CODE = 4002
  }
}
