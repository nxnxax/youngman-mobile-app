package com.youngmanapp.telephony

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import android.util.Log

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

    if (state == TelephonyManager.EXTRA_STATE_IDLE &&
        previous == TelephonyManager.EXTRA_STATE_OFFHOOK) {
      Log.d(TAG, "call ended (OFFHOOK -> IDLE), starting scan service")
      PostCallScanService.start(context)
    }
  }

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
