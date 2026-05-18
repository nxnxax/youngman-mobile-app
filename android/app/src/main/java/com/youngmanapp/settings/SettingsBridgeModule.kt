package com.youngmanapp.settings

import android.app.Activity
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = SettingsBridgeModule.NAME)
class SettingsBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun write(json: String, promise: Promise) {
    SettingsStore.write(reactApplicationContext, json)
    promise.resolve(null)
  }

  /**
   * Whether Youngman already holds the call-screening role. UI uses this to
   * show "현재 활성화됨" vs "활성화하기" labels.
   */
  @ReactMethod
  fun isCallScreeningRoleHeld(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      promise.resolve(false)
      return
    }
    val rm =
        reactApplicationContext.getSystemService(Context.ROLE_SERVICE) as? RoleManager
    val held =
        rm != null &&
            rm.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING) &&
            rm.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
    promise.resolve(held)
  }

  /**
   * Pop the OS dialog asking the user to make Youngman the default
   * "Caller ID & spam" app. If the RoleManager flow isn't available (pre-Q
   * or device without the role), fall back to opening the system's
   * default-apps settings page so the user can pick manually.
   */
  @ReactMethod
  fun requestCallScreeningRole(promise: Promise) {
    val activity: Activity? = getCurrentActivity()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && activity != null) {
        val rm = activity.getSystemService(Context.ROLE_SERVICE) as? RoleManager
        if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING)) {
          // RoleManager swallows createRequestRoleIntent when the role is
          // already held — the user taps the button and nothing happens.
          // Fall through to the system default-apps page in that case so the
          // user can re-pick (or pick something else).
          if (!rm.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)) {
            val intent = rm.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)
            activity.startActivityForResult(intent, REQ_CALL_SCREENING_ROLE)
            promise.resolve(true)
            return
          }
        }
      }
      // Fallback — open the default-apps settings screen (used when the role
      // is already held, or RoleManager unavailable, or pre-Q).
      val intent =
          Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
      reactApplicationContext.startActivity(intent)
      promise.resolve(false)
    } catch (e: Throwable) {
      promise.reject("REQUEST_FAILED", e.message, e)
    }
  }

  companion object {
    const val NAME = "SettingsBridge"
    private const val REQ_CALL_SCREENING_ROLE = 7311
  }
}
