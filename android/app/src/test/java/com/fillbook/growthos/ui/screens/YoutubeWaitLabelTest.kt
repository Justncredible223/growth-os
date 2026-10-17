package com.fillbook.growthos.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class YoutubeWaitLabelTest {
    private val now = java.time.Instant.parse("2026-10-18T20:00:00Z").toEpochMilli()

    @Test
    fun `shows hours rounded up while YouTube is waiting`() {
        assertEquals("YouTube in 23h", youtubeWaitLabel("2026-10-19T18:30:00Z", now))
    }

    @Test
    fun `shows minutes under an hour`() {
        assertEquals("YouTube in 40m", youtubeWaitLabel("2026-10-18T20:40:00Z", now))
    }

    @Test
    fun `is null when YouTube may be posted now, or the time cannot be read`() {
        assertNull(youtubeWaitLabel(null, now))
        assertNull(youtubeWaitLabel("2026-10-18T19:00:00Z", now))
        assertNull(youtubeWaitLabel("not a time", now))
    }
}
