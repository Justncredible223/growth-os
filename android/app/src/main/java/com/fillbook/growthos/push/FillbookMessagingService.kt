package com.fillbook.growthos.push

import com.fillbook.growthos.data.AppConfig
import com.fillbook.growthos.data.VideoNotifications
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Receives the two real pushes this app ever gets: a video render reaching
 * 'ready' or 'failed' (see backend/scripts/video-worker/pushSender.ts).
 * Both onNewToken and onMessageReceived can fire with no Activity alive
 * (app backgrounded/killed), so this builds its own repository straight
 * from AppConfig rather than depending on anything MainActivity set up --
 * exactly the reason AppConfig exists as its own object.
 *
 * A service-scoped SupervisorJob (not GlobalScope) is used so a failed
 * registerDeviceToken call can't cancel a sibling coroutine, and the scope
 * itself only lives as long as this component -- standard practice for a
 * component with no lifecycle owner of its own to hang a
 * viewModelScope/lifecycleScope off of.
 */
class FillbookMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Fires only for a NEW or rotated token -- NOT on every app start (see
     * MainActivity's own registerDeviceToken call in GrowthOsRoot, which
     * covers the "token already existed before this launch" case this
     * callback structurally cannot). A registration failure here (offline,
     * transient server error) is silent and non-fatal: the very next
     * successful app launch's own registration call covers it, and FCM
     * itself will re-deliver onNewToken again later if the token is still
     * unregistered from Firebase's own perspective.
     */
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        scope.launch {
            runCatching { AppConfig.buildRepository().registerDeviceToken(token) }
        }
    }

    /**
     * The backend's pushSender.ts always sends both a `notification` block
     * (title/body) AND a `data` block (videoRenderId/kind) in the same
     * message -- when the app is in the foreground, FCM delivers the whole
     * RemoteMessage here rather than auto-posting a system notification, so
     * this builds and shows one explicitly via VideoNotifications either
     * way, keeping foreground and background behavior identical (a single
     * consistent notification, not "sometimes it appears, sometimes it's
     * silently swallowed").
     */
    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val videoRenderId = message.data["videoRenderId"] ?: return
        val kind = message.data["kind"] ?: return
        val title = message.notification?.title ?: when (kind) {
            "ready" -> "Video ready"
            "script_ready" -> "Script ready to approve"
            else -> "Video render failed"
        }
        val body = message.notification?.body ?: "Open the app to see details."
        VideoNotifications.show(applicationContext, videoRenderId, kind, title, body)
    }
}
