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
import java.util.concurrent.atomic.AtomicReference
import com.youngmanapp.R
import com.youngmanapp.callrecording.RecordingState
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
/** 사장님 정책 (2026-05-21 비상 fix): 모달의 4가지 chain (사용자 review / submit /
 *  auto-dismiss / idle) 중 최초 진입한 것만 허용. 두 chain 동시 실행 시 RN ↔
 *  Native ↔ WebView token sync race 발생 → Supabase 403 + SummaryReview stale. */
enum class OverlayAction {
  NONE,
  REVIEW,
  SUBMIT,
  AUTODISMISS,
}

class OverlayService : Service() {

  private var overlayView: View? = null
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var windowManager: WindowManager

  /** null means "기본 그룹 (자동 생성)" — server will create or reuse the default. */
  private var selectedGroupId: String? = null

  /** 사장님 정책 (2026-05-21 비상 fix, ChatGPT 진단): review/submit/autoDismiss
   *  3개 chain 이 동시 실행되면 RN↔Native↔WebView 3-way token sync race +
   *  SummaryReview stale state 발생. 최초 진입한 한 chain 만 허용 (single-owner
   *  lock). 새 모달 표시 시 NONE 으로 reset. */
  private val action = AtomicReference(OverlayAction.NONE)

  /** 현재 모달에 표시 중인 통화녹음 정보. auto-dismiss 시 자동 양식 전송에
   *  사용 (사장님 정책 2026-05-21 — auto-dismiss = 미확인 요약 자동 저장).
   *  사용자 명시 취소 (취소 버튼) 와 구분. */
  private var currentUri: String? = null
  private var currentName: String = ""
  private var currentDuration: Long = 0L
  private var currentDateAdded: Long = 0L
  private var currentMimeType: String = "audio/mp4"

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

    // 사장님 정책 (2026-05-21 구조 변경): placeholder mode — 통화 끝나자마자
    // 즉시 모달 표시 (파일 매칭 안 기다림). PostCallScanService 가 매칭한 후
    // 두 번째 intent (data 포함) 보내면 모달 업데이트.
    val isPlaceholder = intent.getBooleanExtra(EXTRA_PLACEHOLDER, false)

    if (isPlaceholder) {
      // 통화 종료 직후 즉시 모달. 사용자 시각적 "통화 끊자마자 모달".
      if (overlayView == null) {
        Log.d(TAG, "placeholder mode → showOverlay (uri 없이)")
        showOverlay(uri = null, name = "", duration = 0L, dateAdded = 0L, mimeType = "audio/mp4")
        scheduleAutoDismiss()
      }
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

    // dedup — 이미 모달이 떠있고 (placeholder 든 data 든) 같은 파일이면 skip.
    if (RecordingState.isFileShown(this, name)) {
      Log.d(TAG, "dedup: file '$name' already shown — skip")
      // 단 placeholder 가 떠있으면 update 는 해줘야 (autoDismiss 가 valid uri
      // 로 startAutoSubmit 가능). dedup 만 차단 — view 자체는 update.
      if (overlayView != null) {
        updateOverlayData(uri, name, duration, dateAdded, mimeType)
        currentUri = uri
        currentName = name
        currentDuration = duration
        currentDateAdded = dateAdded
        currentMimeType = mimeType
      } else {
        stopSelf()
      }
      return START_NOT_STICKY
    }

    if (overlayView != null) {
      // placeholder 가 이미 떠있음 — data 업데이트.
      Log.d(TAG, "update overlay with data uri=$uri name=$name")
      updateOverlayData(uri, name, duration, dateAdded, mimeType)
    } else {
      // 처음부터 data 와 함께 (PostCallScanService 가 placeholder 없이 직접 호출).
      showOverlay(uri, name, duration, dateAdded, mimeType)
      scheduleAutoDismiss()
    }
    RecordingState.markFileShown(this, name)

    currentUri = uri
    currentName = name
    currentDuration = duration
    currentDateAdded = dateAdded
    currentMimeType = mimeType

    return START_NOT_STICKY
  }

