package com.youngmanapp.overlay

import android.animation.ObjectAnimator
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.net.Uri
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
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.ReactContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.youngmanapp.R

/**
 * iOS-style confirmation alert shown after a successful send_to_group.
 * Header "저장됨" + body "고객관리대장에 반영됐어요." + single "확인" button.
 * Auto-dismisses after 5s; tapping "확인" dismisses immediately. In both
 * cases a DeviceEventEmitter event is fired so any RN screen above us (e.g.
 * SummaryReview) can also dismiss in sync.
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

    view.findViewById<View>(R.id.success_btn_ok).setOnClickListener {
      // Confirm → minimize Youngman so the user lands back on whatever app
      // they were in before the call (YouTube, KakaoTalk, etc.).
      dismissWithSync(returnToHome = true)
    }

    view.findViewById<View>(R.id.success_btn_customer).setOnClickListener {
      // Customer-ledger jump should KEEP Youngman in the foreground — the
      // deep link routes the WebView to /customers.html.
      openCustomerLedger()
      dismissWithSync(returnToHome = false)
    }

    val type =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

    // FLAG_NOT_TOUCHABLE removed so the "확인" button is tappable.
    val flags =
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_DIM_BEHIND

    val params =
        WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            flags,
            PixelFormat.TRANSLUCENT,
        )
    params.gravity = Gravity.CENTER_HORIZONTAL or Gravity.CENTER_VERTICAL
    params.dimAmount = 0.35f

    try {
      windowManager.addView(view, params)
      overlayView = view
      animateIn(view)
      // Auto-dismiss after the hold timer — treat the same as the user
      // tapping confirm (i.e. user did NOT explicitly request the ledger).
      handler.postDelayed({ dismissWithSync(returnToHome = true) }, HOLD_MS)
    } catch (e: Exception) {
      Log.w(TAG, "addView failed", e)
      stopSelf()
    }
  }

  private fun animateIn(view: View) {
    view.alpha = 0f
    ObjectAnimator.ofFloat(view, "alpha", 0f, 1f).apply {
      duration = 220
      start()
    }
  }

  /** Dismiss the overlay AND notify any RN listener so dependent screens
   *  (SummaryReview) can pop in lockstep. Safe to call multiple times — the
   *  scheduled auto-dismiss may race with a manual confirm tap.
   *
   *  @param returnToHome true when the user (or auto-dismiss) didn't ask
   *  for the ledger jump — the RN side responds by sending the app to the
   *  background so the user lands back on their previous app.
   */
  private fun dismissWithSync(returnToHome: Boolean) {
    handler.removeCallbacksAndMessages(null)
    emitDismissEvent(returnToHome)
    animateOutAndStop()
  }

  private fun animateOutAndStop() {
    val view = overlayView ?: return run { stopSelf() }
    val fadeOut = ObjectAnimator.ofFloat(view, "alpha", view.alpha, 0f).apply {
      duration = 200
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

  /** Bring the app to the foreground and ask the WebView to navigate to the
   *  customer ledger page. Uses the existing `youngman://record/<route>` deep
   *  link plumbing; the RN side handles the route in WebViewHost.onNativeRoute. */
  private fun openCustomerLedger() {
    val deepLink = Uri.Builder()
        .scheme("youngman")
        .authority("record")
        .appendPath("customer-ledger")
        .build()
    val intent = Intent(Intent.ACTION_VIEW, deepLink).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      `package` = packageName
    }
    try {
      startActivity(intent)
    } catch (e: Exception) {
      Log.w(TAG, "openCustomerLedger failed", e)
    }
  }

  private fun emitDismissEvent(returnToHome: Boolean) {
    val reactContext: ReactContext? = try {
      (applicationContext as? ReactApplication)
          ?.reactHost
          ?.currentReactContext
    } catch (e: Throwable) {
      Log.w(TAG, "emit: react context lookup failed", e)
      null
    }
    try {
      reactContext
          ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          ?.emit(EVENT_DISMISSED, returnToHome)
    } catch (e: Throwable) {
      Log.w(TAG, "emit failed", e)
    }
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
    private const val HOLD_MS = 5_000L
    const val EVENT_DISMISSED = "successOverlayDismissed"

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
