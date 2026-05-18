package com.youngmanapp.auth

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = AuthBridgeModule.NAME)
class AuthBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun writeJwt(token: String, promise: Promise) {
    AuthStore.writeJwt(reactApplicationContext, token)
    promise.resolve(null)
  }

  @ReactMethod
  fun clearJwt(promise: Promise) {
    AuthStore.clear(reactApplicationContext)
    promise.resolve(null)
  }

  companion object {
    const val NAME = "AuthBridge"
  }
}
