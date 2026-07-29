package com.todoai

import android.util.Log
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Task 24 — registers the app's own TurboModule. Added by hand in [MainApplication] because
 * autolinking only walks node_modules; a module that lives in the app itself has to be listed.
 */
class EpisodeAlarmPackage : BaseReactPackage() {

  init {
    Log.i(TAG, "EpisodeAlarmPackage constructed")
  }

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    val match = name == EpisodeAlarmModule.MODULE_NAME
    Log.i(TAG, "getModule(\"$name\") match=$match")
    return if (match) EpisodeAlarmModule(reactContext) else null
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    Log.i(TAG, "module info requested for ${EpisodeAlarmModule.MODULE_NAME}")
    mapOf(
        EpisodeAlarmModule.MODULE_NAME to
            ReactModuleInfo(
                EpisodeAlarmModule.MODULE_NAME,
                EpisodeAlarmModule::class.java.name,
                /* canOverrideExistingModule = */ false,
                /* needsEagerInit = */ false,
                /* isCxxModule = */ false,
                /* isTurboModule = */ true,
            )
    )
  }

  private companion object {
    const val TAG = "EpisodeAlarm"
  }
}
