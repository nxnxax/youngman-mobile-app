package com.youngmanapp.logging

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = ErrorLogModule.NAME)
class ErrorLogModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun append(tag: String, message: String) {
    ErrorLog.append(reactApplicationContext, tag, message)
  }

  @ReactMethod
  fun read(promise: Promise) {
    promise.resolve(ErrorLog.read(reactApplicationContext))
  }

  /** Returns only the last `maxBytes` (default 500KB) of the log so the RN
   *  bridge transfer stays under the 1MB binder limit. */
  @ReactMethod
  fun readTail(maxBytes: Int, promise: Promise) {
    val limit = if (maxBytes > 0) maxBytes else 500_000
    promise.resolve(ErrorLog.readTail(reactApplicationContext, limit))
  }

  @ReactMethod
  fun clear(promise: Promise) {
    ErrorLog.clear(reactApplicationContext)
    promise.resolve(null)
  }

  companion object {
    const val NAME = "ErrorLog"
  }
}
