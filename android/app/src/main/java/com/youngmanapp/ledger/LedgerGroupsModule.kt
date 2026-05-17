package com.youngmanapp.ledger

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = LedgerGroupsModule.NAME)
class LedgerGroupsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  /** JS hands over the already-serialized groups payload — { "groups": [...] }. */
  @ReactMethod
  fun write(json: String, promise: Promise) {
    LedgerGroupsCache.write(reactApplicationContext, json)
    promise.resolve(null)
  }

  @ReactMethod
  fun clear(promise: Promise) {
    LedgerGroupsCache.clear(reactApplicationContext)
    promise.resolve(null)
  }

  companion object {
    const val NAME = "LedgerGroupsCache"
  }
}
