package com.youngmanapp.overlay

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

/**
 * JS-facing handle for the success confirmation overlay. Headless task calls
 * `show()` after a verified send_to_group success.
 */
@ReactModule(name = SuccessOverlayModule.NAME)
class SuccessOverlayModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun show() {
    SuccessOverlayService.start(reactApplicationContext)
  }

  companion object {
    const val NAME = "SuccessOverlay"
  }
}
