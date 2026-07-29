package com.todoai

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

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == EpisodeAlarmModule.MODULE_NAME) EpisodeAlarmModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
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
}
