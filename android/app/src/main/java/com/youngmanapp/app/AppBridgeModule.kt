package com.youngmanapp.app

import android.app.Activity
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

/**
 * Tiny activity-task helper for RN. Currently exposes one operation —
 * `moveToBackground` — used after a successful send_to_group so the user
 * returns to whatever app they were in before the call (YouTube, etc.).
 */
@ReactModule(name = AppBridgeModule.NAME)
class AppBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun moveToBackground(promise: Promise) {
    val activity: Activity? = getCurrentActivity()
    activity?.moveTaskToBack(true)
    promise.resolve(null)
  }

  companion object {
    const val NAME = "AppBridge"
  }
}
