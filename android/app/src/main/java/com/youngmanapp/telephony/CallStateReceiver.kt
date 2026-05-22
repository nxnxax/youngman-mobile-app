package com.youngmanapp.telephony

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import android.util.Log
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.youngmanapp.overlay.CallPostActivity
import com.youngmanapp.overlay.IncomingCallNotifier
import com.youngmanapp.overlay.ModalController
import com.youngmanapp.overlay.OverlayService
import com.youngmanapp.settings.SettingsStore

/**
 * Manifest-registered receiver for android.intent.action.PHONE_STATE.
 *
 * PHONE_STATE is on Android's exception list for implicit broadcasts so this
 * receiver fires even when the app is not actively running (as long as the
 * user has not force-stopped it).
 *
 * We only care about the OFFHOOK -> IDLE transition (the user just hung up a
 * call that was actually in progress). RINGING -> IDLE means the user missed
 * or rejected the call — no recording was created.
 */
class CallStateReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    Log.d(TAG, "onReceive action=${intent.action}")
    if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return

    val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
    val previous = CallStateMemory.read(context)
    CallStateMemory.write(context, state)
    Log.d(TAG, "state transition: $previous -> $state")

    // RINGING resolved (user picked up or hung up / call was missed) — drop
    // the incoming-call banner regardless of outcome. The banner itself is
    // surfaced by YoungmanCallScreeningService, which has access to the
    // caller number; we just clean up here.
    if (previous == TelephonyManager.EXTRA_STATE_RINGING && state != previous) {
      IncomingCallNotifier.dismiss(context)
    }

    // 사장님 정책 (2026-05-21): 통화 시작 (RINGING/IDLE → OFFHOOK) 시점에
    // PostCallScanService 미리 warm-up. 통화 동안 service / classloader /
    // FGS 권한 모두 데워둠. 통화 종료 시 service start latency 0 → 모달 즉시.
    if (state == TelephonyManager.EXTRA_STATE_OFFHOOK && previous != state) {
      PostCallScanService.warmUp(context)
    }

    if (state == TelephonyManager.EXTRA_STATE_IDLE &&
        previous == TelephonyManager.EXTRA_STATE_OFFHOOK) {
      if (!SettingsStore.read(context).realtimeDetection) {
        Log.d(TAG, "call ended but realtime detection is OFF — skipping")
        return
      }
      Log.d(TAG, "call ended (OFFHOOK -> IDLE), starting scan + placeholder modal")
      // 사장님 정책 (2026-05-22 §2 alive FGS): broadcast receiver context 의
      // startActivity 는 background launch 차단됨. 모든 Activity 시작은 이미
      // FGS 상태인 PostCallScanService 가 담당. CallStateReceiver 는 ModalController
      // 의 call_id 만 설정 + scan service 시작.
      val callId = "call-${System.currentTimeMillis()}"
      ModalController.begin(callId)
      // 사장님 정책 (2026-05-22 PM 깜빡임 fix): 양보 FullScreenIntent 제거.
      // v19 manifest 의 POST_CALL action filter (system uid=1000 자동 launch)
      // 가 placeholder 모달의 1차 주체. CallStateReceiver 가 또 발행하면 같은
      // 통화에 알림 + 모달이 2-3번 깜빡임 (사장님 v22 PoC). PostCallScanService
      // 는 file 매칭 후 data update (onNewIntent) 만 담당.
      PostCallScanService.startWithPlaceholder(context, callId)
    }
  }

  private fun canDrawOverlay(ctx: Context): Boolean =
      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M)
        Settings.canDrawOverlays(ctx)
      else true

  companion object {
    private const val TAG = "CallStateReceiver"
  }
}

internal object CallStateMemory {
  private const val PREF = "youngman_call_state"
  private const val KEY = "last_state"

  fun read(ctx: Context): String? =
      ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY, null)

  fun write(ctx: Context, state: String) {
    ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().putString(KEY, state).apply()
  }
}
