package com.fillbook.growthos.data

import com.fillbook.growthos.ui.screens.todaysVideoRoute
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** GET /api/summary's `video` block, which the Home card shows. */
class TodaysVideoTest {
    @Test
    fun `reads the state, concept, day and the platforms already posted`() {
        val v = parseTodaysVideo(
            JSONObject(
                """{"state":"posted","title":"5 contracts against a plan of 3","day":5,"headline":"Posted","detail":"Posted on 2 of 3: TikTok, YouTube.","platformsPosted":["tiktok","youtube_shorts"]}""",
            ),
        )!!
        assertEquals(TodaysVideoState.POSTED, v.state)
        assertEquals(5, v.day)
        assertEquals("5 contracts against a plan of 3", v.title)
        assertEquals(listOf("tiktok", "youtube_shorts"), v.platformsPosted)
    }

    @Test
    fun `a state with no concept has no title or day`() {
        val v = parseTodaysVideo(JSONObject("""{"state":"none","title":null,"day":null,"headline":"No video yet today","detail":"Request today's video in Video Status.","platformsPosted":[]}"""))!!
        assertEquals(TodaysVideoState.NONE, v.state)
        assertNull(v.title)
        assertNull(v.day)
    }

    @Test
    fun `a missing block or an unknown state leaves the card out rather than guessing`() {
        assertNull(parseTodaysVideo(null))
        assertNull(parseTodaysVideo(JSONObject("""{"state":"something_new","headline":"x","detail":"y"}""")))
    }

    @Test
    fun `a script waiting for approval opens Approvals and every other state opens Video Status`() {
        assertEquals("approvals", todaysVideoRoute(TodaysVideoState.NEEDS_APPROVAL))
        for (s in TodaysVideoState.values().filter { it != TodaysVideoState.NEEDS_APPROVAL }) {
            assertEquals("video_status", todaysVideoRoute(s))
        }
    }
}
