package com.youngmanapp.overlay

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = IncomingCallOverlayModule.NAME)
class IncomingCallOverlayModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun show(customerLabel: String, summary: String, promise: Promise) {
    IncomingCallNotifier.show(reactApplicationContext, customerLabel, summary)
    promise.resolve(null)
  }

  @ReactMethod
  fun dismiss(promise: Promise) {
    IncomingCallNotifier.dismiss(reactApplicationContext)
    promise.resolve(null)
  }

  companion object {
    const val NAME = "IncomingCallOverlay"
  }
}
