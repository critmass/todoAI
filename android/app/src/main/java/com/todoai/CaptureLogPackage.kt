package com.todoai

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Task 41 — registers the capture log TurboModule. Added by hand in [MainApplication] because
 * autolinking only walks node_modules; a module that lives in the app itself has to be listed.
 * Same shape as [EpisodeAlarmPackage], deliberately — that one is proven on the S23 FE.
 */
class CaptureLogPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == CaptureLogModule.MODULE_NAME) CaptureLogModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        CaptureLogModule.MODULE_NAME to
            ReactModuleInfo(
                CaptureLogModule.MODULE_NAME,
                CaptureLogModule::class.java.name,
                /* canOverrideExistingModule = */ false,
                /* needsEagerInit = */ false,
                /* isCxxModule = */ false,
                /* isTurboModule = */ true,
            )
    )
  }
}
