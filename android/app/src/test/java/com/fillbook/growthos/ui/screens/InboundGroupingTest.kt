package com.fillbook.growthos.ui.screens

import com.fillbook.growthos.data.InboundEngagement
import com.fillbook.growthos.data.InboundPriority
import com.fillbook.growthos.data.InboundSummary
import org.junit.Assert.assertEquals
import org.junit.Test

/** P1 2026-11-15 (ChatGPT): a burst from one person is grouped, but every message stays its own item with its own actions. */
class InboundGroupingTest {
    private fun item(id: String, author: String) = InboundEngagement(
        id = id, platform = "x", authorHandle = author, body = "b", inResponseToText = null, priority = InboundPriority.P3_COMMENT,
        status = "needs_response", draftResponse = null, respondedAt = null, isRepeatEngager = false, creatorHandle = null,
        observedAt = "2026-11-16T10:00:00Z", sourceReference = null, authorExternalId = "id-$author",
    )

    @Test
    fun aBurstIsOneHeaderPlusTheFirstItem_untilExpanded() {
        val items = listOf(item("k1", "kezie"), item("solo", "other"), item("k2", "kezie"), item("k3", "kezie"))
        val collapsed = inboundDisplayRows(items, emptyList())
        assertEquals(listOf("header-x:id-kezie", "k1", "solo"), collapsed.map { it.key })
        assertEquals(3, collapsed.first().header!!.count)
        val open = inboundDisplayRows(items, listOf("x:id-kezie"))
        assertEquals(listOf("header-x:id-kezie", "k1", "k2", "k3", "solo"), open.map { it.key })
    }

    @Test
    fun theKickerSaysHowManyPeopleWhenItHelps() {
        assertEquals("8 need a response · 1 person", inboundKicker(InboundSummary(8, 0, 8, 0, people = 1)))
        assertEquals("2 need a response", inboundKicker(InboundSummary(2, 0, 0, 0, people = 2)))
        assertEquals("1 needs a response", inboundKicker(InboundSummary(1, 0, 0, 0, people = 0)))
    }
}
