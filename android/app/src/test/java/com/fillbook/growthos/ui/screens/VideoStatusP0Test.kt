package com.fillbook.growthos.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** P0 2026-11-15: refusals read in plain words; a connection problem is not mistaken for a server reason. */
class VideoStatusP0Test {
    @Test
    fun renderCapRefusalsReadPlainly() {
        assertEquals("today's 3 renders are used. It can render again tomorrow.", renderCapReason("daily_render_cap_reached (3 renders today, cap is 3)"))
        assertEquals("this month's renders are used up.", renderCapReason("monthly_render_cap_reached (100 renders this month, cap is 100)"))
        assertEquals("something else", renderCapReason("something else"))
    }

    @Test
    fun serverReasonComesFromThe409Body() {
        val e = com.fillbook.growthos.data.NetworkException("POST x failed: HTTP 409 -- {\"error\":\"This render is still running.\"}", 409)
        assertEquals("This render is still running.", videoServerReason(e))
        assertNull(videoServerReason(java.io.IOException("offline")))
    }
}
