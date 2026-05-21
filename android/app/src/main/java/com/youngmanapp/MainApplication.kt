package com.youngmanapp

import android.app.Application
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
