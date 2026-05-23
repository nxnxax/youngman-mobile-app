package com.youngmanapp.overlay

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.app.Activity
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.youngmanapp.R
import com.youngmanapp.callrecording.RecordingState
import com.youngmanapp.ledger.LedgerGroupsCache
import com.youngmanapp.settings.SettingsStore
import com.youngmanapp.telephony.PostCallScanService

/**
 * 사장님 정책 (2026-05-22 §3 Activity 기반 모달): 통화 후 모달.
 *
 * 옛 구조: OverlayService (WindowManager.addView TYPE_APPLICATION_OVERLAY)
 *   → SYSTEM_ALERT_WINDOW 권한 필수. 권한 미부여 시 모달 자체 불가.
 * 새 구조: 본 Activity 가 fullscreen 으로 떠서 통화앱 위에 표시.
 *   → SYSTEM_ALERT_WINDOW 권한 불필요. Activity 권한만으로 작동.
 *
 * placeholder + data update 패턴 유지 ([[project-post-call-modal-pattern]]).
 *   - onCreate: placeholder mode (uri null) 또는 data mode (uri 있음)
 *   - onNewIntent: placeholder → data 전환 (PostCallScanService 가 file 매칭 후
 *     같은 Activity 의 onNewIntent 로 데이터 push). launchMode singleTop.
 */
class CallPostActivity : Activity() {

  private val handler = Handler(Looper.getMainLooper())
  // 사장님 정책 (v44 2026-05-23 영맨 긴급): 모달 자동 종료 시 audio 업로드
  // (processRecording audio_pending) 만 background 호출 → 미확인 요약 자동 보관.
  // trigger_summarize 는 호출 X (pendingReview=true 로 분기). 사용자가 미확인
  // 요약에서 나중에 trigger. 사용자가 명시적 [취소] 누른 경우만 단순 finish (폐기).
  private val autoDismiss = Runnable {
    val u = currentUri
    if (u != null) {
      startAutoSubmit(u, currentName, currentDuration, currentDateAdded, currentMimeType, true)
    }
    finish()
  }

  // 사장님 정책 (2026-05-22 UX): placeholder 모드에서 "처리중" / "AI 분석 중"
  // 같은 시스템 상태 텍스트 노출 금지. dots pulse 만 표시 (cafe24 commit 5145cb5
  // 와 동일 시각). file 매칭 후 data 모드로 전환되면 dots 멈추고 실제 정보 노출.
  private var dotsRunnable: Runnable? = null
  private var dotsPhase = 0
  private val dotsFrames = arrayOf("●  ○  ○", "○  ●  ○", "○  ○  ●", "○  ●  ○")

  private fun startDots(target: TextView) {
    stopDots()
    dotsPhase = 0
    dotsRunnable = object : Runnable {
      override fun run() {
        target.text = dotsFrames[dotsPhase % dotsFrames.size]
        dotsPhase++
        handler.postDelayed(this, 450)
      }
    }
    handler.post(dotsRunnable!!)
  }

  private fun stopDots() {
    dotsRunnable?.let { handler.removeCallbacks(it) }
    dotsRunnable = null
  }

  private var currentUri: String? = null
  private var currentName: String = ""
  private var currentDuration: Long = 0L
  private var currentDateAdded: Long = 0L
  private var currentMimeType: String = "audio/mp4"

  private var selectedGroupId: String? = null

  // 사장님 정책 (2026-05-22 PM v24 PoC logcat 분석): onCreate 가 첫 launch
  // 인지 onNewIntent 인지 구분해 dedup 적용 분기. POST_CALL → onCreate 는 새
  // 통화 시작이라 dedup check. startWithData → onNewIntent 는 같은 통화의
  // data update 라 dedup skip. 둘 다 같은 bind() 함수 사용하므로 flag 로 전달.
  private var isFirstBind = true

