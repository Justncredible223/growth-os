package com.fillbook.growthos.ui.screens

import com.fillbook.growthos.data.EngagementStatus
import com.fillbook.growthos.data.engagementSpacingLine
import com.fillbook.growthos.data.engagementTodayLine
import com.fillbook.growthos.data.engagementWatchKind
import com.fillbook.growthos.data.extractEngagementErrorMessage
import com.fillbook.growthos.data.parseEngagementStatus
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Engage tab hands the owner text to post under someone else's video, so the parts that must not drift are
 * covered here: reading the server's queue (including a blocked creator), the caps line, the limits the editor
 * shows, and surfacing the server's refusal text instead of a generic network error.
 */
class EngagementScreenTest {
    private fun status(json: String): EngagementStatus = parseEngagementStatus(JSONObject(json))

    private val queueJson = """
        {
          "configured": true,
          "youtubeConfigured": true,
          "limits": {"dailyCapPerPlatform": 25, "minSpacingSeconds": 90, "creatorCooldownDays": 3},
          "today": {"youtube": {"done": 3, "cap": 25}, "tiktok": {"done": 0, "cap": 25}},
          "nextActionInSeconds": 42,
          "quota": {"day": "2026-10-10", "used": 105, "budget": 3000, "remaining": 2895},
          "queue": [
            {"id": "i1", "platform": "youtube", "url": "https://www.youtube.com/shorts/abcdefghijk", "title": "Why I stopped moving my stop",
             "creatorName": "Some Trader", "thumbnailUrl": null, "topComments": ["Best advice on stops"],
             "drafts": [{"id": "d1", "text": "First option"}, {"id": "d2", "text": "Second option"}],
             "status": "drafted", "source": "pasted", "block": null, "createdAt": "2026-10-10T18:00:00.000Z"},
            {"id": "i2", "platform": "tiktok", "url": "https://www.tiktok.com/@a/video/1", "title": "Revenge trading",
             "creatorName": "Trader Tom", "thumbnailUrl": "https://x/y.jpg", "topComments": [], "drafts": [],
             "status": "new", "source": "pasted",
             "block": {"code": "creator_cooldown", "message": "You engaged with this creator recently."}, "createdAt": "2026-10-10T18:01:00.000Z"}
          ],
          "watchlist": [{"id": "w1", "kind": "query", "value": "prop firm", "label": null, "active": true}],
          "autoFill": {"targetWaiting": 10, "nextRunAt": "2026-10-11T01:00:00.000Z", "nextRunLabel": "6:00 PM Arizona time", "lastRunAt": null, "lastRunNote": "discovered 3, drafted 3, queue 3"}
        }
    """.trimIndent()

    @Test
    fun parsesTheQueueDraftsAndBlocks() {
        val s = status(queueJson)
        assertTrue(s.configured)
        assertEquals(2, s.queue.size)
        assertEquals(listOf("First option", "Second option"), s.queue[0].drafts.map { it.text })
        assertNull(s.queue[0].blockMessage)
        assertEquals("You engaged with this creator recently.", s.queue[1].blockMessage)
        assertEquals("https://x/y.jpg", s.queue[1].thumbnailUrl)
        assertEquals(1, s.watchlistCount)
        assertEquals(105, s.quotaUsed)
    }

    @Test
    fun capsLineAndSpacingLine() {
        val s = status(queueJson)
        assertEquals("YouTube 3 of 25 today, TikTok 0 of 25", engagementTodayLine(s))
        assertEquals("Next action available in 42s", engagementSpacingLine(s))
        assertNull(engagementSpacingLine(status(queueJson.replace("\"nextActionInSeconds\": 42", "\"nextActionInSeconds\": 0"))))
    }

    @Test
    fun notConfiguredWhenMigrationMissing() {
        val s = status("""{"configured": false, "message": "not set up"}""")
        assertFalse(s.configured)
        assertEquals("not set up", s.message)
        assertTrue(s.queue.isEmpty())
    }

    @Test
    fun editorLimitsMatchThePlatforms() {
        assertEquals(150, engagementCharLimit("tiktok"))
        assertEquals(280, engagementCharLimit("youtube"))
    }

    @Test
    fun emptyMessageExplainsTheMissingYoutubeKey() {
        val s = status(queueJson.replace("\"youtubeConfigured\": true", "\"youtubeConfigured\": false"))
        assertTrue(engagementEmptyMessage(s).contains("YOUTUBE_API_KEY"))
        assertFalse(engagementEmptyMessage(status(queueJson)).contains("YOUTUBE_API_KEY"))
    }

    @Test
    fun emptyQueueSaysWhenTheNextAutomaticFillRuns() {
        val s = status(queueJson)
        assertEquals("6:00 PM Arizona time", s.nextFillLabel)
        assertEquals("discovered 3, drafted 3, queue 3", s.lastFillNote)
        val message = engagementEmptyMessage(s)
        assertTrue(message.contains("6:00 PM Arizona time"))
        assertFalse(message.contains("add a creator"))
        val old = status(queueJson.replace("\"autoFill\"", "\"ignored\""))
        assertNull(old.nextFillLabel)
        assertTrue(engagementEmptyMessage(old).contains("automatically"))
    }

    @Test
    fun watchKindIsInferredFromWhatWasPasted() {
        assertEquals("channel", engagementWatchKind("@tradertom"))
        assertEquals("channel", engagementWatchKind("UCabcdefghijklmnopqrstuv"))
        assertEquals("query", engagementWatchKind("prop firm payout"))
    }

    @Test
    fun surfacesTheServersRefusalText() {
        val body = "POST /api/approvals?resource=engagement failed: HTTP 429 -- {\"error\":\"Slow down: wait 60s since your last action.\",\"block\":{\"code\":\"min_spacing\"}}"
        assertEquals("Slow down: wait 60s since your last action.", extractEngagementErrorMessage(429, body))
        assertNull(extractEngagementErrorMessage(500, body))
        assertNull(extractEngagementErrorMessage(401, body))
    }
}
