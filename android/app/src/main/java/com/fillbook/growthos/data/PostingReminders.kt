package com.fillbook.growthos.data

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.fillbook.growthos.MainActivity
import com.fillbook.growthos.R
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

/**
 * Local reminder for the daily posting plan (owner request 2026-09-25; one a day, 12pm Arizona, from 2026-10-04), the same
 * slot the server's plan uses (backend/src/posting/postingPlan.ts). Exact alarms (USE_EXACT_ALARM, granted at install
 * for this sideloaded app): an inexact alarm was given a 1-hour window on the owner's phone, too loose for a posting
 * slot. If exact alarms are ever unavailable it falls back to a 10-minute window. Only the next slot is ever armed: it
 * re-arms after firing, on app start and after a reboot.
 */
object PostingReminders {
    const val CHANNEL_ID = "posting_reminders"
    val SLOT_TIMES: List<LocalTime> = listOf(LocalTime.of(12, 0))
    val ZONE: ZoneId = ZoneId.of("America/Phoenix")
    private const val REQUEST_CODE = 6300
    private const val NOTIFICATION_ID = 6301

    /** The next slot strictly after [now], and its 1-based number within the day. */
    fun nextSlot(now: ZonedDateTime): Pair<ZonedDateTime, Int> {
        val local = now.withZoneSameInstant(ZONE)
        val today: LocalDate = local.toLocalDate()
        SLOT_TIMES.forEachIndexed { i, time ->
            val at = ZonedDateTime.of(today, time, ZONE)
            if (at.isAfter(local)) return at to (i + 1)
        }
        return ZonedDateTime.of(today.plusDays(1), SLOT_TIMES.first(), ZONE) to 1
    }

    fun reminderText(slotNumber: Int): Pair<String, String> =
        "Time to post today's video" to "If today's video is ready, post it to TikTok, YouTube and Instagram. Add each link in Video Status."

    /**
     * Whether the 12pm alarm should show anything (2026-10-26). Videos are requested twice a week now (Tuesday and Friday), so a
     * fixed daily reminder nagged on days with nothing to post. The server's plan already says whether a ready video is waiting
     * on some platform: a slot that is "due", has a video, and still has platforms left. When the plan could not be loaded the
     * reminder is shown anyway (a missed reminder for a ready video costs more than one extra notification).
     */
    fun shouldRemind(plan: PostingPlan?): Boolean {
        if (plan == null) return true
        return plan.slots.any { it.status == "due" && it.video != null && it.remaining.isNotEmpty() }
    }

    /** The reminder text for a loaded plan: names the waiting video; falls back to the generic text when there is none. */
    fun reminderTextFor(plan: PostingPlan?, slotNumber: Int): Pair<String, String> {
        val slot = plan?.slots?.firstOrNull { it.status == "due" && it.video != null && it.remaining.isNotEmpty() }
        val title = slot?.video?.title ?: return reminderText(slotNumber)
        return "Video to post: $title" to "Still to post: ${slot.remaining.joinToString(", ") { it.label }}. Add each link in Video Status."
    }

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(CHANNEL_ID, "Posting reminders", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "A reminder at your daily posting time"
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun scheduleNext(context: Context, now: ZonedDateTime = ZonedDateTime.now(ZONE)) {
        val (at, slot) = nextSlot(now)
        val intent = Intent(context, PostingReminderReceiver::class.java).putExtra(PostingReminderReceiver.EXTRA_SLOT, slot)
        val pending = PendingIntent.getBroadcast(context, REQUEST_CODE, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val alarms = context.getSystemService(AlarmManager::class.java)
        val atMillis = at.toInstant().toEpochMilli()
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()
        if (canExact) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pending)
        } else {
            alarms.setWindow(AlarmManager.RTC_WAKEUP, atMillis, 10 * 60 * 1000L, pending)
        }
    }

    fun show(context: Context, slotNumber: Int, plan: PostingPlan? = null) {
        createChannel(context)
        val (title, body) = reminderTextFor(plan, slotNumber)
        val open = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            // Any value routes to Video Status (VideoNotifications.deepLinkRouteFor), where the plan lives.
            putExtra(VideoNotifications.EXTRA_VIDEO_RENDER_ID, "posting-reminder")
        }
        val pending = PendingIntent.getActivity(context, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            // Notifications not permitted: nothing to show, and the next slot is still armed.
        }
    }
}

/** Fires at a posting slot: shows the reminder, then arms the next slot. */
class PostingReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val slot = intent.getIntExtra(EXTRA_SLOT, 1)
        // Arm the next slot first, so a slow or failed network call can never stop the reminders.
        PostingReminders.scheduleNext(context)
        val pendingResult = goAsync()
        Thread {
            try {
                val plan = runCatching {
                    runBlocking { withTimeout(8_000) { AppConfig.buildRepository().getPostingOverview().plan } }
                }.getOrNull()
                if (PostingReminders.shouldRemind(plan)) PostingReminders.show(context, slot, plan)
            } finally {
                pendingResult.finish()
            }
        }.start()
    }

    companion object {
        const val EXTRA_SLOT = "slot"
    }
}

/** Re-arms the next posting reminder after a reboot or an app update, since alarms don't survive either. */
class PostingReminderBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            PostingReminders.scheduleNext(context)
        }
    }
}