  // 사장님 정책 (2026-05-22 PM v30 진짜 도미노 fix): placeholder mode (file
  // 매칭 전 currentUri=null) 에서 사장님 click 시 currentUri null 체크로 return
  // early → 무반응. 사장님이 모달 뜨자마자 click = placeholder click = 무시됨.
  // 해결: placeholder click 도 pending flag 로 보존. file 매칭 후 bind() data
  // branch 에서 자동 openReview / startAutoSubmit.
  private var pendingReviewClick = false
  private var pendingSubmitClick = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // 사장님 정책 (2026-05-22 PM): 통화 성사된 통화만 모달 표시. 거절 / 안받음
    // (RINGING → IDLE 인 미수신) 시점에는 system POST_CALL action 이 자동 발행
    // 되지만 영맨이 표시 X. disconnect cause 체크 후 REJECTED / MISSED 면 즉시
    // finish — UI 표시 없이 종료.
    if (intent?.action == ACTION_POST_CALL) {
      val cause = intent.getIntExtra(EXTRA_DISCONNECT_CAUSE, DISCONNECT_CAUSE_UNKNOWN)
      if (cause == DISCONNECT_CAUSE_REJECTED || cause == DISCONNECT_CAUSE_MISSED) {
        Log.d(TAG, "POST_CALL skipped — no connected call (cause=$cause)")
        finish()
        return
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    }
    // 사장님 정책 (v37 2026-05-23): window 풀스크린 (MATCH_PARENT x MATCH_PARENT).
    // normal_card 모드 = transparent backdrop + 가운데 카드 (사용자 보던 화면 비침).
    // loading_card 모드 = 흰 풀스크린 (검정/회색 X). showLoadingCard 토글 시점에
    // window 자체는 그대로 풀스크린, view 만 swap.
    window.addFlags(
      WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
    )
    window.setLayout(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
    )
    setContentView(R.layout.overlay_recording_found)
    bind(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    bind(intent)
  }

  /** placeholder 모드 또는 data 모드로 view 채움. */
  private fun bind(intent: Intent) {
    val placeholder = intent.getBooleanExtra(EXTRA_PLACEHOLDER, false)
    val uri = intent.getStringExtra(EXTRA_URI)
    val name = intent.getStringExtra(EXTRA_NAME) ?: ""
    val duration = intent.getLongExtra(EXTRA_DURATION, 0L)
    val dateAdded = intent.getLongExtra(EXTRA_DATE_ADDED, 0L)
    val mimeType = intent.getStringExtra(EXTRA_MIME) ?: "audio/mp4"

    val subtitleView = findViewById<TextView>(R.id.overlay_subtitle)
    if (placeholder || uri == null) {
      // 사장님 정책 (2026-05-22 UX): placeholder 모드 = 시스템 상태 텍스트
      // 노출 X. dots pulse 만 표시.
      startDots(subtitleView)
      currentUri = null
    } else {
      // 사장님 정책 (2026-05-22 PM v24 PoC fix): dedup 은 첫 launch (onCreate)
      // 시점에만 — 새 통화의 같은 file 재발동 방지용. onNewIntent (placeholder
      // → data 전환) 에서는 같은 통화의 update 라 dedup skip. 이전 v24 의
      // dedup-on-every-bind 가 placeholder 모달 finish 시켜버린 버그 fix.
      if (isFirstBind && RecordingState.isFileShown(this, name)) {
        Log.d(TAG, "dedup: $name already shown — finish")
        finish()
        return
      }
      RecordingState.markFileShown(this, name)
      stopDots()
      subtitleView.text = buildSubtitle(name, duration)
      currentUri = uri
      currentName = name
      currentDuration = duration
      currentDateAdded = dateAdded
      currentMimeType = mimeType
      // 사장님 정책 (2026-05-22 PM v35): native loading_card 완전 제거. click 시
      // 즉시 finish + RN navigation → SummaryReview 의 LoadingSecretary 만 단일
      // loading UI 로 사용. native processRecording / pollUntilFresh 흐름도 같이
      // 제거 (RN 측 useEffect 의 processRecording 이 단일 호출 주체).
      if (pendingReviewClick) {
        pendingReviewClick = false
        openReview(uri, name, duration, dateAdded, mimeType)
        finish()
      } else if (pendingSubmitClick) {
        pendingSubmitClick = false
        startAutoSubmit(uri, name, duration, dateAdded, mimeType, false)
        finish()
      }
    }
    isFirstBind = false

    setupGroupPicker(findViewById(android.R.id.content))

    findViewById<View>(R.id.overlay_btn_cancel).setOnClickListener { finish() }

    // 사장님 정책 (2026-05-22 PM 반응없음 fix): 클릭 즉시 시각 변화 (버튼 비활성 +
    // 텍스트 "잠시만요...") → 사장님이 "반응 없음 2-5초" 인지하는 빈 화면 구간을
    // 시각적으로 메움. RN navigation cold latency 가 진행되는 동안 modal 이 그대로
    // 표시 → 그 후 finish.
    findViewById<View>(R.id.overlay_btn_review).setOnClickListener {
      // 사장님 정책 (v37 챗지피티 안): click 즉시 native loading 표시 (~16ms),
      // 동시에 영맨앱 launch (openReview deep link). 영맨앱 cold start (~700ms)
      // 동안 native loading_card 가 빈 화면 메움. 영맨앱 진입 후 ConfirmRecording
      // LoadingSecretary 가 시각 동일하게 받침대 (사용자 끊김 인지 X). 1.5초 후
      // finish — 영맨앱 visible 후 native task 메모리 정리.
      showLoadingCard()
      val u = currentUri
      if (u == null) {
        pendingReviewClick = true
        return@setOnClickListener
      }
      openReview(u, currentName, currentDuration, currentDateAdded, currentMimeType)
      handler.postDelayed({ finish() }, 1500)
    }

    findViewById<View>(R.id.overlay_btn_submit).setOnClickListener {
      // 사장님 정책 (v53 2026-05-24): 양식에 전송은 native loading 표시 X.
      // 응답 (file 매칭) 와 무관하게 모달 즉시 닫고 background 처리.
      //   - 정상 (currentUri != null): 즉시 startAutoSubmit + finish.
      //   - placeholder (currentUri == null, file 매칭 전): PendingSubmitFlag set
      //     + finish. PostCallScanService 가 file 매칭하면 flag consume →
      //     pendingReview=false 로 background autoSubmit (trigger_summarize 까지).
      // 영맨 backend (commit d4a6d70) 가 placeholder customer_log 자동 mirror →
      // 고객관리대장에 "AI 요약 처리 중..." 카드. callback 완료 시 실제 요약 UPDATE + FCM.
      // [요약보기] 흐름은 그대로 (line 197 review handler 의 showLoadingCard 유지).
      android.widget.Toast.makeText(
        this, "고객관리대장에 저장 중입니다", android.widget.Toast.LENGTH_SHORT,
      ).show()
      val u = currentUri
      if (u == null) {
        PendingSubmitFlag.set(this)
        finish()
        return@setOnClickListener
      }
      startAutoSubmit(u, currentName, currentDuration, currentDateAdded, currentMimeType, false)
      finish()
    }

    scheduleAutoDismiss()
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    stopLoadingAnimators()
    super.onDestroy()
  }

  /** 사장님 정책 (v37 2026-05-23 챗지피티 안 + 사장님 의도):
   *  "요약보기" / "양식에 전송" click 즉시 호출. native UI toggle (~16ms) 로
   *  사용자 click 즉시 시각 반응 보장. 흰 풀스크린 + 캐릭터 bobbing + 별 fade
   *  + 로딩바 슬라이드. 그 후 백그라운드에서 영맨앱 launch / upload / processRecording.
   *
   *  영맨앱 ConfirmRecording 의 LoadingSecretary 와 시각 동일 → 영맨앱 진입
   *  시 사용자는 동일 화면 유지로 인지 (끊김 X). */
  private val loadingAnimators = mutableListOf<android.animation.Animator>()

  private fun showLoadingCard() {
    handler.removeCallbacks(autoDismiss)
    stopDots()
    stopCountdown()
    findViewById<View>(R.id.overlay_normal_card)?.visibility = View.GONE
    val loadingCard = findViewById<View>(R.id.overlay_loading_card) ?: return
    loadingCard.visibility = View.VISIBLE

    val image = findViewById<View>(R.id.loading_character_image) ?: return
    val star1 = findViewById<View>(R.id.loading_star_1) ?: return
    val star2 = findViewById<View>(R.id.loading_star_2) ?: return
    val star3 = findViewById<View>(R.id.loading_star_3) ?: return
    val bar = findViewById<View>(R.id.loading_bar_indicator) ?: return

    val bob = android.animation.ObjectAnimator.ofFloat(
      image, "translationY", 0f, -dpToPx(2).toFloat(),
    ).apply {
      duration = 700
      repeatCount = android.animation.ValueAnimator.INFINITE
      repeatMode = android.animation.ValueAnimator.REVERSE
      interpolator = android.view.animation.AccelerateDecelerateInterpolator()
    }
    val tilt = android.animation.ObjectAnimator.ofFloat(
      image, "rotation", -0.8f, 0.8f,
    ).apply {
      duration = 350
      repeatCount = android.animation.ValueAnimator.INFINITE
      repeatMode = android.animation.ValueAnimator.REVERSE
      interpolator = android.view.animation.AccelerateDecelerateInterpolator()
    }
    fun starAnim(v: View, delay: Long): android.animation.AnimatorSet {
      val alpha = android.animation.ObjectAnimator.ofFloat(v, "alpha", 0f, 1f, 1f, 0f).apply {
        duration = 1400; startDelay = delay
        repeatCount = android.animation.ValueAnimator.INFINITE
      }
      val sx = android.animation.ObjectAnimator.ofFloat(v, "scaleX", 0.5f, 1f, 1f, 0.5f).apply {
        duration = 1400; startDelay = delay
        repeatCount = android.animation.ValueAnimator.INFINITE
      }
      val sy = android.animation.ObjectAnimator.ofFloat(v, "scaleY", 0.5f, 1f, 1f, 0.5f).apply {
        duration = 1400; startDelay = delay
        repeatCount = android.animation.ValueAnimator.INFINITE
      }
      return android.animation.AnimatorSet().apply { playTogether(alpha, sx, sy) }
    }
    val s1 = starAnim(star1, 0)
    val s2 = starAnim(star2, 500)
    val s3 = starAnim(star3, 1000)
    val trackPx = dpToPx(205)
    val indicatorPx = dpToPx(72)
    val barAnim = android.animation.ObjectAnimator.ofFloat(
      bar, "translationX", -indicatorPx.toFloat(), trackPx.toFloat(),
    ).apply {
      duration = 1400
      repeatCount = android.animation.ValueAnimator.INFINITE
      interpolator = android.view.animation.AccelerateDecelerateInterpolator()
    }

    loadingAnimators.clear()
    listOf(bob, tilt, s1, s2, s3, barAnim).forEach {
      loadingAnimators.add(it); it.start()
    }

    findViewById<View>(R.id.loading_close_btn)?.setOnClickListener {
      finish()
    }
  }

  private fun stopLoadingAnimators() {
    loadingAnimators.forEach { it.cancel() }
    loadingAnimators.clear()
  }

  private fun scheduleAutoDismiss() {
    handler.removeCallbacks(autoDismiss)
    val dwell = SettingsStore.read(this).modalDwellMs
    val effective = if (dwell > 0) dwell else AUTO_DISMISS_MS_DEFAULT
    handler.postDelayed(autoDismiss, effective)
    startCountdown((effective / 1000L).toInt())
  }

  // 사장님 정책 (v54 2026-05-24): 자동 종료 카운트다운 표시. "팝업창은 N초 후에
  // 자동 종료 됩니다." (일반 사용자 facing 라 "모달" 대신 "팝업창"). bind() 가
  // placeholder → data 두 번 호출돼도 매번 fresh reset.
  private var countdownRunnable: Runnable? = null

  private fun startCountdown(totalSec: Int) {
    stopCountdown()
    val view = findViewById<TextView>(R.id.overlay_dismiss_countdown) ?: return
    view.visibility = View.VISIBLE
    var remaining = totalSec
    val runnable = object : Runnable {
      override fun run() {
        if (remaining <= 0) return
        view.text = "팝업창은 ${remaining}초 후에 자동 종료 됩니다."
        remaining--
        handler.postDelayed(this, 1000)
      }
    }
    countdownRunnable = runnable
    handler.post(runnable)
  }

  private fun stopCountdown() {
    countdownRunnable?.let { handler.removeCallbacks(it) }
    countdownRunnable = null
  }

  private fun openReview(
    uri: String,
    name: String,
    duration: Long,
    dateAdded: Long,
    mimeType: String,
    customerLogJson: String? = null,
  ) {
    val builder = Uri.Builder()
      .scheme("youngman")
      .authority("record")
      .appendPath("confirm")
      .appendQueryParameter("uri", uri)
      .appendQueryParameter("name", name)
      .appendQueryParameter("duration", duration.toString())
      .appendQueryParameter("dateAdded", dateAdded.toString())
      .appendQueryParameter("mimeType", mimeType)
    // 사장님 정책 (2026-05-22 PM v31): native processRecording 응답 customer_log
    // JSON 을 URL query param 으로 전달. RN side 가 받으면 useEffect 의
    // processRecording 호출 skip + 즉시 form state. placeholder customer_log
    // ~700 bytes 라 URL 한계 안전.
    if (customerLogJson != null) {
      builder.appendQueryParameter("customer_log_json", customerLogJson)
    }
    val intent = Intent(Intent.ACTION_VIEW, builder.build()).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      `package` = packageName
    }
    try {
      startActivity(intent)
    } catch (_: Exception) {}
  }

