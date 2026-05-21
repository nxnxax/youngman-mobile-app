package com.youngmanapp.telephony

import android.telecom.Call
import android.telecom.CallScreeningService
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.youngmanapp.auth.CustomerLogClient
import com.youngmanapp.billing.PlanCache
import com.youngmanapp.overlay.IncomingCallOverlayService
import com.youngmanapp.settings.SettingsStore

/**
 * Android 12+ compliant way to learn the incoming caller number BEFORE the
 * user picks up. Only fires when the user has set Youngman as their default
 * "Caller ID & spam" app via Settings → Default apps → Caller ID & spam.
 *
 * We never block / silence / reject — always allow the call through. The
 * single purpose is to pull the number off `callDetails.handle`, forward it
 * to the RN side via a DeviceEventEmitter event, and let RN do the
 * customer_log lookup + show the in-call banner.
 *
 * Failing gracefully when:
 *  - The user has not picked Youngman as default screener → this service
 *    simply never gets invoked. Other code paths (post-call) are unaffected.
 *  - The realtime detection toggle is OFF → emit nothing; still respondToCall.
 *  - RN bridge is asleep → emit becomes a no-op; banner won't appear.
 */
class YoungmanCallScreeningService : CallScreeningService() {

  override fun onScreenCall(callDetails: Call.Details) {
    // Never modify the call — pure pass-through identification.
    val response =
        CallResponse.Builder()
            .setDisallowCall(false)
            .setRejectCall(false)
            .setSkipCallLog(false)
            .setSkipNotification(false)
            .build()
    respondToCall(callDetails, response)

    // Skip outgoing — banner is for incoming customer recognition only.
    if (callDetails.callDirection != Call.Details.DIRECTION_INCOMING) {
      return
    }

    if (!SettingsStore.read(this).realtimeDetection) {
      Log.d(TAG, "realtimeDetection off — skip")
      return
    }

    // Plan gate (native side). The pre-call banner is bundled with the
    // post-call AI summary as one billable unit — free / quota-exhausted
    // users see neither. Fail-CLOSED: if no plan snapshot is cached, do not
    // surface the banner. RN syncs the cache on every profile refresh.
    if (!PlanCache.canShowIncomingCallModal(this)) {
      Log.d(TAG, "plan gate closed — skip incoming banner")
      return
    }

    val number = callDetails.handle?.schemeSpecificPart ?: return
    Log.d(TAG, "incoming RINGING from $number")

    // Dual-path lookup (2026-05-20 race fix):
    //  - RN path: emit if alive. RN's in-memory customer_log cache wins when
    //    fresh — banner shows in ~50ms.
    //  - Native HTTP path: ALWAYS run in parallel. Two scenarios benefit:
    //      (1) RN is dead/cold — only path that can surface the banner.
    //      (2) RN is alive but blocked on session refresh / network — native
    //          path wins the race and shows the banner first.
    //  IncomingCallOverlayService.showOverlay is idempotent (reuses existing
    //  view), so both paths racing to show() yields a single banner — the
    //  loser just updates the text content of the existing view.
    if (isRnAlive()) {
      Log.d(TAG, "RN alive — emit to JS (in-memory lookup)")
      emitToRn(number)
    } else {
      Log.d(TAG, "RN not loaded — native HTTP path only")
    }

    // Always also run the native HTTP path. Even when RN is alive, this is
    // our safety net against the 사장님 94분 background → first call case
    // where RN's refreshCache() got blocked behind a session refresh.
    Thread {
      val match = CustomerLogClient.findByPhone(applicationContext, number)
      if (match != null) {
        val displayName =
            match.customerName?.takeIf { it.isNotBlank() } ?: number
        val label = "$displayName (${match.callCount}번째 통화)"
        val summary = shortSummary(match.summary)
        IncomingCallOverlayService.show(applicationContext, label, summary)
      }
    }.start()
  }

  private fun isRnAlive(): Boolean =
      try {
        (applicationContext as? ReactApplication)
            ?.reactHost
            ?.currentReactContext != null
      } catch (e: Throwable) {
        Log.w(TAG, "react context check failed", e)
        false
      }

  private fun shortSummary(raw: String?): String {
    val s = raw?.trim() ?: return "이전 통화 요약이 없습니다."
    return if (s.length > 70) s.substring(0, 70) + "…" else s
  }

  private fun emitToRn(number: String) {
    val reactContext =
        try {
          (applicationContext as? ReactApplication)
              ?.reactHost
              ?.currentReactContext
        } catch (e: Throwable) {
          Log.w(TAG, "react context lookup failed", e)
          null
        }
    try {
      reactContext
          ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          ?.emit(EVENT_INCOMING_CALL, number)
    } catch (e: Throwable) {
      Log.w(TAG, "emit failed", e)
    }
  }

  companion object {
    private const val TAG = "YoungmanCallScreening"
    const val EVENT_INCOMING_CALL = "youngmanIncomingCall"
  }
}
