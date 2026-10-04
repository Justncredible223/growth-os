package com.fillbook.growthos.ui.screens

import com.fillbook.growthos.data.PlanSlot
import com.fillbook.growthos.data.PostingPlatform
import com.fillbook.growthos.data.PostingReminders
import com.fillbook.growthos.data.ReplyVisibility
import com.fillbook.growthos.ui.components.StatusTone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/** Posting plan and results (2026-09-25): slot labels, counts, the reply-views banner and reminder scheduling. */
class PostingResultsTest {
    @Test
    fun slotLabelsUseTwelveHourTime() {
        assertEquals("12:00 PM", slotLabel("12:00"))
        assertEquals("6:30 AM", slotLabel("06:30"))
        assertEquals("5:30 PM", slotLabel("17:30"))
    }

    @Test
    fun slotStatusSaysWhatIsLeft() {
        val all = PostingPlatform.entries
        assertEquals("Post now" to StatusTone.WAITING, slotStatusLabel(PlanSlot("06:30", "due", null, all)))
        assertEquals("1 left to post" to StatusTone.WAITING, slotStatusLabel(PlanSlot("06:30", "due", null, listOf(PostingPlatform.INSTAGRAM))))
        assertEquals("Posted everywhere" to StatusTone.READY, slotStatusLabel(PlanSlot("06:30", "done", null, emptyList())))
        assertEquals("No video ready" to StatusTone.SKIPPED, slotStatusLabel(PlanSlot("17:30", "empty", null, emptyList())))
    }

    @Test
    fun countsAreShortAndReadable() {
        assertEquals("—", formatCount(null))
        assertEquals("1,234", formatCount(1234))
        assertEquals("15.3K", formatCount(15_300))
        assertEquals("2.5M", formatCount(2_500_000))
    }

    @Test
    fun replyViewsBannerWarnsOnADrop() {
        val (text, warning) = replyVisibilityMessage(ReplyVisibility("dropped", 2.5, 4, 13.5, 6))
        assertEquals(true, warning)
        assertTrue(text.contains("2.5 views") && text.contains("normal 13.5"))
        assertEquals(false, replyVisibilityMessage(ReplyVisibility("ok", 11.0, 3, 12.0, 5)).second)
        assertEquals(null, replyVisibilityMessage(ReplyVisibility("not_enough_data", null, 0, null, 0)).second)
    }

    @Test
    fun remindersArmTheNextArizonaSlot() {
        val az = ZoneId.of("America/Phoenix")
        val (at1, slot1) = PostingReminders.nextSlot(ZonedDateTime.of(2026, 9, 25, 10, 0, 0, 0, az))
        assertEquals(12 to 0, at1.hour to at1.minute)
        assertEquals(1, slot1)
        // After the one daily slot has passed, the next is tomorrow's.
        val (at2, slot2) = PostingReminders.nextSlot(ZonedDateTime.of(2026, 9, 25, 20, 0, 0, 0, az))
        assertEquals(26, at2.dayOfMonth)
        assertEquals(12 to 0, at2.hour to at2.minute)
        assertEquals(1, slot2)
        // A phone in another zone still gets Arizona slot times.
        val (at3, _) = PostingReminders.nextSlot(ZonedDateTime.of(2026, 9, 25, 12, 0, 0, 0, ZoneId.of("America/New_York")))
        assertEquals(12 to 0, at3.withZoneSameInstant(az).let { it.hour to it.minute })
    }
}
