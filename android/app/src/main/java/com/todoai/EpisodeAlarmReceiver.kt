package com.todoai

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build

/**
 * Task 24 — what the expiry alarm actually does when it fires.
 *
 * Spec §6.2 asks the app to "take focus like an alarm" at the block end. The Android mechanism for
 * that is a high-importance notification carrying a FULL-SCREEN INTENT: when the screen is locked
 * or the user is elsewhere the system launches the activity directly; when they are already using
 * the phone it surfaces as a heads-up notification instead, which is the correct, less rude
 * behaviour in that case. Either way the user is told, at the instant the block ended, by something
 * that does not depend on the JS thread being alive.
 *
 * `USE_FULL_SCREEN_INTENT` is granted at install to apps that provide alarm functionality (which
 * this is). Where it is not granted the notification degrades to a heads-up with sound — still
 * timely, still on time, just less insistent.
 */
class EpisodeAlarmReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_BLOCK_ENDED) return

    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    ensureChannel(manager)

    val title = intent.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: DEFAULT_TITLE
    val body = intent.getStringExtra(EXTRA_BODY)?.takeIf { it.isNotBlank() } ?: DEFAULT_BODY

    val open =
        PendingIntent.getActivity(
            context,
            REQUEST_CODE_OPEN,
            Intent(context, MainActivity::class.java).apply {
              flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    val builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          Notification.Builder(context, CHANNEL_ID)
        } else {
          @Suppress("DEPRECATION") Notification.Builder(context)
        }

    builder
        .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
        .setContentTitle(title)
        .setContentText(body)
        .setContentIntent(open)
        .setAutoCancel(true)
        // Alarm category + full-screen intent are what make this read as an alarm rather than a
        // notification the user scrolls past. `true` = high priority, show it even when in use.
        .setCategory(Notification.CATEGORY_ALARM)
        .setFullScreenIntent(open, true)

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      @Suppress("DEPRECATION")
      builder
          .setPriority(Notification.PRIORITY_HIGH)
          .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))
          .setDefaults(Notification.DEFAULT_VIBRATE)
    }

    try {
      manager.notify(NOTIFICATION_ID, builder.build())
    } catch (denied: SecurityException) {
      // POST_NOTIFICATIONS not granted (API 33+). The alarm still fired and the app is still
      // correct on return, because the timer is timestamp-based — only the interruption is lost.
    }
  }

  private fun ensureChannel(manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel =
        NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH).apply {
          description = "Tells you the moment a work block ends, even if the app is closed."
          enableVibration(true)
          setBypassDnd(false)
          setSound(
              RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
              AudioAttributes.Builder()
                  .setUsage(AudioAttributes.USAGE_ALARM)
                  .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                  .build(),
          )
        }
    manager.createNotificationChannel(channel)
  }

  companion object {
    const val ACTION_BLOCK_ENDED: String = "com.todoai.BLOCK_ENDED"
    const val EXTRA_TITLE: String = "title"
    const val EXTRA_BODY: String = "body"

    private const val CHANNEL_ID = "todoai.block_end"
    private const val CHANNEL_NAME = "Work block alarms"
    private const val NOTIFICATION_ID = 24_010
    private const val REQUEST_CODE_OPEN = 24_003
    private const val DEFAULT_TITLE = "Time's up"
    private const val DEFAULT_BODY = "That block just ended — where are you with it?"
  }
}
