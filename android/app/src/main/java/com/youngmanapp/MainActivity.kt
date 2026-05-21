package com.youngmanapp

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationManagerCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    installSplashScreen()
    applyLockScreenFlagsIfDeepLink(intent)
    super.onCreate(savedInstanceState)
    // 사장님 정책 (2026-05-21 emergency): MainApplication.onCreate 의 cancel 만으론
    // 부족한 케이스 대비. Activity 가 visible 될 때마다 stranded 알림 강제 회수.
    try {
      NotificationManagerCompat.from(this).cancel(4001)
    } catch (_: Throwable) {}
  }

  override fun onNewIntent(intent: Intent) {
    applyLockScreenFlagsIfDeepLink(intent)
    super.onNewIntent(intent)
  }

  /**
   * Item 3 (사장님 정책 2026-05-21): Lock-screen escalation.
   *
   * When MainActivity is launched via youngman:// deep link — e.g. the user
   * taps the "통화녹음 발견" notification on a locked screen — set the
   * show-when-locked / turn-screen-on flags so the app surfaces above the
   * lock screen. Same effect as a dedicated LockScreenActivity but without
   * splitting the RN host. Lifetime-of-Activity setting; we clear it via a
   * separate Activity flag when reaching the normal app shell would suffice,
   * but it's fine for the deep-link case to keep it on.
   *
   * Only applies to youngman:// VIEW intents — normal launcher icon launches
   * are untouched, so the user's lock-screen security is unaffected when they
   * open the app normally.
   */
  private fun applyLockScreenFlagsIfDeepLink(intent: Intent?) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return
    val data = intent?.data ?: return
    if (data.scheme != "youngman") return
    try {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } catch (_: Throwable) {
      // ignore — these calls are best-effort
    }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "YoungmanApp"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
