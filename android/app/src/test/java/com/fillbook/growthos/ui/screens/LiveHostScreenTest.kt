package com.fillbook.growthos.ui.screens

import com.fillbook.growthos.data.LiveHostFeedItem
import com.fillbook.growthos.data.LiveHostStatus
import com.fillbook.growthos.data.parseLiveHostStatus
import com.fillbook.growthos.ui.components.StatusTone
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Live Host tab is the owner's only view of what an autonomous character is saying on their stream, so the
 * two things it must never get wrong are covered here: reading the server's status, and the one-line state under
 * the switch (a host that is "Live" when the PC worker has died, or "Off" when it is still on, would be worse
 * than no tab at all).
 */
class LiveHostScreenTest {
    private fun status(json: String): LiveHostStatus = parseLiveHostStatus(JSONObject(json))

    private val liveJson = """
        {
          "configured": true,
          "hostName": "Tilt",
          "settings": {"desiredState": "on", "youtubeVideoId": "abcdefghijk", "tiktokChatEnabled": false, "tiktokUsername": null, "idleSeconds": 45, "dailyBudgetUsd": 3, "updatedAt": "2026-10-09T18:00:00.000Z"},
          "systemPaused": false,
          "session": {"id": "s1", "startedAt": "2026-10-09T18:00:00.000Z", "lastHeartbeatAt": "2026-10-09T18:05:00.000Z", "workerOnline": true,
                      "messagesSeen": 12, "messagesAnswered": 9, "messagesPending": 1, "messagesBlocked": 2, "linesSpoken": 14, "fillbookMentions": 2},
          "lastSession": null,
          "todaySpendUsd": 0.42,
          "budgetReached": false,
          "feed": [
            {"type": "utterance", "id": "u1", "at": "2026-10-09T18:05:00.000Z", "platform": null, "authorName": "Tilt", "text": "Mike, welcome in.", "status": "spoken", "statusReason": null, "kind": "reply", "segment": null, "mentionsFillbook": false},
            {"type": "message", "id": "m1", "at": "2026-10-09T18:04:55.000Z", "platform": "youtube", "authorName": "Mike", "text": "hi", "status": "answered", "statusReason": null, "kind": null, "segment": null, "mentionsFillbook": false},
            {"type": "message", "id": "m2", "at": "2026-10-09T18:04:50.000Z", "platform": "youtube", "authorName": "friend", "text": "[link]", "status": "blocked", "statusReason": "empty or link-only message", "kind": null, "segment": null, "mentionsFillbook": false}
          ]
        }
    """.trimIndent()

    @Test
    fun `parses a live status`() {
        val parsed = status(liveJson)
        assertTrue(parsed.configured)
        assertTrue(parsed.settings!!.switchedOn)
        assertEquals("abcdefghijk", parsed.settings!!.youtubeVideoId)
        assertEquals(9, parsed.session!!.messagesAnswered)
        assertEquals(3, parsed.feed.size)
        assertTrue(parsed.feed[0].isHostLine)
        assertFalse(parsed.feed[1].isHostLine)
        assertNull(parsed.feed[0].platform)
        assertEquals("empty or link-only message", parsed.feed[2].statusReason)
    }

    @Test
    fun `parses the not-set-up response without settings or a session`() {
        val parsed = status("""{"configured": false, "hostName": "Tilt", "settings": null, "systemPaused": false, "session": null, "lastSession": null, "todaySpendUsd": 0, "budgetReached": false, "feed": []}""")
        assertFalse(parsed.configured)
        assertNull(parsed.settings)
        assertNull(parsed.session)
        assertEquals("Not set up yet", liveHostHeadline(parsed).first)
    }

    @Test
    fun `headline says Live only when the switch is on and the worker is alive`() {
        val live = status(liveJson)
        assertEquals("Live" to StatusTone.ACTIVE, liveHostHeadline(live))

        val workerGone = live.copy(session = live.session!!.copy(workerOnline = false))
        assertEquals(StatusTone.FAILED, liveHostHeadline(workerGone).second)

        val waiting = live.copy(session = null)
        assertEquals(StatusTone.WAITING, liveHostHeadline(waiting).second)

        val off = live.copy(settings = live.settings!!.copy(switchedOn = false), session = null)
        assertEquals("Off", liveHostHeadline(off).first)

        val paused = live.copy(systemPaused = true)
        assertEquals(StatusTone.BLOCKED, liveHostHeadline(paused).second)

        val overBudget = live.copy(budgetReached = true)
        assertEquals(StatusTone.BLOCKED, liveHostHeadline(overBudget).second)
    }

    @Test
    fun `feed rows are labelled by what actually happened`() {
        fun item(isHostLine: Boolean, status: String) = LiveHostFeedItem("x", isHostLine, "2026-10-09T18:00:00.000Z", null, null, "t", status, null, null, false)
        assertEquals("Said on stream", liveHostFeedStatus(item(true, "spoken")).first)
        assertEquals("Not said", liveHostFeedStatus(item(true, "dropped")).first)
        assertEquals("Answered", liveHostFeedStatus(item(false, "answered")).first)
        assertEquals("Blocked", liveHostFeedStatus(item(false, "blocked")).first)
        assertEquals("Skipped", liveHostFeedStatus(item(false, "skipped")).first)
    }
}
