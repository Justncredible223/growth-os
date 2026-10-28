package com.fillbook.growthos.data

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * The daily 12pm posting reminder was removed on 2026-10-28 (owner request: videos go out twice a week now and the owner does not
 * want the notification). This only cleans up what earlier builds left on the phone: the armed alarm and the notification
 * channel. The posting plan itself (Video Status) is unchanged.
 */
object PostingReminders {
    private const val CHANNEL_ID = "posting_reminders"
    private const val REQUEST_CODE = 6300
    private const val RECEIVER_CLASS = "com.fillbook.growthos.data.PostingReminderReceiver"

    /** Cancels the alarm an earlier build armed and removes its notification channel. Safe to call on every start. */
    fun retire(context: Context) {
        runCatching {
            val intent = Intent().setComponent(ComponentName(context.packageName, RECEIVER_CLASS))
            val pending = PendingIntent.getBroadcast(context, REQUEST_CODE, intent, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
            if (pending != null) {
                context.getSystemService(AlarmManager::class.java).cancel(pending)
                pending.cancel()
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            runCatching { context.getSystemService(NotificationManager::class.java).deleteNotificationChannel(CHANNEL_ID) }
        }
    }
}
