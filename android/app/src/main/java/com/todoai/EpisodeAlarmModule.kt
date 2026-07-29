package com.todoai

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.ReactApplicationContext
import com.todoai.specs.NativeEpisodeAlarmSpec

/**
 * Task 24 — the episode expiry alarm (constraint #13).
 *
 * Task 13's Phase B established on the S23 FE that a JS `setTimeout` scheduled for the block end
 * does not fire at that instant while the app is backgrounded or dozing: Android suspends the JS
 * thread and the pending timer simply waits for the foreground, arriving 38 s and 45 s late in two
 * deliberate runs. The timer ENGINE is unharmed by that (it is timestamp-based, so the state is
 * always right on return) but spec §6.2's "the app takes focus like an alarm" is not something a
 * suspended thread can deliver.
 *
 * `AlarmManager.setAlarmClock` is the strongest primitive Android offers: it is exempt from Doze
 * and App Standby, it fires exactly, and the OS surfaces it as a user-visible alarm. The fallback
 * ladder below never silently downgrades to nothing — a late alarm beats no alarm.
 *
 * ONE ALARM EXISTS AT A TIME. The PendingIntent uses a fixed request code with FLAG_UPDATE_CURRENT,
 * so every re-schedule (a pause resuming, a `+5`, a `Keep going`) replaces the previous one rather
 * than stacking. That mirrors the engine, where exactly one episode is open at a time.
 */
class EpisodeAlarmModule(reactContext: ReactApplicationContext) :
    NativeEpisodeAlarmSpec(reactContext) {

  override fun getName(): String = MODULE_NAME

  private fun alarmManager(): AlarmManager =
      reactApplicationContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager

  private fun firePendingIntent(title: String, body: String): PendingIntent {
    val context = reactApplicationContext
    val intent =
        Intent(context, EpisodeAlarmReceiver::class.java).apply {
          action = EpisodeAlarmReceiver.ACTION_BLOCK_ENDED
          putExtra(EpisodeAlarmReceiver.EXTRA_TITLE, title)
          putExtra(EpisodeAlarmReceiver.EXTRA_BODY, body)
        }
    return PendingIntent.getBroadcast(
        context,
        REQUEST_CODE,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /** What the OS opens if the user taps the alarm entry in the status bar. */
  private fun showPendingIntent(): PendingIntent {
    val context = reactApplicationContext
    val intent =
        Intent(context, MainActivity::class.java).apply {
          flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
    return PendingIntent.getActivity(
        context,
        REQUEST_CODE_SHOW,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  override fun schedule(atMs: Double, title: String, body: String) {
    val triggerAtMs = atMs.toLong()
    val manager = alarmManager()
    val pending = firePendingIntent(title, body)
    try {
      manager.setAlarmClock(AlarmManager.AlarmClockInfo(triggerAtMs, showPendingIntent()), pending)
    } catch (denied: SecurityException) {
      // API 31/32 without the exact-alarm grant. setAndAllowWhileIdle still pierces Doze; it is
      // only batched to roughly a nine-minute window, so the alarm lands late rather than never.
      // The Settings screen offers openExactAlarmSettings() to fix this properly.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pending)
      } else {
        manager.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pending)
      }
    }
  }

  override fun cancel() {
    // PendingIntent identity ignores extras — only the component, action, data and categories
    // count — so this resolves to the same pending alarm the schedule above created.
    alarmManager().cancel(firePendingIntent("", ""))
  }

  override fun canScheduleExactAlarms(): Boolean =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        alarmManager().canScheduleExactAlarms()
      } else {
        true
      }

  override fun openExactAlarmSettings() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    val context = reactApplicationContext
    val intent =
        Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
          data = Uri.parse("package:${context.packageName}")
          flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
    context.startActivity(intent)
  }

  companion object {
    // Deliberately not called NAME: the codegen-generated spec already carries a static NAME, and
    // hiding an inherited static is the kind of thing that compiles on one toolchain and not the
    // next. The value must match the spec file's module name (`NativeEpisodeAlarm.ts`).
    const val MODULE_NAME: String = "EpisodeAlarm"
    private const val REQUEST_CODE = 24_001
    private const val REQUEST_CODE_SHOW = 24_002
  }
}