  private fun startAutoSubmit(
    uri: String,
    name: String,
    duration: Long,
    dateAdded: Long,
    mimeType: String,
    pendingReview: Boolean,
  ) {
    if (!pendingReview) {
      ProgressOverlayService.start(this)
    }
    Log.d(TAG, "startAutoSubmit: selectedGroupId=$selectedGroupId pendingReview=$pendingReview")
    val intent = Intent(this, AutoSubmitService::class.java).apply {
      putExtra(OverlayService.EXTRA_URI, uri)
      putExtra(OverlayService.EXTRA_NAME, name)
      putExtra(OverlayService.EXTRA_DURATION, duration)
      putExtra(OverlayService.EXTRA_DATE_ADDED, dateAdded)
      putExtra(OverlayService.EXTRA_MIME, mimeType)
      if (!pendingReview) {
        selectedGroupId?.let { putExtra(OverlayService.EXTRA_GROUP_ID, it) }
      }
      putExtra(OverlayService.EXTRA_PENDING_REVIEW, pendingReview)
    }
    // 사장님 정책 (2026-05-22 PM crash fix): AutoSubmitService 는 HeadlessJsTaskService
    // 라 일반 service (사장님이 FGS notification 거슬림 → AutoSubmitService.kt
    // 코멘트로 명시). 그런데 startForegroundService() 로 호출하면 Android 가 5초
    // 안에 service.startForeground() 호출되지 않으면 ForegroundServiceDidNotStartInTimeException
    // 으로 process kill (사장님 logcat 2026-05-22 18:35 / 18:36 crash buffer).
    // Activity foreground 클릭 시점이라 BAL 통과 — 일반 startService() 사용.
    try {
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
      addGroupListItem(container, scroll, chipLabel, g.title, g.id)
    }
    addGroupListItem(container, scroll, chipLabel, DEFAULT_GROUP_LABEL, null)
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
      // 사장님 정책 (2026-05-22 PM 진단): group_id 가 backend 에 미도달 case
      // 추적용. dropdown 선택 시점부터 logcat 에 흔적 남김.
      Log.d(TAG, "group dropdown selected: id=$id label=$label")
      selectedGroupId = id
      chipLabel.text = label
      scroll.visibility = View.GONE
    }
    container.addView(
      row,
      LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
      ),
    )
  }

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

  private fun dpToPx(dp: Int): Int = (dp * resources.displayMetrics.density).toInt()

  companion object {
    private const val TAG = "CallPostActivity"
    private const val AUTO_DISMISS_MS_DEFAULT = 15_000L
    private const val DEFAULT_GROUP_LABEL = "기본 그룹 (자동 생성)"
    const val EXTRA_PLACEHOLDER = "placeholder"
    const val EXTRA_URI = "uri"
    const val EXTRA_NAME = "name"
    const val EXTRA_DURATION = "duration"
    const val EXTRA_DATE_ADDED = "dateAdded"
    const val EXTRA_MIME = "mimeType"
    const val EXTRA_CALL_ID = "callId"

    fun startPlaceholder(ctx: Context, callId: String) {
      val intent = buildPlaceholderIntent(ctx, callId)
      try {
        ctx.startActivity(intent)
      } catch (e: Throwable) {
        Log.w(TAG, "startActivity (placeholder) failed", e)
      }
      postFullScreenIntent(ctx, intent)
    }

    private fun buildPlaceholderIntent(ctx: Context, callId: String): Intent =
      Intent(ctx, CallPostActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_NO_ANIMATION
        putExtra(EXTRA_PLACEHOLDER, true)
        putExtra(EXTRA_CALL_ID, callId)
      }

    /** 사장님 정책 (2026-05-22 첫통화 cold start 도미노 fix): broadcast receiver
     *  단계에서 양보 fallback FullScreenIntent 발행. process killed 상태 (앱
     *  종료 또는 update 직후) 에서 IDLE 받았을 때 PostCallScanService cold start
     *  latency 동안에도 OS 가 Activity launch 보장. FGS-기반 startActivity (BAL
     *  우회) 가 첫 호출 시 service 의 cold start race 로 실패하는 케이스 대비.
     *
     *  같은 NOTIF_ID + 같은 callId intent extra → service 가 또 호출해도 update
     *  (no harm). startWithData 가 뒤이어 발동하면 동일 NOTIF_ID 로 data 채워서
     *  덮어쓰기 + onNewIntent. */
    fun postLaunchFullScreenIntentForReceiver(ctx: Context, callId: String) {
      postFullScreenIntent(ctx, buildPlaceholderIntent(ctx, callId))
    }

    fun startWithData(ctx: Context, found: PostCallScanService.FoundFile) {
      val intent = Intent(ctx, CallPostActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_NO_ANIMATION
        putExtra(EXTRA_URI, found.uri)
        putExtra(EXTRA_NAME, found.displayName)
        putExtra(EXTRA_DURATION, found.duration)
        putExtra(EXTRA_DATE_ADDED, found.dateAdded)
        putExtra(EXTRA_MIME, "audio/mp4")
      }
      // 사장님 정책 (2026-05-22 v24 PoC 깜빡임 fix): POST_CALL system action 으로
      // placeholder 모달이 이미 visible 상태 → startActivity 가 BAL 통과 가능
      // (callingUidHasVisibleActivity=true). singleTop launchMode 라 같은 instance
      // 의 onNewIntent 로 data update — 별도 알림 발행 X. postFullScreenIntent
      // 호출 제거 (v22 NOTIF_ID unique 화 + 매번 새 fullScreenIntent 가 사장님이
      // 보는 모달/알림 깜빡임 원인).
      try {
        ctx.startActivity(intent)
      } catch (e: Throwable) {
        Log.w(TAG, "startActivity (data) failed — POST_CALL placeholder remains as-is", e)
      }
    }

    private fun postFullScreenIntent(ctx: Context, activityIntent: Intent) {
      PostCallScanService.ensureChannel(
        ctx,
        CHANNEL_ID_LAUNCH,
        " ",
        android.app.NotificationManager.IMPORTANCE_HIGH,
      )
      // 사장님 정책 (2026-05-22 v19 도미노 fix): NOTIF_ID + PendingIntent requestCode
      // 를 매번 unique. 같은 ID + FLAG_UPDATE_CURRENT 면 두번째 호출부터 system 이
      // 같은 notification update 로 보고 fullScreenIntent 재발동 안 함 (사장님
      // logcat 2026-05-22: 첫통화 OK, 두번째부터 모달 안 뜸). 매번 unique 면
      // system 이 새 notification entity 로 인식 → fullScreenIntent 매번 발동.
      val uniqueId = (System.currentTimeMillis() and 0x7FFFFFFF).toInt()
      val pi = android.app.PendingIntent.getActivity(
        ctx,
        uniqueId,
        activityIntent,
        android.app.PendingIntent.FLAG_UPDATE_CURRENT or
          (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            android.app.PendingIntent.FLAG_IMMUTABLE else 0),
      )
      val notif = androidx.core.app.NotificationCompat.Builder(ctx, CHANNEL_ID_LAUNCH)
        .setSmallIcon(com.youngmanapp.R.mipmap.ic_launcher)
        .setContentTitle("통화 종료")
        // 사장님 정책 (2026-05-22): "고객관리대장 저장" 은 저장 단계 아닌데 표시되어
        // 혼란 → "통화 요약 발견" 으로 교체.
        .setContentText("통화 요약 발견")
        .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
        .setCategory(androidx.core.app.NotificationCompat.CATEGORY_CALL)
        .setVisibility(androidx.core.app.NotificationCompat.VISIBILITY_PUBLIC)
        .setFullScreenIntent(pi, true)
        .setAutoCancel(true)
        .setTimeoutAfter(2000)
        .build()
      try {
        androidx.core.app.NotificationManagerCompat.from(ctx).notify(uniqueId, notif)
      } catch (e: SecurityException) {
        Log.w(TAG, "FullScreenIntent notify failed", e)
      }
    }

    private const val CHANNEL_ID_LAUNCH = "yk_call_post_launch_v1"

    // 사장님 정책 (2026-05-22 PM): system POST_CALL action 의 disconnect cause
    // 체크용 상수. API 별 import 의존 회피 위해 string/int 상수 직접.
    // android.telecom.TelecomManager.ACTION_POST_CALL (API 28+)
    private const val ACTION_POST_CALL = "android.telecom.action.POST_CALL"
    // android.telecom.TelecomManager.EXTRA_DISCONNECT_CAUSE
    private const val EXTRA_DISCONNECT_CAUSE = "android.telecom.extra.DISCONNECT_CAUSE"
    // android.telecom.DisconnectCause 값 (API 23+)
    private const val DISCONNECT_CAUSE_UNKNOWN = 0
    private const val DISCONNECT_CAUSE_MISSED = 5
    private const val DISCONNECT_CAUSE_REJECTED = 6
  }
}
