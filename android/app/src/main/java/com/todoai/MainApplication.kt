package com.todoai

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Autolinking only walks node_modules, so the app's own TurboModules are listed here.
          // EpisodeAlarm is the expiry alarm task 24 owes constraint #13 — a real AlarmManager
          // alarm, because a JS timer provably does not fire from doze (task 13 findings §9.4).
          add(EpisodeAlarmPackage())
          // CaptureLog is task 41's synchronous append (design §1). It is registered but the app
          // never depends on it existing: the JS binding uses TurboModuleRegistry.get, so a bundle
          // running against an older APK degrades to a counted no-op rather than a launch crash.
          add(CaptureLogPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
