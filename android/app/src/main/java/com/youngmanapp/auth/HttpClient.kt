package com.youngmanapp.auth

import android.content.Context
import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Tiny HttpURLConnection-based POST client for native-side API calls
 * (CallScreeningService incoming-call lookup). No external deps. Caller
 * provides the JWT explicitly — usually fetched from [AuthStore.readJwt].
 *
 * Blocking — must be called from a background thread.
 */
object HttpClient {

  private const val TAG = "HttpClient"

  data class Response(val status: Int, val body: String)

  /** POST JSON. Returns null on transport failure. */
  fun postJson(url: String, jwt: String?, jsonBody: String): Response? {
    var conn: HttpURLConnection? = null
    try {
      conn = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        setRequestProperty("Content-Type", "application/json")
        if (!jwt.isNullOrEmpty()) {
          setRequestProperty("Authorization", "Bearer $jwt")
        }
        connectTimeout = 8_000
        readTimeout = 8_000
        doOutput = true
      }
      OutputStreamWriter(conn.outputStream).use { it.write(jsonBody) }
      val status = conn.responseCode
      val stream = if (status in 200..299) conn.inputStream else conn.errorStream
      val body = stream?.let { s ->
        BufferedReader(InputStreamReader(s)).use { it.readText() }
      } ?: ""
      return Response(status, body)
    } catch (e: Exception) {
      Log.w(TAG, "postJson failed url=$url", e)
      return null
    } finally {
      conn?.disconnect()
    }
  }

  /** GET. Returns null on transport failure. */
  fun get(url: String, jwt: String?): Response? {
    var conn: HttpURLConnection? = null
    try {
      conn = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        if (!jwt.isNullOrEmpty()) {
          setRequestProperty("Authorization", "Bearer $jwt")
        }
        connectTimeout = 8_000
        readTimeout = 8_000
      }
      val status = conn.responseCode
      val stream = if (status in 200..299) conn.inputStream else conn.errorStream
      val body = stream?.let { s ->
        BufferedReader(InputStreamReader(s)).use { it.readText() }
      } ?: ""
      return Response(status, body)
    } catch (e: Exception) {
      Log.w(TAG, "get failed url=$url", e)
      return null
    } finally {
      conn?.disconnect()
    }
  }
}

/**
 * Native customer_log lookup. Returns the most recent customer_log matching
 * the given phone number (normalized) along with how many earlier ones exist.
 * Hits the same /records.php endpoint the RN side uses; we just bypass RN.
 *
 * Returns null on transport failure, auth failure, or zero matches.
 */
object CustomerLogClient {

  private const val TAG = "CustomerLogClient"
  private const val BASE_URL = "https://youngman-biz.com"

  data class Match(
      val customerName: String?,
      val summary: String?,
      val callCount: Int,
  )

  fun findByPhone(ctx: Context, rawPhone: String?): Match? {
    val wanted = normalizePhone(rawPhone)
    if (wanted.isEmpty()) return null
    val jwt = AuthStore.readJwt(ctx) ?: run {
      Log.d(TAG, "no JWT in native cache — skip lookup")
      return null
    }
    val body = """{"action":"customer_log_list","limit":200,"before":null}"""
    val resp = HttpClient.postJson(
        "$BASE_URL/records.php?resource=customer-log",
        jwt,
        body,
    ) ?: return null
    if (resp.status !in 200..299) {
      Log.w(TAG, "customer_log_list status=${resp.status}")
      return null
    }
    return try {
      val json = org.json.JSONObject(resp.body)
      val items = json.optJSONArray("items") ?: return null
      val hits = mutableListOf<org.json.JSONObject>()
      for (i in 0 until items.length()) {
        val item = items.optJSONObject(i) ?: continue
        val phone = normalizePhone(item.optString("phone_number"))
        if (phone == wanted) hits.add(item)
      }
      if (hits.isEmpty()) return null
      val latest = hits[0] // list is date-desc; latest first
      Match(
          customerName = latest.optString("customer_name").takeIf { it.isNotBlank() },
          summary = latest.optString("summary").takeIf { it.isNotBlank() },
          callCount = hits.size,
      )
    } catch (e: Exception) {
      Log.w(TAG, "parse failed", e)
      null
    }
  }

  /** Mirror of RN side normalize() — digits only, strip Korea +82 prefix. */
  fun normalizePhone(raw: String?): String {
    if (raw == null) return ""
    val digits = raw.replace(Regex("\\D"), "")
    return if (digits.startsWith("82") && digits.length >= 11) {
      "0" + digits.substring(2)
    } else digits
  }
}
