package com.youngmanapp.overlay

import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import com.youngmanapp.R

/**
 * Thin indeterminate progress bar pinned to the top of the screen during the
 * gap between the post-call modal dismissing and the success alert appearing.
 *
 * Requires SYSTEM_ALERT_WINDOW. Silent no-op if permission missing.
 */
class ProgressOverlayService : Service() {

  private var overlayView: View? = null
  private lateinit var windowManager: WindowManager

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      dismiss()
      return START_NOT_STICKY
    }
    if (!hasOverlayPermission()) {
      stopSelf()
      return START_NOT_STICKY
    }
    showOverlay()
    return START_STICKY
  }

  private fun hasOverlayPermission(): Boolean =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(this) else true

  private fun showOverlay() {
    if (overlayView != null) return
    val view = LayoutInflater.from(this).inflate(R.layout.overlay_progress, null, false)

    val type =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

    val flags =
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS

    val params =
        WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            flags,
            PixelFormat.TRANSLUCENT,
        )
    params.gravity = Gravity.CENTER_HORIZONTAL or Gravity.CENTER_VERTICAL

    try {
      windowManager.addView(view, params)
      overlayView = view
    } catch (e: Exception) {
      Log.w(TAG, "addView failed", e)
      stopSelf()
    }
  }

  private fun dismiss() {
    val view = overlayView
    if (view != null) {
      try {
        windowManager.removeView(view)
      } catch (_: Exception) {}
      overlayView = null
    }
    stopSelf()
  }

  override fun onDestroy() {
    val view = overlayView
    if (view != null) {
      try {
        windowManager.removeView(view)
      } catch (_: Exception) {}
      overlayView = null
    }
    super.onDestroy()
  }

  companion object {
    private const val TAG = "ProgressOverlay"
    const val ACTION_STOP = "stop"

    fun start(ctx: Context) {
      try {
        ctx.startService(Intent(ctx, ProgressOverlayService::class.java))
      } catch (e: Exception) {
        Log.w(TAG, "startService failed", e)
      }
    }

    fun stop(ctx: Context) {
      try {
        ctx.startService(
            Intent(ctx, ProgressOverlayService::class.java).setAction(ACTION_STOP)
        )
      } catch (e: Exception) {
        Log.w(TAG, "stopService failed", e)
      }
    }
  }
}
