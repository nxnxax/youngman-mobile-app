package com.youngmanapp.overlay

import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.telephony.TelephonyManager
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import com.youngmanapp.R

/**
 * Banner-style overlay shown while the phone is ringing for a number that the
 * user has called before. Positioned at the top of the screen, narrow, and
 * non-touchable so the underlying call UI (T-phone / system dialer / 3rd-party
 * spam blockers) keeps its accept/decline buttons fully usable.
 *
 * Lifecycle:
 *  - CallStateReceiver starts this service with EXTRA_CUSTOMER + EXTRA_SUMMARY
 *    when RINGING is detected and a customer_log match is found
 *  - CallStateReceiver fires ACTION_DISMISS on RINGING -> OFFHOOK/IDLE
 *  - Service self-stops on dismiss
 *
 * Requires SYSTEM_ALERT_WINDOW. Silent no-op if permission missing.
 */
class IncomingCallOverlayService : Service() {

  private var overlayView: View? = null
  private lateinit var windowManager: WindowManager
  private val handler = Handler(Looper.getMainLooper())
  private val autoDismiss = Runnable { dismiss() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_DISMISS) {
      dismiss()
      return START_NOT_STICKY
    }
    if (!hasOverlayPermission()) {
      Log.d(TAG, "no overlay permission — skip")
      stopSelf()
      return START_NOT_STICKY
    }
    val customer = intent?.getStringExtra(EXTRA_CUSTOMER) ?: "고객"
    val summary = intent?.getStringExtra(EXTRA_SUMMARY) ?: ""
    showOverlay(customer, summary)
    return START_STICKY
  }

  private fun hasOverlayPermission(): Boolean =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(this) else true

  private fun showOverlay(customer: String, summary: String) {
    // Skip if the call is no longer RINGING by the time we got here — the
    // user may have already picked up while we were doing the customer_log
    // lookup. Showing a banner during an active call (or after it's done) is
    // worse than showing nothing.
    val tm = getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
    if (tm != null && tm.callState != TelephonyManager.CALL_STATE_RINGING) {
      Log.d(TAG, "no longer RINGING (state=${tm.callState}) — skip banner")
      stopSelf()
      return
    }

    // Reuse the existing view if already showing — incoming RINGING can fire
    // duplicate broadcasts; we want a single banner, not stacked banners.
    val existing = overlayView
    if (existing != null) {
      existing.findViewById<TextView>(R.id.incall_customer).text = customer
      existing.findViewById<TextView>(R.id.incall_summary).text = summary
      return
    }

    val view =
        LayoutInflater.from(this).inflate(R.layout.overlay_incoming_call, null, false)
    view.findViewById<TextView>(R.id.incall_customer).text = customer
    view.findViewById<TextView>(R.id.incall_summary).text = summary

    val type =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

    // Anti-conflict flags:
    //  - NOT_TOUCHABLE: every touch passes through to the underlying call UI
    //  - NOT_FOCUSABLE: we do not steal IME / key focus
    //  - LAYOUT_NO_LIMITS: lets us sit above the status bar if needed
    //  - SHOW_WHEN_LOCKED + TURN_SCREEN_ON: 잠금화면에서도 표시 (사장님 정책
    //    2026-05-20 late). 한국 사용자 대부분 잠금 상태로 전화 받음.
    //    deprecated API 지만 Samsung One UI 포함 대부분 OS 에서 여전히 동작.
    //    안 되는 OEM 에서는 silently no-op — 다른 기능 영향 0.
    @Suppress("DEPRECATION")
    val flags =
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON

    val params =
        WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            flags,
            PixelFormat.TRANSLUCENT,
        )
    // Anchor to top + push down ~30% of the screen height — the gap between
    // "내 아이폰" (caller name at ~15%) and the rest of the call info / accept
    // buttons. Adapts to any device size.
    params.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
    val screenHeightPx = resources.displayMetrics.heightPixels
    params.y = (screenHeightPx * 0.30f).toInt()

    try {
      windowManager.addView(view, params)
      overlayView = view
      Log.d(TAG, "incoming-call banner shown for $customer")
      // Safety net: if RINGING ends before we got here (user already picked
      // up while we were resolving the lookup), CallStateReceiver's dismiss
      // call could've fired with no view yet. Schedule a hard auto-dismiss
      // so a late-arriving banner never sticks around forever.
      handler.removeCallbacks(autoDismiss)
      handler.postDelayed(autoDismiss, AUTO_DISMISS_MS)
    } catch (e: Exception) {
      Log.w(TAG, "addView failed", e)
      stopSelf()
    }
  }

  private fun dismiss() {
    handler.removeCallbacks(autoDismiss)
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
    handler.removeCallbacks(autoDismiss)
    val view = overlayView
    if (view != null) {
      try {
        windowManager.removeView(view)
      } catch (_: Exception) {}
      overlayView = null
    }
    super.onDestroy()
  }

  private fun dpToPx(dp: Int): Int = (dp * resources.displayMetrics.density).toInt()

  companion object {
    private const val TAG = "IncomingCallOverlay"
    const val EXTRA_CUSTOMER = "customer"
    const val EXTRA_SUMMARY = "summary"
    const val ACTION_DISMISS = "dismiss"
    /** Backstop: if PHONE_STATE transitions don't reach us (banner showed up
     *  after the user already picked up), tear ourselves down anyway. */
    private const val AUTO_DISMISS_MS = 25_000L

    fun show(ctx: Context, customerLabel: String, summary: String) {
      val intent =
          Intent(ctx, IncomingCallOverlayService::class.java).apply {
            putExtra(EXTRA_CUSTOMER, customerLabel)
            putExtra(EXTRA_SUMMARY, summary)
          }
      try {
        ctx.startService(intent)
      } catch (e: Exception) {
        Log.w(TAG, "startService failed", e)
      }
    }

    fun dismiss(ctx: Context) {
      try {
        ctx.startService(
            Intent(ctx, IncomingCallOverlayService::class.java).setAction(ACTION_DISMISS)
        )
      } catch (e: Exception) {
        Log.w(TAG, "dismiss failed", e)
      }
    }
  }
}
