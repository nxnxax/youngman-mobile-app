package com.youngmanapp.overlay

import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import com.youngmanapp.R
import com.youngmanapp.ledger.LedgerGroupsCache
import com.youngmanapp.logging.ErrorLog
import com.youngmanapp.settings.SettingsStore
import com.youngmanapp.telephony.PostCallScanService

/**
 * Renders a glass-style centered overlay card after a call ends, offering the
 * user 3 actions: cancel / 요약보기 / 양식에 전송. Auto-dismisses after 10s if
 * the user doesn't interact.
 *
 * Requires SYSTEM_ALERT_WINDOW permission (granted via Settings UI). When the
 * permission is not granted, the service silently no-ops — caller should
 * detect the state and prompt the user separately.
 */
class OverlayService : Service() {

  private var overlayView: View? = null
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var windowManager: WindowManager

  /** null means "기본 그룹 (자동 생성)" — server will create or reuse the default. */
  private var selectedGroupId: String? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.d(TAG, "onStartCommand intent=${intent != null}")
    if (intent == null) {
      stopSelf()
      return START_NOT_STICKY
    }

    val perm = hasOverlayPermission()
    Log.d(TAG, "hasOverlayPermission=$perm")
    if (!perm) {
      stopSelf()
      return START_NOT_STICKY
    }

    val uri = intent.getStringExtra(EXTRA_URI)
    val name = intent.getStringExtra(EXTRA_NAME) ?: ""
    val duration = intent.getLongExtra(EXTRA_DURATION, 0L)
    val dateAdded = intent.getLongExtra(EXTRA_DATE_ADDED, 0L)
    val mimeType = intent.getStringExtra(EXTRA_MIME) ?: "audio/mp4"

    Log.d(TAG, "extras uri=${uri != null} name=$name duration=$duration")

    if (uri == null) {
      stopSelf()
      return START_NOT_STICKY
    }

