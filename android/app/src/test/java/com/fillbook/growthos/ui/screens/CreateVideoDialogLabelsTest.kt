package com.fillbook.growthos.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CreateVideoDialogLabelsTest {
    @Test
    fun `a concept in the daily order is labelled with its day`() {
        assertEquals("Day 5 · 5 contracts against a plan of 3", conceptLabel(5, "5 contracts against a plan of 3"))
        assertEquals("Old concept", conceptLabel(null, "Old concept"))
    }

    @Test
    fun `a used-up concept says what became of it`() {
        assertEquals("Already made", unavailableStateLabel("made"))
        assertEquals("Waiting in Approvals", unavailableStateLabel("waiting"))
        assertEquals("Rejected", unavailableStateLabel("rejected"))
        assertEquals("Not available", unavailableStateLabel("anything else"))
    }

    @Test
    fun `the one-a-day message names today's concept and when the next request opens in Arizona time`() {
        // 07:00 UTC on Oct 5 2026 is midnight Arizona, the start of Monday.
        val message = dailyLimitMessage("Chased price: 10 trades, lost ${'$'}630", "2026-10-05T07:00:00.000Z")
        assertTrue(message, message.contains("Today's video is already requested: \"Chased price: 10 trades, lost ${'$'}630\"."))
        assertTrue(message, message.contains("The next request opens Mon 12:00 AM Arizona time."))
    }

    @Test
    fun `the message still reads when the server gave no time`() {
        assertEquals("Today's video is already requested: \"X\".", dailyLimitMessage("X", null))
        assertEquals("Today's video is already requested: \"X\".", dailyLimitMessage("X", "not a time"))
    }
}
