package com.youngmanapp.overlay

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.youngmanapp.MainActivity
import com.youngmanapp.R
import com.youngmanapp.settings.SettingsStore
import com.youngmanapp.telephony.PostCallScanService

/**
 * 사장님 정책 (2026-05-22 §3): 통화 전 모달은 WindowManager overlay 대신
 * heads-up notification. RINGING 중에는 Android/Samsung 이 다른 앱의 overlay
 * (TYPE_APPLICATION_OVERLAY) 를 차단 — BadTokenException "permission denied
 * for window type 2038". heads-up notification 은 시스템 채널이라 차단 없음 +
 * 통화 받기 버튼 안 가림 + IMPORTANCE_HIGH 로 화면 상단 자동 표시.
 */
object IncomingCallNotifier {

  private const val TAG = "IncomingCallNotifier"
  private const val NOTIF_ID = 4011
  private const val CHANNEL_ID = "yk_incoming_call_v1"
  private const val CHANNEL_NAME = "통화 전 고객 알림"

  fun show(ctx: Context, customerLabel: String, summary: String) {
    PostCallScanService.ensureChannel(
      ctx,
      CHANNEL_ID,
      CHANNEL_NAME,
      NotificationManager.IMPORTANCE_HIGH,
    )

    val openIntent = Intent(ctx, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val pi = PendingIntent.getActivity(
      ctx,
      0,
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_IMMUTABLE else 0),
    )

    val durationSec = SettingsStore.read(ctx).incomingCallPopupDurationSec
    val builder = NotificationCompat.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(customerLabel)
      .setContentText(if (summary.isNotBlank()) summary else "이전 통화 기록 있음")
      .setStyle(NotificationCompat.BigTextStyle().bigText(summary))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(pi)
      .setAutoCancel(true)
      .setOngoing(false)
      .setTimeoutAfter(durationSec * 1000L)

    try {
      NotificationManagerCompat.from(ctx).notify(NOTIF_ID, builder.build())
    } catch (e: SecurityException) {
      Log.w(TAG, "notify failed (POST_NOTIFICATIONS not granted?)", e)
    }
  }

  fun dismiss(ctx: Context) {
    try {
      NotificationManagerCompat.from(ctx).cancel(NOTIF_ID)
    } catch (e: Throwable) {
      Log.w(TAG, "cancel failed", e)
    }
  }
}