  /** placeholder 로 표시된 모달의 텍스트만 데이터로 update. addView 다시 안
   *  함 — 같은 view 재사용. group picker 도 그대로. */
  private fun updateOverlayData(
      uri: String,
      name: String,
      duration: Long,
      dateAdded: Long,
      mimeType: String,
  ) {
    val view = overlayView ?: return
    try {
      view.findViewById<TextView>(R.id.overlay_subtitle).text = buildSubtitle(name, duration)
      // 버튼들 click listener 재바인딩 (uri 가 새로 들어왔음).
      view.findViewById<View>(R.id.overlay_btn_review).setOnClickListener {
        if (!action.compareAndSet(OverlayAction.NONE, OverlayAction.REVIEW)) {
          Log.d(TAG, "review click ignored — action already=${action.get()}")
          return@setOnClickListener
        }
        openReview(uri, name, duration, dateAdded, mimeType)
        dismiss()
      }
      view.findViewById<View>(R.id.overlay_btn_submit).setOnClickListener {
        if (!action.compareAndSet(OverlayAction.NONE, OverlayAction.SUBMIT)) {
          Log.d(TAG, "submit click ignored — action already=${action.get()}")
          return@setOnClickListener
        }
        startAutoSubmit(uri, name, duration, dateAdded, mimeType, pendingReview = false)
        dismiss()
      }
    } catch (e: Throwable) {
      Log.w(TAG, "updateOverlayData failed", e)
    }
  }

