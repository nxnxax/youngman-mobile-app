package com.youngmanapp.system

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

/**
 * Reports the user-set background-usage policy for this app and provides a
 * one-tap shortcut to the system settings pages the user needs to adjust if
 * the policy would block our post-call receiver.
 *
 * Status values:
 *   - "restricted"   user explicitly set "Restricted" (Android 9+). Broadcasts
 *                    will not be delivered. Must be lifted.
 *   - "optimized"    standard Doze/standby. Manifest receivers for system
 *                    broadcasts (incl. PHONE_STATE) still fire reliably.
 *   - "unrestricted" battery optimization disabled for this app.
 *   - "unknown"      pre-Android-9 device — we cannot detect status.
 *
 * Manufacturer indicator (Samsung) is also returned so the UI can show
 * device-specific guidance (Samsung's separate "sleeping apps" list).
 */
@ReactModule(name = BackgroundRestrictionModule.NAME)
class BackgroundRestrictionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun getStatus(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager

      val restricted =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) am.isBackgroundRestricted else false
      val ignoringOptimization =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
              pm.isIgnoringBatteryOptimizations(ctx.packageName)
          else true

      val status =
          when {
            Build.VERSION.SDK_INT < Build.VERSION_CODES.P -> "unknown"
            restricted -> "restricted"
            ignoringOptimization -> "unrestricted"
            else -> "optimized"
          }

      val isSamsung =
          Build.MANUFACTURER.equals("samsung", ignoreCase = true) ||
              Build.BRAND.equals("samsung", ignoreCase = true)

      val result = com.facebook.react.bridge.Arguments.createMap()
      result.putString("status", status)
      result.putBoolean("isSamsung", isSamsung)
      result.putString("manufacturer", Build.MANUFACTURER ?: "")
      result.putInt("sdkInt", Build.VERSION.SDK_INT)
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("STATUS_FAILED", e.message, e)
    }
  }

  /** Opens this app's main settings page (where battery and permissions live). */
  @ReactMethod
  fun openAppSettings(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val intent =
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", ctx.packageName, null)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
          }
      ctx.startActivity(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("OPEN_FAILED", e.message, e)
    }
  }

  /**
   * Opens the system's battery optimization request dialog directly, asking
   * the user to allow this specific app to ignore battery optimizations. Only
   * works on API 23+ and requires REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
   * permission declared in the manifest.
   */
  @ReactMethod
  fun requestIgnoreBatteryOptimizations(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val intent =
          Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:${ctx.packageName}")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
          }
      ctx.startActivity(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("REQUEST_FAILED", e.message, e)
    }
  }

  /** True if SYSTEM_ALERT_WINDOW is granted (required to draw the glass overlay). */
  @ReactMethod
  fun hasOverlayPermission(promise: Promise) {
    try {
      val granted =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
              Settings.canDrawOverlays(reactApplicationContext)
          else true
      promise.resolve(granted)
    } catch (e: Exception) {
      promise.reject("CHECK_FAILED", e.message, e)
    }
  }

  /** Opens the system settings page where the user toggles "display over other apps". */
  @ReactMethod
  fun requestOverlayPermission(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val intent =
          Intent(
                  Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                  Uri.parse("package:${ctx.packageName}"),
              )
              .apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
      ctx.startActivity(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("REQUEST_FAILED", e.message, e)
    }
  }

  companion object {
    const val NAME = "BackgroundRestriction"
  }
}
