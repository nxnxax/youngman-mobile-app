package com.youngmanapp.overlay

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = ProgressOverlayModule.NAME)
class ProgressOverlayModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun show() {
    ProgressOverlayService.start(reactApplicationContext)
  }

  @ReactMethod
  fun hide() {
    ProgressOverlayService.stop(reactApplicationContext)
  }

  companion object {
    const val NAME = "ProgressOverlay"
  }
}
