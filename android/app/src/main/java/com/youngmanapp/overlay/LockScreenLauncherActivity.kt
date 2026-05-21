package com.youngmanapp.overlay

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log

/**
 * 사장님 정책 (2026-05-21 도미노 깊이): 통화 종료 시 잠금화면 위에 OverlayService
 * 모달을 띄우려 했지만 SHOW_WHEN_LOCKED window flag 만으로는 부족했음. 통화 전
 * 모달 (IncomingCall) 은 RINGING 상태라 시스템이 이미 통화 화면을 잠금 위에 띄워
 * 둔 상태였고, 우리 overlay 는 그 위에 얹혀서 작동. 통화 종료 = IDLE = 잠금화면
 * 다시 lock → overlay 가 잠금 아래로 깔림.
 *
 * 해결: 빈 transparent Activity 를 짧게 launch. Activity API 인
 * setShowWhenLocked(true) + setTurnScreenOn(true) 은 window flag 보다 강력 —
 * 시스템이 잠금화면 위에 Activity 를 띄워주고 잠금 상태 해제 없이도 화면을 켬.
 * Activity 가 onCreate 즉시 OverlayService.start 호출 후 finish — overlay 가
 * 떠 있는 동안 Activity 는 사라지고 모달만 화면에 남음.
 */
class LockScreenLauncherActivity : Activity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Log.d(TAG, "onCreate — applying SHOW_WHEN_LOCKED + TURN_SCREEN_ON")

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
      // Keyguard 가 비밀번호 없는 케이스라면 자동 dismiss 요청. 비밀번호 있는
      // 케이스는 silently 무시 — overlay 는 잠금 위에 그대로 표시.
      val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
      try {
        km?.requestDismissKeyguard(this, null)
      } catch (_: Throwable) {}
    }

    // PostCallScanService 가 EXTRA 로 넘긴 모달 정보를 그대로 OverlayService 로
    // 전달. Activity 는 launcher 역할만.
    val uri = intent.getStringExtra(OverlayService.EXTRA_URI)
    val name = intent.getStringExtra(OverlayService.EXTRA_NAME) ?: ""
    val duration = intent.getLongExtra(OverlayService.EXTRA_DURATION, 0L)
    val dateAdded = intent.getLongExtra(OverlayService.EXTRA_DATE_ADDED, 0L)
    val mimeType = intent.getStringExtra(OverlayService.EXTRA_MIME) ?: "audio/mp4"

    if (uri != null) {
      val svc = Intent(this, OverlayService::class.java).apply {
        putExtra(OverlayService.EXTRA_URI, uri)
        putExtra(OverlayService.EXTRA_NAME, name)
        putExtra(OverlayService.EXTRA_DURATION, duration)
        putExtra(OverlayService.EXTRA_DATE_ADDED, dateAdded)
        putExtra(OverlayService.EXTRA_MIME, mimeType)
      }
      try {
        startService(svc)
      } catch (e: Throwable) {
        Log.w(TAG, "startService(OverlayService) failed", e)
      }
    }

    // Activity 자신은 화면에 보일 필요 없음 — overlay 모달이 사용자 UI.
    finish()
  }

  companion object {
    private const val TAG = "LockScreenLauncher"

    fun start(ctx: Context, found: com.youngmanapp.telephony.PostCallScanService.FoundFile) {
      val intent = Intent(ctx, LockScreenLauncherActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or
            Intent.FLAG_ACTIVITY_NO_ANIMATION or
            Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
        putExtra(OverlayService.EXTRA_URI, found.uri)
        putExtra(OverlayService.EXTRA_NAME, found.displayName)
        putExtra(OverlayService.EXTRA_DURATION, found.duration)
        putExtra(OverlayService.EXTRA_DATE_ADDED, found.dateAdded)
        putExtra(OverlayService.EXTRA_MIME, "audio/mp4")
      }
      try {
        ctx.startActivity(intent)
      } catch (e: Throwable) {
        Log.w(TAG, "startActivity failed", e)
        // Fallback — Activity 시작 실패 시 OverlayService 직접 호출. 잠금화면
        // 위 표시는 안 되지만 잠금 풀린 후라도 모달은 뜸.
        OverlayService.start(ctx, found)
      }
    }
  }
}