  /** 사장님 정책 (2026-05-21): auto-dismiss = 사용자 명시 취소가 아님 →
   *  자동으로 양식 전송 시작 (미확인 요약에 자동 보존). 취소 버튼 누른 경우
   *  와 명확히 구분. AutoSubmit 은 upload + processRecording 진행 후 server
   *  의 review_mode 에 따라 ready_to_review 상태로 저장 → 미확인 요약 화면. */
  private val autoDismiss = Runnable {
    // single-owner: 사용자가 이미 review/submit 누른 상태면 autoDismiss 진입 금지.
    if (!action.compareAndSet(OverlayAction.NONE, OverlayAction.AUTODISMISS)) {
      Log.d(TAG, "auto-dismiss skipped — action already=${action.get()}")
      dismiss()
      return@Runnable
    }
    val uri = currentUri
    if (uri != null) {
      Log.d(TAG, "auto-dismiss → startAutoSubmit pendingReview=true (미확인 요약 보존)")
      startAutoSubmit(
        uri, currentName, currentDuration, currentDateAdded, currentMimeType,
        pendingReview = true,
      )
    }
    dismiss()
  }

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
      uri: String?,
      name: String,
      duration: Long,
      dateAdded: Long,
      mimeType: String,
  ) {
    dismissView()
    // 새 모달 표시 = 새 사이클. 이전 모달의 action lock 해제.
    action.set(OverlayAction.NONE)

    val view = LayoutInflater.from(this).inflate(R.layout.overlay_recording_found, null, false)

    // Any touch inside the modal (chip tap, dropdown scroll, blank space) resets
    // the inactivity timer so the modal does not vanish mid-interaction.
    (view as? DismissableTouchFrameLayout)?.onUserTouch = { scheduleAutoDismiss() }

    // 사장님 정책 (2026-05-21 구조 변경): placeholder mode 이면 uri null →
    // "통화녹음 분석 중..." subtitle. data 모드 면 정상 subtitle. updateOverlayData
    // 가 두 번째 intent 받으면 subtitle 다시 update.
    view.findViewById<TextView>(R.id.overlay_subtitle).text =
        if (uri == null) "통화녹음 분석 중..."
        else buildSubtitle(name, duration)

    setupGroupPicker(view)

    view.findViewById<View>(R.id.overlay_btn_cancel).setOnClickListener { dismiss() }

    // placeholder mode: 버튼 누르면 짧은 안내 후 비활성. data 받기 전엔 startAutoSubmit
    // 불가 (uri null). 두 번째 intent (data) 가 onStartCommand → updateOverlayData
    // 호출 → 버튼 listener 재바인딩 → 정상 작동.
    view.findViewById<View>(R.id.overlay_btn_review).setOnClickListener {
      if (uri == null) return@setOnClickListener  // placeholder mode
      if (!action.compareAndSet(OverlayAction.NONE, OverlayAction.REVIEW)) {
        Log.d(TAG, "review click ignored — action already=${action.get()}")
        return@setOnClickListener
      }
      openReview(uri, name, duration, dateAdded, mimeType)
      dismiss()
    }

    view.findViewById<View>(R.id.overlay_btn_submit).setOnClickListener {
      if (uri == null) return@setOnClickListener  // placeholder mode
      if (!action.compareAndSet(OverlayAction.NONE, OverlayAction.SUBMIT)) {
        Log.d(TAG, "submit click ignored — action already=${action.get()}")
        return@setOnClickListener
      }
      startAutoSubmit(uri, name, duration, dateAdded, mimeType, pendingReview = false)
      dismiss()
    }

    val type =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

    // 사장님 정책 (2026-05-21 도미노): 잠금화면 위 모달 표시. 통화 전 모달
    // (IncomingCallOverlayService) 과 동일한 flag 조합. FLAG_DIM_BEHIND 가
    // 잠금화면 위 표시를 막는 것으로 추정 — 제거. dim backdrop 효과 사라
    // 지지만 모달 자체는 잠금화면 위에 정상 표시.
    @Suppress("DEPRECATION")
    val flags =
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON

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
      pendingReview: Boolean,
  ) {
    // 사장님 정책 (2026-05-21): pendingReview=true (auto-dismiss) 시엔 사용자가
    // 모달 보고 있지 않음 — ProgressOverlay 갑자기 띄우면 짜증. 양식 전송 명시
    // (false) 시에만 5초 progress card 표시.
    if (!pendingReview) {
      ProgressOverlayService.start(this)
    }

    val intent =
        Intent(this, AutoSubmitService::class.java).apply {
          putExtra(EXTRA_URI, uri)
          putExtra(EXTRA_NAME, name)
          putExtra(EXTRA_DURATION, duration)
          putExtra(EXTRA_DATE_ADDED, dateAdded)
          putExtra(EXTRA_MIME, mimeType)
          // pendingReview=true 면 group_id 안 보냄 → server 가 ready_to_review
          // 로 저장 (미확인 요약). false 면 선택한 그룹으로 즉시 mirror.
          if (!pendingReview) {
            selectedGroupId?.let { putExtra(EXTRA_GROUP_ID, it) }
          }
          putExtra(EXTRA_PENDING_REVIEW, pendingReview)
        }
    try {
      // Plain startService — NOT a foreground service. The user's tap on
      // this overlay grants us the background-start exemption on Android
      // 12+, so this call succeeds even though OverlayService itself runs
      // in the background. The trade-off (no FGS = no visible notification
      // = OS may reclaim under memory pressure) is intentional — see
      // AutoSubmitService kdoc.
      startService(intent)
    } catch (e: Exception) {
      Log.w(TAG, "startService(AutoSubmit) failed", e)
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
    // 사장님 정책 (2026-05-21 비상 fix, ChatGPT 권고): autoDismiss 외에도 attach
    // 됐을 수 있는 다른 callback (group picker animations 등) 까지 모두 제거.
    // remaining race window 차단.
    handler.removeCallbacksAndMessages(null)
    dismissView()
    stopSelf()
  }

  private fun dismissView() {
    val view = overlayView ?: return
    try {
      windowManager.removeView(view)
    } catch (_: Exception) {}
    overlayView = null
    // auto-dismiss 가 이미 처리한 후 reset — 같은 service instance 가 새 모달
    // 받을 때 fresh state.
    currentUri = null
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
    const val EXTRA_PENDING_REVIEW = "pendingReview"
    /** 사장님 정책 (2026-05-21 구조 변경): true 면 placeholder 모달 표시.
     *  통화 끝나자마자 즉시 표시 → PostCallScanService 매칭 후 data update. */
    const val EXTRA_PLACEHOLDER = "placeholder"
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
