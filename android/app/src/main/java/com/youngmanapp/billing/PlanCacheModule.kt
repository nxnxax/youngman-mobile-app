package com.youngmanapp.billing

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = PlanCacheModule.NAME)
class PlanCacheModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  /** Called by billingStore.ts every time the AuthProfile is refreshed.
   *  `json` is the raw AuthProfile JSON (plan, plan_status, summary_used,
   *  summary_limit, ...). */
  @ReactMethod
  fun write(json: String, promise: Promise) {
    PlanCache.write(reactApplicationContext, json)
    promise.resolve(null)
  }

  /** Called by billingStore.ts on logout. */
  @ReactMethod
  fun clear(promise: Promise) {
    PlanCache.clear(reactApplicationContext)
    promise.resolve(null)
  }

  companion object {
    const val NAME = "PlanCache"
  }
}
