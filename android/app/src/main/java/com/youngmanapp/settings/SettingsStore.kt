package com.youngmanapp.settings

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * SharedPreferences-backed mirror of the RN AppSettings object. Lets the
 * native side (OverlayService, CallStateReceiver, PostCallScanService) read
 * user preferences synchronously without touching AsyncStorage.
 *
 * RN owns the source of truth (`@youngman/settings-v1` in AsyncStorage); we
 * just keep a parallel copy here that RN updates via SettingsBridge.write().
 */
object SettingsStore {

  private const val PREFS = "youngman_settings_v1"
  private const val KEY_JSON = "settings_json"

  data class Snapshot(
      val modalDwellSec: Int,
      val modalSoundOn: Boolean,
      val popupFrequency: String, // "always" | "formal" | "keyword"
      val keywords: String,
      val realtimeDetection: Boolean,
      val incomingCallPopupEnabled: Boolean,
      val incomingCallPopupDurationSec: Int,
  ) {
    val modalDwellMs: Long get() = modalDwellSec * 1000L
  }

  private val DEFAULT =
      Snapshot(
          modalDwellSec = 15,
          modalSoundOn = false,
          popupFrequency = "always",
          keywords = "사장님, 사모님",
          realtimeDetection = true,
          incomingCallPopupEnabled = true,
          incomingCallPopupDurationSec = 20,
      )

  fun write(ctx: Context, json: String) {
    try {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
          .edit()
          .putString(KEY_JSON, json)
          .apply()
    } catch (e: Exception) {
      Log.w(TAG, "write failed", e)
    }
  }

  fun read(ctx: Context): Snapshot {
    return try {
      val raw =
          ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
              .getString(KEY_JSON, null)
              ?: return DEFAULT
      val o = JSONObject(raw)
      Snapshot(
          modalDwellSec = o.optInt("modalDwellSec", DEFAULT.modalDwellSec),
          modalSoundOn = o.optString("modalSound", "off") == "on",
          popupFrequency = o.optString("popupFrequency", DEFAULT.popupFrequency),
          keywords = o.optString("keywords", DEFAULT.keywords),
          realtimeDetection = o.optBoolean("realtimeDetection", DEFAULT.realtimeDetection),
          incomingCallPopupEnabled = o.optBoolean(
              "incomingCallPopupEnabled",
              DEFAULT.incomingCallPopupEnabled,
          ),
          incomingCallPopupDurationSec = o.optInt(
              "incomingCallPopupDurationSec",
              DEFAULT.incomingCallPopupDurationSec,
          ),
      )
    } catch (e: Exception) {
      Log.w(TAG, "read failed", e)
      DEFAULT
    }
  }

  private const val TAG = "SettingsStore"
}
