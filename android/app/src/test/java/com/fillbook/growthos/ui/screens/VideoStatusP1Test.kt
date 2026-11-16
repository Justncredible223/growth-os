package com.fillbook.growthos.ui.screens

import com.fillbook.growthos.data.PlanPost
import com.fillbook.growthos.data.PostingPlatform
import org.junit.Assert.assertEquals
import org.junit.Test

/** P1 2026-11-15: every video card says where it is posted and what is left. */
class VideoStatusP1Test {
    @Test
    fun postedSummaryNamesWhatIsDoneAndWhatIsLeft() {
        assertEquals("Not posted yet. Add each link after you post.", postedSummary(emptyList()))
        assertEquals(
            "Posted on TikTok · not yet on YouTube, Instagram",
            postedSummary(listOf(PlanPost(PostingPlatform.TIKTOK, "https://www.tiktok.com/x", "2026-11-15T19:00:00Z"))),
        )
        assertEquals(
            "Posted on TikTok, YouTube, Instagram.",
            postedSummary(PostingPlatform.entries.map { PlanPost(it, "https://x", "2026-11-15T19:00:00Z") }),
        )
    }
}
