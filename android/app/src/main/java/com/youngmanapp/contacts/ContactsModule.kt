package com.youngmanapp.contacts

import android.net.Uri
import android.provider.ContactsContract
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

/**
 * Native module exposing a single method to JS: lookupByPhoneNumber(phoneNumber).
 *
 * Uses ContactsContract.PhoneLookup which handles fuzzy phone-number matching
 * across all stored formats (with/without country code, with/without dashes,
 * etc.). Returns the contact's display name when a match exists, or null.
 *
 * Requires the runtime READ_CONTACTS permission. The JS wrapper requests it
 * lazily on first lookup.
 */
@ReactModule(name = ContactsModule.NAME)
class ContactsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun lookupByPhoneNumber(phoneNumber: String?, promise: Promise) {
    try {
      if (phoneNumber.isNullOrBlank()) {
        promise.resolve(null)
        return
      }
      val uri =
          Uri.withAppendedPath(
              ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
              Uri.encode(phoneNumber),
          )
      val projection = arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME)
      reactApplicationContext.contentResolver.query(uri, projection, null, null, null)?.use {
          cursor ->
        if (cursor.moveToFirst()) {
          val nameCol = cursor.getColumnIndex(ContactsContract.PhoneLookup.DISPLAY_NAME)
          val name = if (nameCol >= 0) cursor.getString(nameCol) else null
          if (!name.isNullOrBlank()) {
            val result = Arguments.createMap()
            result.putString("name", name)
            promise.resolve(result)
            return
          }
        }
      }
      promise.resolve(null)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_DENIED", e.message, e)
    } catch (e: Exception) {
      promise.reject("LOOKUP_FAILED", e.message, e)
    }
  }

  companion object {
    const val NAME = "Contacts"
  }
}
