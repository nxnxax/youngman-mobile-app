package com.youngmanapp.clipboard

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

/**
 * Native clipboard bridge — used by ErrorLogScreen to let the user copy the
 * persistent error log so they can paste it into KakaoTalk/email and share
 * with the developer. RN's built-in Clipboard API is deprecated and was
 * removed in newer versions; adding a tiny native module is more reliable
 * than pulling in a third-party package for a single button.
 */
@ReactModule(name = ClipboardBridgeModule.NAME)
class ClipboardBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun setString(text: String, promise: Promise) {
    try {
      val clipboard =
          reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE)
              as ClipboardManager
      val clip = ClipData.newPlainText("errors.log", text)
      clipboard.setPrimaryClip(clip)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("CLIPBOARD_FAILED", e.message, e)
    }
  }

  companion object {
    const val NAME = "ClipboardBridge"
  }
}
