package com.youngmanapp.ledger

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persistent native cache of the user's ledger groups. JS pushes the latest
 * list after fetching from the server (`fetchLedgerGroups`); the native
 * OverlayService reads it synchronously to build the chip selector inside the
 * post-call glass modal — no JS bridge round-trip required at modal time.
 *
 * Storage: SharedPreferences key `ledger_groups_v1`, value = JSON string.
 */
object LedgerGroupsCache {

  private const val PREFS = "ledger_groups_v1"
  private const val KEY_JSON = "groups_json"

  data class Group(
      val id: String,
      val title: String,
      val position: Int,
      val isMain: Boolean,
  )

  fun write(ctx: Context, json: String) {
    try {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
          .edit()
          .putString(KEY_JSON, json)
          .apply()
    } catch (e: Exception) {
      Log.w(TAG, "write failed", e)
    }
  }

  fun read(ctx: Context): List<Group> {
    return try {
      val raw =
          ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
              .getString(KEY_JSON, null)
              ?: return emptyList()
      val arr = JSONObject(raw).optJSONArray("groups") ?: JSONArray()
      val out = ArrayList<Group>(arr.length())
      for (i in 0 until arr.length()) {
        val o = arr.optJSONObject(i) ?: continue
        val id = o.optString("id")
        val title = o.optString("title")
        if (id.isNullOrEmpty() || title.isNullOrEmpty()) continue
        out.add(
            Group(
                id = id,
                title = title,
                position = o.optInt("position", i),
                isMain = o.optBoolean("is_main", false),
            )
        )
      }
      // Main group first (so it's the default selection + leftmost chip), then
      // remaining groups by position.
      out.sortedWith(compareByDescending<Group> { it.isMain }.thenBy { it.position })
    } catch (e: Exception) {
      Log.w(TAG, "read failed", e)
      emptyList()
    }
  }

  fun clear(ctx: Context) {
    try {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    } catch (_: Exception) {}
  }

  private const val TAG = "LedgerGroupsCache"
}