    showOverlay(uri, name, duration, dateAdded, mimeType)
    scheduleAutoDismiss()
    return START_NOT_STICKY
  }

  private val autoDismiss = Runnable { dismiss() }

  /** Reset the inactivity timer — called on the initial show AND on every
   *  user touch routed through the overlay root view. Dwell time is read from
   *  user Settings (10 / 15 / 20s); falls back to AUTO_DISMISS_MS_DEFAULT. */
  private fun scheduleAutoDismiss() {
    handler.removeCallbacks(autoDismiss)
    val dwell = SettingsStore.read(this).modalDwellMs
    handler.postDelayed(autoDismiss, if (dwell > 0) dwell else AUTO_DISMISS_MS_DEFAULT)
  }

  private fun hasOverlayPermission(): Boolean =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(this) else true

  private fun showOverlay(
      uri: String,
      name: String,
      duration: Long,
      dateAdded: Long,
      mimeType: String,
  ) {
    dismissView()

    val view = LayoutInflater.from(this).inflate(R.layout.overlay_recording_found, null, false)

    // Any touch inside the modal (chip tap, dropdown scroll, blank space) resets
    // the inactivity timer so the modal does not vanish mid-interaction.
    (view as? DismissableTouchFrameLayout)?.onUserTouch = { scheduleAutoDismiss() }

    view.findViewById<TextView>(R.id.overlay_subtitle).text = buildSubtitle(name, duration)

    setupGroupPicker(view)

    view.findViewById<View>(R.id.overlay_btn_cancel).setOnClickListener { dismiss() }

    view.findViewById<View>(R.id.overlay_btn_review).setOnClickListener {
      openReview(uri, name, duration, dateAdded, mimeType)
      dismiss()
    }

    view.findViewById<View>(R.id.overlay_btn_submit).setOnClickListener {
      startAutoSubmit(uri, name, duration, dateAdded, mimeType)
      dismiss()
    }

    val type =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

    // iOS-style alert: solid white card on top of a dimmed backdrop. No blur.
    val flags =
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_DIM_BEHIND

    val params =
        WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            flags,
            PixelFormat.TRANSLUCENT,
        )
    params.gravity = Gravity.CENTER_HORIZONTAL or Gravity.CENTER_VERTICAL
    params.dimAmount = 0.35f

    try {
      windowManager.addView(view, params)
      overlayView = view
      Log.d(TAG, "overlay view added successfully")
    } catch (e: Exception) {
      Log.w(TAG, "addView failed", e)
      ErrorLog.append(this, TAG, "overlay addView failed", e)
      stopSelf()
    }
  }

  private fun openReview(
      uri: String,
      name: String,
      duration: Long,
      dateAdded: Long,
      mimeType: String,
  ) {
    val deepLink =
        Uri.Builder()
            .scheme("youngman")
            .authority("record")
            .appendPath("confirm")
            .appendQueryParameter("uri", uri)
            .appendQueryParameter("name", name)
            .appendQueryParameter("duration", duration.toString())
            .appendQueryParameter("dateAdded", dateAdded.toString())
            .appendQueryParameter("mimeType", mimeType)
            .build()
    val intent =
        Intent(Intent.ACTION_VIEW, deepLink).apply {
          flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
          `package` = packageName
        }
    try {
      startActivity(intent)
    } catch (_: Exception) {
      // No-op; if launch fails (rare), user can still open the app manually.
    }
  }

  private fun startAutoSubmit(
      uri: String,
      name: String,
      duration: Long,
      dateAdded: Long,
      mimeType: String,
  ) {
    // Thin progress bar at the top of the screen — visible from the moment
    // the modal dismisses until the success alert appears. autoSubmitTask
    // calls ProgressOverlay.hide() right before it pops the success overlay.
    ProgressOverlayService.start(this)

    val intent =
        Intent(this, AutoSubmitService::class.java).apply {
          putExtra(EXTRA_URI, uri)
          putExtra(EXTRA_NAME, name)
          putExtra(EXTRA_DURATION, duration)
          putExtra(EXTRA_DATE_ADDED, dateAdded)
          putExtra(EXTRA_MIME, mimeType)
          // selectedGroupId == null means "default group" — HeadlessJsTask reads
          // missing/null extra and the JS task forwards null to the server.
          selectedGroupId?.let { putExtra(EXTRA_GROUP_ID, it) }
        }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        startForegroundService(intent)
      } else {
        startService(intent)
      }
    } catch (_: Exception) {
      // ignore
    }
  }

  private fun setupGroupPicker(root: View) {
    val chip = root.findViewById<View>(R.id.overlay_group_chip)
    val chipLabel = root.findViewById<TextView>(R.id.overlay_group_chip_label)
    val listScroll = root.findViewById<View>(R.id.overlay_group_list_scroll)
    val listContainer = root.findViewById<LinearLayout>(R.id.overlay_group_list)

    val groups = LedgerGroupsCache.read(this)
    val mainGroup = groups.firstOrNull { it.isMain }

    selectedGroupId = mainGroup?.id
    chipLabel.text = mainGroup?.title ?: DEFAULT_GROUP_LABEL

    chip.setOnClickListener {
      val expanded = listScroll.visibility == View.VISIBLE
      if (expanded) {
        listScroll.visibility = View.GONE
      } else {
        populateGroupList(listContainer, listScroll, chipLabel, groups)
        listScroll.visibility = View.VISIBLE
      }
    }
  }

  private fun populateGroupList(
      container: LinearLayout,
      scroll: View,
      chipLabel: TextView,
      groups: List<LedgerGroupsCache.Group>,
  ) {
    container.removeAllViews()
    groups.forEach { g ->
      addGroupListItem(container, scroll, chipLabel, label = g.title, id = g.id)
    }
    // Sentinel: "기본 그룹 (자동 생성)" — for explicit new-group intent.
    addGroupListItem(
        container,
        scroll,
        chipLabel,
        label = DEFAULT_GROUP_LABEL,
        id = null,
    )
  }

  private fun addGroupListItem(
      container: LinearLayout,
      scroll: View,
      chipLabel: TextView,
      label: String,
      id: String?,
  ) {
    val isSelected = id == selectedGroupId
    val row = TextView(this).apply {
      text = if (isSelected) "✓  $label" else label
      textSize = 13f
      setTextColor(if (isSelected) 0xFF0066FF.toInt() else 0xFF222222.toInt())
      setTypeface(null, if (isSelected) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
      isSingleLine = true
      ellipsize = android.text.TextUtils.TruncateAt.END
      val padH = dpToPx(14)
      val padV = dpToPx(11)
      setPadding(padH, padV, padH, padV)
      if (isSelected) {
        setBackgroundResource(R.drawable.group_list_item_selected)
      }
      tag = id
    }
    row.setOnClickListener {
      selectedGroupId = id
      chipLabel.text = label
      scroll.visibility = View.GONE
    }
    container.addView(row, LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
    ))
  }

  private fun dismiss() {
    handler.removeCallbacks(autoDismiss)
    dismissView()
    stopSelf()
  }

  private fun dismissView() {
    val view = overlayView ?: return
    try {
      windowManager.removeView(view)
    } catch (_: Exception) {}
    overlayView = null
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    dismissView()
    super.onDestroy()
  }

  private fun dpToPx(dp: Int): Int = (dp * resources.displayMetrics.density).toInt()

  private fun buildSubtitle(name: String, durationMs: Long): String {
    val phone = extractPhone(name)
    val seconds = (durationMs / 1000).toInt()
    val minutes = seconds / 60
    val rem = seconds % 60
    val durText = if (minutes > 0) "${minutes}분 ${rem}초" else "${rem}초"
    val prefix = phone ?: "통화녹음 발견"
    return "$prefix · $durText"
  }

  private fun extractPhone(name: String): String? {
    val mobile = Regex("(01[016789])[- _]?(\\d{3,4})[- _]?(\\d{4})").find(name)
    if (mobile != null) {
      return "${mobile.groupValues[1]}-${mobile.groupValues[2]}-${mobile.groupValues[3]}"
    }
    val seoul = Regex("(02)[- _]?(\\d{3,4})[- _]?(\\d{4})").find(name)
    if (seoul != null) {
      return "${seoul.groupValues[1]}-${seoul.groupValues[2]}-${seoul.groupValues[3]}"
    }
    return null
  }

  companion object {
    private const val TAG = "OverlayService"
    const val EXTRA_URI = "uri"
    const val EXTRA_NAME = "name"
    const val EXTRA_DURATION = "duration"
    const val EXTRA_DATE_ADDED = "dateAdded"
    const val EXTRA_MIME = "mimeType"
    const val EXTRA_GROUP_ID = "groupId"
    const val AUTO_DISMISS_MS_DEFAULT = 15_000L
    private const val DEFAULT_GROUP_LABEL = "기본 그룹 (자동 생성)"

    fun start(ctx: Context, found: PostCallScanService.FoundFile) {
      Log.d(TAG, "start() called for ${found.displayName}")
      val intent =
          Intent(ctx, OverlayService::class.java).apply {
            putExtra(EXTRA_URI, found.uri)
            putExtra(EXTRA_NAME, found.displayName)
            putExtra(EXTRA_DURATION, found.duration)
            putExtra(EXTRA_DATE_ADDED, found.dateAdded)
            putExtra(EXTRA_MIME, "audio/mp4")
          }
      try {
        ctx.startService(intent)
      } catch (e: Exception) {
        Log.w(TAG, "startService failed", e)
        ErrorLog.append(ctx, TAG, "startService failed", e)
      }
    }
  }
}
