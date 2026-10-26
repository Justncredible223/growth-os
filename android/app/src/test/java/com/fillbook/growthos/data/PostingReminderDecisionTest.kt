package com.fillbook.growthos.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PostingReminderDecisionTest {
    private fun video(title: String = "Break and retest strategy explained") = PlanVideo("asset", "render", title, emptyList())
    private fun plan(vararg slots: PlanSlot) = PostingPlan("2026-10-26", slots.toList(), 0)

    @Test
    fun `reminds when a ready video still has platforms to post to`() {
        val due = PlanSlot("12:00", "due", video(), listOf(PostingPlatform.TIKTOK, PostingPlatform.INSTAGRAM))
        assertTrue(PostingReminders.shouldRemind(plan(due)))
    }

    @Test
    fun `stays silent when there is no video, it is already posted or the slot is not due`() {
        assertFalse(PostingReminders.shouldRemind(plan(PlanSlot("12:00", "empty", null, emptyList()))))
        assertFalse(PostingReminders.shouldRemind(plan(PlanSlot("12:00", "done", video(), emptyList()))))
        assertFalse(PostingReminders.shouldRemind(plan(PlanSlot("12:00", "due", video(), emptyList()))))
        assertFalse(PostingReminders.shouldRemind(plan(PlanSlot("12:00", "upcoming", video(), listOf(PostingPlatform.TIKTOK)))))
        assertFalse(PostingReminders.shouldRemind(plan()))
    }

    @Test
    fun `still reminds when the plan could not be loaded`() {
        assertTrue(PostingReminders.shouldRemind(null))
    }

    @Test
    fun `text names the waiting video and the platforms left`() {
        val due = PlanSlot("12:00", "due", video(), listOf(PostingPlatform.TIKTOK, PostingPlatform.INSTAGRAM))
        val (title, body) = PostingReminders.reminderTextFor(plan(due), 1)
        assertEquals("Video to post: Break and retest strategy explained", title)
        assertEquals("Still to post: TikTok, Instagram. Add each link in Video Status.", body)
        assertEquals(PostingReminders.reminderText(1), PostingReminders.reminderTextFor(null, 1))
    }
}
