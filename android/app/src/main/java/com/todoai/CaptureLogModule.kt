package com.todoai

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import com.facebook.react.bridge.ReactApplicationContext
import com.todoai.specs.NativeCaptureLogSpec
import java.io.File
import java.io.FileOutputStream

/**
 * Task 41 — the capture log's native half (design §1; storage mechanism ruled by Jason 2026-08-17,
 * amendment §1: a new app-owned TurboModule with a synchronous append).
 *
 * THE ONE PROPERTY THIS FILE EXISTS TO PROVIDE, AND THE ONE THAT MUST NEVER BE "OPTIMISED":
 * [append] BLOCKS UNTIL write(2) HAS RETURNED. When it returns, the bytes are in the kernel page
 * cache, which is owned by the kernel and not by this process — so `am force-stop`, `kill -9` and a
 * native SIGSEGV all destroy the process without losing them. That is the whole reason capture is a
 * TurboModule rather than `react-native-fs`, whose Promise-based appendFile loses exactly the
 * events immediately before a crash (constraint #3: llama.cpp can kill this process with no JS
 * error and no tombstone). Making this method async, or adding a buffer in front of it, silently
 * destroys the acceptance test's guarantee — `src/capture/__tests__/forceKill.test.ts` is the
 * headless half of that check, and it fails immediately on a buffered append.
 *
 * ONE HANDLE PER STREAM-DAY, held open. Reopening per line would cost an open(2)/close(2) pair on
 * the hot path for nothing; the handles are closed by process death, which is fine for an
 * append-only log whose bytes are already in the page cache.
 *
 * FILE LAYOUT IS A WRITTEN CONTRACT — `docs/design/capture_format_task41.md` §6. Task 42's
 * acceptance test enumerates these paths to prove a stream is empty, so the directory names come
 * from the JS `STREAMS` table and are never invented here.
 *
 * STORAGE IS APP-PRIVATE EXTERNAL ONLY (constraint #10) — [ReactApplicationContext.getExternalFilesDir],
 * the same `/sdcard/Android/data/com.todoai/files/` the model and the database live under. One
 * `adb pull` gets the lot; nothing is world-readable.
 */
class CaptureLogModule(reactContext: ReactApplicationContext) :
    NativeCaptureLogSpec(reactContext) {

  override fun getName(): String = MODULE_NAME

  private val handles = HashMap<String, FileOutputStream>()

  /** `capture/` under the app-private external files dir. Falls back to internal files if the
   *  external volume is unavailable — a degraded location beats losing the log. */
  private fun root(): File {
    val base =
        reactApplicationContext.getExternalFilesDir(null) ?: reactApplicationContext.filesDir
    return File(base, CAPTURE_DIR)
  }

  private fun streamOf(dir: String, day: String): FileOutputStream {
    val key = "$dir/$day"
    handles[key]?.let { return it }
    val directory = File(root(), dir)
    if (!directory.exists() && !directory.mkdirs() && !directory.exists()) {
      throw IllegalStateException("capture: cannot create ${directory.absolutePath}")
    }
    // append = true. Append-only, never rewritten, never compacted in place (design §6 rule 4).
    val stream = FileOutputStream(File(directory, "$day.ndjson"), true)
    handles[key] = stream
    return stream
  }

  override fun append(dir: String, day: String, line: String, sync: Boolean): Boolean {
    val stream = streamOf(dir, day)
    // ONE write CALL FOR THE WHOLE LINE, its trailing newline already inside `line`, so a record
    // can never be torn by interleaving (design §2). Do not split this into two writes.
    val bytes = line.toByteArray(Charsets.UTF_8)
    synchronized(this) {
      stream.write(bytes)
      if (sync) {
        // Per event for alpha (amendment §7), reverting to episode/background boundaries at closed
        // beta — task 42 owns that revert. This does NOT improve the force-kill test: the page
        // cache already survives process death. It buys durability against POWER LOSS and kernel
        // panic, which on this device is not theoretical — PowerManager status 6 is SHUTDOWN and
        // the S23 FE reaches SEVERE by roughly twenty minutes under load.
        stream.fd.sync()
      }
    }
    return true
  }

  override fun elapsedRealtimeMs(): Double = SystemClock.elapsedRealtime().toDouble()

  override fun sizeOnDisk(): Double {
    var total = 0L
    root().walkTopDown().forEach { if (it.isFile) total += it.length() }
    return total.toDouble()
  }

  override fun listDaysCsv(): String {
    val days = sortedSetOf<String>()
    root().listFiles()?.forEach { streamDir ->
      if (!streamDir.isDirectory) return@forEach
      streamDir.listFiles()?.forEach { file ->
        if (file.isFile && file.name.endsWith(NDJSON)) {
          days.add(file.name.removeSuffix(NDJSON))
        }
      }
    }
    return days.joinToString(",")
  }

  override fun deleteDay(day: String): Double {
    var removed = 0
    // Close any handle for that day first, so the delete is not fighting an open stream.
    val keys = handles.keys.filter { it.endsWith("/$day") }
    for (key in keys) {
      runCatching { handles.remove(key)?.close() }
    }
    root().listFiles()?.forEach { streamDir ->
      if (!streamDir.isDirectory) return@forEach
      val file = File(streamDir, "$day$NDJSON")
      if (file.isFile && file.delete()) removed++
    }
    return removed.toDouble()
  }

  /**
   * SAMPLING ONLY. There is deliberately NO thermal policy in this file — no tier degradation, no
   * deferral, no background-work gating. Those are task 19's and task 8's; building them here on
   * the grounds that the sensor is right there would be a second deviation nobody has ruled on
   * (amendment §4).
   */
  override fun thermalStatus(): Double {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return -1.0
    val power =
        reactApplicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
            ?: return -1.0
    return power.currentThermalStatus.toDouble()
  }

  override fun batteryLevel(): Double {
    val manager =
        reactApplicationContext.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
            ?: return -1.0
    val percent = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    return if (percent in 0..100) percent / 100.0 else -1.0
  }

  override fun isCharging(): Boolean {
    val status =
        reactApplicationContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    return status == BatteryManager.BATTERY_STATUS_CHARGING ||
        status == BatteryManager.BATTERY_STATUS_FULL
  }

  override fun rootPath(): String = root().absolutePath

  companion object {
    // Deliberately not called NAME: the codegen-generated spec already carries a static NAME, and
    // hiding an inherited static is the kind of thing that compiles on one toolchain and not the
    // next (the same note EpisodeAlarmModule carries, for the same reason). Must match the spec
    // file's module name in `src/specs/NativeCaptureLog.ts`.
    const val MODULE_NAME: String = "CaptureLog"
    private const val CAPTURE_DIR = "capture"
    private const val NDJSON = ".ndjson"
  }
}
