package com.fillbook.growthos.data

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.fillbook.growthos.MainActivity
import com.fillbook.growthos.R

/**
 * Everything about showing/routing the two real push notifications this
 * app ever sends itself (a render finishing ready, or failing) -- kept as
 * one small, framework-only (no Compose) object so both
 * FillbookMessagingService (which has no Activity/Compose context) and
 * MainActivity (reading a launch/onNewIntent Intent) share the exact same
 * extras contract instead of two ad hoc copies drifting apart.
 */
object VideoNotifications {
    const val CHANNEL_ID = "video_render"
    const val EXTRA_VIDEO_RENDER_ID = "video_render_id"
    const val EXTRA_KIND = "kind"

    /** Idempotent -- creating an already-existing channel is a documented no-op, so this is safe to call on every process start rather than needing an "only once ever" guard. */
    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Video renders",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Your video is ready to download, or a render failed"
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /**
     * Builds and shows the actual system notification for one render
     * outcome. [videoRenderId]/[kind] are the exact data-payload keys the
     * backend's pushSender.ts sends (see sendRenderNotification's
     * RenderNotificationPayload) -- read directly off the RemoteMessage in
     * FillbookMessagingService, never re-derived.
     */
    fun show(context: Context, videoRenderId: String, kind: String, title: String, body: String) {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_VIDEO_RENDER_ID, videoRenderId)
            putExtra(EXTRA_KIND, kind)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            videoRenderId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        // NotificationManagerCompat.notify itself checks the POST_NOTIFICATIONS
        // grant on API 33+ and is a documented safe no-op if it's missing --
        // no permission check needed here, and the render/download flow this
        // notification is ABOUT never depends on it succeeding (see the
        // Video Status screen, which is the durable source of truth either
        // way).
        NotificationManagerCompat.from(context).notify(videoRenderId.hashCode(), notification)
    }

    /** Null when [intent] didn't come from tapping one of this app's own video-render notifications (a normal launcher tap, or any other intent) -- MainActivity treats null as "nothing to deep-link, proceed normally." Thin Android-facing wrapper -- see deepLinkRouteForExtra for the actual (pure, unit-tested) decision. */
    fun deepLinkRouteFor(intent: Intent): String? =
        deepLinkRouteForExtra(intent.getStringExtra(EXTRA_VIDEO_RENDER_ID), intent.getStringExtra(EXTRA_KIND))

    /** Pure decision extracted from deepLinkRouteFor so it's unit-testable without a real android.content.Intent (unmocked in this project's plain-JVM tests -- see NetworkGrowthOsRepository's own comment on the same constraint). */
    internal fun deepLinkRouteForExtra(videoRenderIdExtra: String?, kindExtra: String? = null): String? = when {
        videoRenderIdExtra == null -> null
        // A draft waiting for approval opens Approvals; everything else about a video lives in Video Status.
        kindExtra == "script_ready" -> "approvals"
        else -> "video_status"
    }
}
