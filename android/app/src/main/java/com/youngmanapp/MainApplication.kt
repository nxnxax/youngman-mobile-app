package com.youngmanapp

import android.app.Application
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.youngmanapp.app.AppBridgePackage
import com.youngmanapp.auth.AuthBridgePackage
import com.youngmanapp.billing.PlanCachePackage
import com.youngmanapp.callrecording.RecordingScannerPackage
import com.youngmanapp.clipboard.ClipboardBridgePackage
import com.youngmanapp.contacts.ContactsPackage
import com.youngmanapp.ledger.LedgerGroupsPackage
import com.youngmanapp.logging.ErrorLog
import com.youngmanapp.logging.ErrorLogPackage
import com.youngmanapp.overlay.IncomingCallOverlayPackage
import com.youngmanapp.overlay.ProgressOverlayPackage
import com.youngmanapp.overlay.SuccessOverlayPackage
import com.youngmanapp.settings.SettingsBridgePackage
import com.youngmanapp.system.BackgroundRestrictionPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(RecordingScannerPackage())
          add(ContactsPackage())
          add(BackgroundRestrictionPackage())
          add(ErrorLogPackage())
          add(LedgerGroupsPackage())
          add(SuccessOverlayPackage())
          add(ProgressOverlayPackage())
          add(SettingsBridgePackage())
          add(IncomingCallOverlayPackage())
          add(AuthBridgePackage())
          add(AppBridgePackage())
          add(PlanCachePackage())
          add(ClipboardBridgePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // 사장님 정책 (2026-05-22 PM 진단): "치명적 에러도 ErrorLog 안 쌓임" 보고
    // → native (Kotlin/Java) uncaught exception 핸들러 미설치가 도미노. JS
    // ErrorUtils 는 App.tsx 가 installGlobalErrorHandler 로 잡고, native crash
    // 는 여기서 Thread.setDefaultUncaughtExceptionHandler 로 잡아 ErrorLog
    // file 에 기록 후 system default handler 에 전달 (process kill 그대로).
    // process 가 죽기 직전에 file write 완료되어야 함 — try/finally 로 안전망.
    val systemDefault = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      try {
        ErrorLog.append(
          this,
          "native.uncaught",
          "thread=${thread.name} (${thread.id})",
          throwable,
        )
      } catch (e: Throwable) {
        Log.e("MainApplication", "ErrorLog.append in uncaught handler failed", e)
      } finally {
        // system default handler 가 process kill + tombstone 생성 → 평소
        // 동작 보존. null 가능성은 거의 없지만 안전.
        systemDefault?.uncaughtException(thread, throwable)
      }
    }
    loadReactNative(this)
    // 사장님 정책 (2026-05-21 emergency): 이전 빌드의 PostCallScanService 가
    // stopForeground 실패로 leak 한 stranded notification (id=4001) 을 cold
    // start 시 강제 회수.
    try {
      NotificationManagerCompat.from(this).cancel(4001)
    } catch (_: Throwable) {}
    // warm-up 제거 (2026-05-21): 사장님 측정 결과 더 느려짐.
  }
}
