package com.youngmanapp

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.youngmanapp.callrecording.RecordingScannerPackage
import com.youngmanapp.contacts.ContactsPackage
import com.youngmanapp.ledger.LedgerGroupsPackage
import com.youngmanapp.logging.ErrorLogPackage
import com.youngmanapp.overlay.ProgressOverlayPackage
import com.youngmanapp.overlay.SuccessOverlayPackage
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
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
