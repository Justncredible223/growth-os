package com.fillbook.growthos.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure-logic coverage for the notification-tap deep-link decision -- the
 * actual android.content.Intent extraction is a one-line wrapper
 * (deepLinkRouteFor) around this, kept untested here for the same reason
 * NetworkGrowthOsRepositoryTest avoids org.json directly: android.* classes
 * are unmocked stubs under this project's plain-JVM unit tests (no
 * Robolectric), so a real Intent would need on-device verification instead.
 */
class VideoNotificationsTest {
    @Test
    fun `routes to Video Status when a video render id extra is present`() {
        assertEquals("video_status", VideoNotifications.deepLinkRouteForExtra("render-123"))
    }

    @Test
    fun `does not route when there is no video render id extra -- a normal launcher tap`() {
        assertNull(VideoNotifications.deepLinkRouteForExtra(null))
        assertEquals("approvals", VideoNotifications.deepLinkRouteForExtra("script-ready", "script_ready"))
        assertEquals("video_status", VideoNotifications.deepLinkRouteForExtra("render-1", "failed"))
    }
}
