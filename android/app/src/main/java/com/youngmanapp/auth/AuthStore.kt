package com.youngmanapp.auth

import android.content.Context
import android.util.Log

/**
 * SharedPreferences-backed JWT cache. RN owns AsyncStorage source of truth
 * but mirrors here so native components (CallScreeningService, etc.) can do
 * authenticated HTTP calls without needing the RN bridge alive.
 */
object AuthStore {

  private const val PREFS = "youngman_auth_v1"
  private const val KEY_TOKEN = "access_token"

  fun writeJwt(ctx: Context, token: String) {
    try {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
          .edit()
          .putString(KEY_TOKEN, token)
          .apply()
    } catch (e: Exception) {
      Log.w(TAG, "write failed", e)
    }
  }

  fun readJwt(ctx: Context): String? =
      try {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null)
      } catch (e: Exception) {
        Log.w(TAG, "read failed", e)
        null
      }

  fun clear(ctx: Context) {
    try {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    } catch (_: Exception) {}
  }

  private const val TAG = "AuthStore"
}
