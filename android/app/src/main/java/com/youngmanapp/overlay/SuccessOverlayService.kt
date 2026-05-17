package com.youngmanapp.overlay

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.view.animation.OvershootInterpolator
import com.youngmanapp.R

/**
 * Small glass-style confirmation overlay shown after a successful auto-submit.
 * Pops up at screen center with a green check + "양식 전송 완료", animates in
 * (card fade + check scale-overshoot), holds briefly, then fades out.
 *
 * Requires SYSTEM_ALERT_WINDOW. Silent no-op if permission missing.
 */
class SuccessOverlayService : Service() {

  private var overlayView: View? = null
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var windowManager: WindowManager

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!hasOverlayPermission()) {
      stopSelf()
      return START_NOT_STICKY
    }
    showOverlay()
    return START_NOT_STICKY
  }

  private fun hasOverlayPermission(): Boolean =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(this) else true

  private fun showOverlay() {
    dismissView()
    val view =
        LayoutInflater.from(this).inflate(R.layout.overlay_success, null, false)

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
      animateIn(view)
    } catch (e: Exception) {
      Log.w(TAG, "addView failed", e)
      stopSelf()
    }
  }

  private fun animateIn(view: View) {
    val check = view.findViewById<View>(R.id.success_check)
    val text = view.findViewById<View>(R.id.success_text)

    // Card fade-in (the whole overlay starts invisible)
    view.alpha = 0f
    val cardFade = ObjectAnimator.ofFloat(view, "alpha", 0f, 1f).apply {
      duration = 180
    }

    // Check icon scale with overshoot (0.3 → 1.0)
    check.scaleX = 0.3f
    check.scaleY = 0.3f
    val checkScaleX = ObjectAnimator.ofFloat(check, "scaleX", 0.3f, 1f).apply {
      duration = 380
      interpolator = OvershootInterpolator(2.0f)
      startDelay = 80
    }
    val checkScaleY = ObjectAnimator.ofFloat(check, "scaleY", 0.3f, 1f).apply {
      duration = 380
      interpolator = OvershootInterpolator(2.0f)
      startDelay = 80
    }

    // Text slight slide-up
    text.alpha = 0f
    text.translationY = 8f
    val textFade = ObjectAnimator.ofFloat(text, "alpha", 0f, 1f).apply {
      duration = 240
      startDelay = 200
    }
    val textSlide = ObjectAnimator.ofFloat(text, "translationY", 8f, 0f).apply {
      duration = 240
      startDelay = 200
    }

    AnimatorSet().apply {
      playTogether(cardFade, checkScaleX, checkScaleY, textFade, textSlide)
      start()
    }

    handler.postDelayed({ animateOutAndDismiss() }, HOLD_MS)
  }

  private fun animateOutAndDismiss() {
    val view = overlayView ?: return run { stopSelf() }
    val fadeOut = ObjectAnimator.ofFloat(view, "alpha", view.alpha, 0f).apply {
      duration = 220
    }
    fadeOut.addListener(
        object : android.animation.AnimatorListenerAdapter() {
          override fun onAnimationEnd(animation: android.animation.Animator) {
            dismissView()
            stopSelf()
          }
        }
    )
    fadeOut.start()
  }

  private fun dismissView() {
    val view = overlayView ?: return
    try {
      windowManager.removeView(view)
    } catch (_: Exception) {}
    overlayView = null
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    dismissView()
    super.onDestroy()
  }

  companion object {
    private const val TAG = "SuccessOverlay"
    private const val HOLD_MS = 1500L

    fun start(ctx: Context) {
      val intent = Intent(ctx, SuccessOverlayService::class.java)
      try {
        ctx.startService(intent)
      } catch (e: Exception) {
        Log.w(TAG, "startService failed", e)
      }
    }
  }
}
