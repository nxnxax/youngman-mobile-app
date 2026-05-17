package com.youngmanapp.callrecording

import android.content.ContentUris
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.module.annotations.ReactModule

/**
 * Native module exposing a single method to JS: scanAudio().
 *
 * Returns the full list of audio files visible via MediaStore.Audio, sorted by
 * date_added DESC. Filtering for "is this a call recording" is intentionally
 * done in JS (see heuristics.ts) so we can update patterns without shipping a
 * native binary.
 */
@ReactModule(name = RecordingScannerModule.NAME)
class RecordingScannerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun scanAudio(promise: Promise) {
    try {
      val collection: Uri =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
          } else {
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
          }

      val projection = buildProjection()
      val result: WritableArray = Arguments.createArray()

      reactApplicationContext.contentResolver
          .query(collection, projection, null, null, "${MediaStore.Audio.Media.DATE_ADDED} DESC")
          ?.use { cursor: Cursor ->
            val idCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
            val nameCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
            val pathCol =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                  cursor.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH)
                } else -1
            val dateCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED)
            val durCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
            val mimeCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE)
            val sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)

            while (cursor.moveToNext()) {
              val id = cursor.getLong(idCol)
              val uri = ContentUris.withAppendedId(collection, id)
              val map = Arguments.createMap()
              map.putString("id", id.toString())
              map.putString("uri", uri.toString())
              map.putString("displayName", cursor.getString(nameCol) ?: "")
              map.putString(
                  "relativePath",
                  if (pathCol >= 0) cursor.getString(pathCol) ?: "" else "")
              map.putDouble("dateAdded", cursor.getLong(dateCol).toDouble())
              map.putDouble("duration", cursor.getLong(durCol).toDouble())
              map.putString("mimeType", cursor.getString(mimeCol) ?: "")
              map.putDouble("size", cursor.getLong(sizeCol).toDouble())
              result.pushMap(map)
            }
          }

      promise.resolve(result)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_DENIED", e.message, e)
    } catch (e: Exception) {
      promise.reject("SCAN_FAILED", e.message, e)
    }
  }

  private fun buildProjection(): Array<String> {
    val base =
        mutableListOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.DATE_ADDED,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.MIME_TYPE,
            MediaStore.Audio.Media.SIZE,
        )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      base += MediaStore.Audio.Media.RELATIVE_PATH
    }
    return base.toTypedArray()
  }

  companion object {
    const val NAME = "RecordingScanner"
  }
}
