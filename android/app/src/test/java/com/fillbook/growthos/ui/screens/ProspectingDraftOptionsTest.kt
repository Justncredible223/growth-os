package com.fillbook.growthos.ui.screens

import com.fillbook.growthos.data.DraftOption
import com.fillbook.growthos.data.ProspectingCandidate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun candidate(options: List<DraftOption>, draftReply: String? = options.firstOrNull()?.text) = ProspectingCandidate(
    id = "c1", platform = "x", discoveryQuery = "q", discoveryLabel = "Q", replyClass = "A", authorHandle = "trader",
    authorFollowerCount = 1200, authorVerified = false, postText = "post", postUrl = "https://x.com/i/web/status/1",
    postCreatedAt = null, discoveredAt = null, opportunityScore = 50.0, scoreBreakdown = emptyMap(), creatorCandidate = false,
    status = "ready", draftReply = draftReply, draftOptions = options, replyMentionsFillbook = false, replyUsedLink = false,
)

class ProspectingDraftOptionsTest {
    private val sharp = DraftOption("sharp", "The drawdown does not care why you sized up.")
    private val helpful = DraftOption("helpful", "Most firms lock the floor once you are up the drawdown amount.")

    @Test
    fun `two options render as two blocks, one option or none keeps the single box`() {
        assertTrue(hasTwoOptions(candidate(listOf(sharp, helpful))))
        assertFalse(hasTwoOptions(candidate(listOf(sharp))))
        assertFalse(hasTwoOptions(candidate(emptyList(), draftReply = "Old draft.")))
    }

    @Test
    fun `defaults to the first option and follows the last one chosen`() {
        val c = candidate(listOf(sharp, helpful))
        assertEquals("sharp", activeStyle(c, null))
        assertEquals("helpful", activeStyle(c, "helpful"))
        assertEquals("sharp", activeStyle(c, "unknown"))
    }

    @Test
    fun `untouched first option posts as draftReply so no finalReply is sent`() {
        val c = candidate(listOf(sharp, helpful))
        assertNull(finalReplyToSend(c, emptyMap(), null))
        assertEquals(sharp.text, currentReplyText(c, emptyMap(), null))
    }

    @Test
    fun `choosing the helpful option sends its text so the backend can tag it`() {
        val c = candidate(listOf(sharp, helpful))
        assertEquals(helpful.text, finalReplyToSend(c, emptyMap(), "helpful"))
    }

    @Test
    fun `an edit to the chosen option is what gets copied and sent`() {
        val c = candidate(listOf(sharp, helpful))
        val edits = mapOf(optionEditKey("c1", "sharp") to "Edited line.")
        assertEquals("Edited line.", currentReplyText(c, edits, "sharp"))
        assertEquals("Edited line.", finalReplyToSend(c, edits, "sharp"))
        // The other option is unaffected.
        assertEquals(helpful.text, currentReplyText(c, edits, "helpful"))
    }

    @Test
    fun `older single drafts keep the original edit-by-id behavior`() {
        val c = candidate(emptyList(), draftReply = "Old draft.")
        assertEquals("Old draft.", currentReplyText(c, emptyMap(), null))
        assertNull(finalReplyToSend(c, emptyMap(), null))
        assertEquals("Changed.", finalReplyToSend(c, mapOf("c1" to "Changed."), null))
    }

    @Test
    fun `labels are owner friendly`() {
        assertEquals("Sharp", styleLabel("sharp"))
        assertEquals("Helpful", styleLabel("helpful"))
    }
}
