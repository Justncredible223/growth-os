package com.fillbook.growthos.ui.screens

import com.fillbook.growthos.data.ApprovalAsset
import com.fillbook.growthos.data.ApprovalsBacklog
import com.fillbook.growthos.data.AssetStage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** P1 2026-11-15 (ChatGPT): readable titles, source and age, and a plain note when waiting drafts pause the auto-draft. */
class ApprovalsQueueTest {
    private fun asset(source: String?, display: String?) = ApprovalAsset(
        id = "a", campaignTitle = "HQ X draft hq-140", platform = "x", assetType = "x_feed_post", previewText = "t",
        stage = AssetStage.values().first(), isAutoDraft = false, costUsd = null, generatedAt = null, reviewPassCount = 0, reviewFailCount = 0,
        trackingQuery = "", source = source, displayTitle = display, waitingSince = null,
    )

    @Test
    fun anHqDraftShowsItsFirstLineAndSource() {
        val a = asset("hq", "See how close you are to your prop firm's rule lines.")
        assertEquals("See how close you are to your prop firm's rule lines.", approvalHeading(a))
        assertEquals("From HQ", approvalSourceLine(a))
        assertEquals("HQ X draft hq-140", approvalHeading(asset(null, null)))
        assertNull(approvalSourceLine(asset(null, null)))
    }

    @Test
    fun theBacklogNoteSaysWhyTheAutoDraftIsPaused() {
        assertEquals(
            "3 drafts are waiting, so the daily auto-draft is paused until fewer than 3 are waiting. Approve or reject to let it run.",
            backlogNote(ApprovalsBacklog(3, 3, true)),
        )
    }
}
