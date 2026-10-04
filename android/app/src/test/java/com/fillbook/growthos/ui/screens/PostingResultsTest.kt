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

    private fun result(id: String, views: Int?, day: Int? = null) =
        com.fillbook.growthos.data.VideoResult(id, "Title $id", "2026-10-01T00:00:00Z", views, emptyList(), day)

    @Test
    fun leaderboardRanksByViewsAndSkipsVideosWithoutNumbers() {
        val ranked = rankedVideos(listOf(result("a", 120), result("b", null), result("c", 900), result("d", 0), result("e", 450)))
        assertEquals(listOf("c", "e", "a"), ranked.map { it.campaignAssetId })
        assertEquals(5, rankedVideos((1..9).map { result("v$it", it * 10) }).size)
    }

    @Test
    fun conceptHeadingShowsTheDayWhenKnown() {
        assertEquals("Day 5 · Title a", conceptHeading(result("a", 1, day = 5)))
        assertEquals("Title a", conceptHeading(result("a", 1)))
    }

    @Test
    fun statsButtonAsksForTheDaySevenNumbers() {
        fun post(first: Boolean, day7: Boolean) = com.fillbook.growthos.data.PostResult("p", PostingPlatform.TIKTOK, "u", "t", null, null, null, null, null, first, day7)
        assertEquals("Add stats", statsButtonLabel(post(true, false)))
        assertEquals("Add day-7 stats", statsButtonLabel(post(false, true)))
        assertEquals("Update", statsButtonLabel(post(false, false)))
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

/** Video Status polish (2026-10-04): auto-refresh, dismiss confirmation and the concept heading. */
class VideoStatusPolishTest {
    private fun render(status: String) = com.fillbook.growthos.data.VideoRenderStatus(
        id = "r", campaignAssetId = "a", status = status, downloadUrl = null, thumbnailDownloadUrl = null,
        durationSeconds = null, error = null, createdAt = "t", updatedAt = "t", videoMetadata = null,
    )

    @Test
    fun refreshesOnlyWhileSomethingIsInProgress() {
        assertEquals(true, shouldAutoRefresh("queued"))
        assertEquals(true, shouldAutoRefresh("rendering"))
        assertEquals(false, shouldAutoRefresh("ready"))
        assertEquals(false, shouldAutoRefresh("failed"))
    }

    @Test
    fun onlyAFinishedVideoAsksBeforeItIsDeleted() {
        assertEquals(true, needsDismissConfirm(render("ready")))
        assertEquals(false, needsDismissConfirm(render("failed")))
        assertEquals(false, needsDismissConfirm(render("queued")))
    }

    @Test
    fun headingShowsTheDayWhenKnown() {
        assertEquals("Day 5 · Five contracts", videoCardHeading(5, "Five contracts"))
        assertEquals("Five contracts", videoCardHeading(null, "Five contracts"))
    }
}

class RejectReasonsTest {
    @Test
    fun offersShortDistinctReasons() {
        assertTrue(REJECT_REASONS.size in 3..6)
        assertEquals(REJECT_REASONS.size, REJECT_REASONS.toSet().size)
        assertTrue(REJECT_REASONS.all { it.length <= 40 })
    }
}

class ApprovalHeadingTest {
    private fun asset(title: String, concept: String?, day: Int?) = com.fillbook.growthos.data.ApprovalAsset(
        "i", title, "p", "video_script", "x", com.fillbook.growthos.data.AssetStage.READY_FOR_OWNER, false, null, null, 0, 0, "", concept, day,
    )

    @Test
    fun showsTheDayAndConceptForAMotionDraft() {
        assertEquals("Day 5 · Five contracts", approvalHeading(asset("Motion concept request: Five contracts", "Five contracts", 5)))
        assertEquals("Five contracts", approvalHeading(asset("Motion concept request: Five contracts", "Five contracts", null)))
        assertEquals("Plain title", approvalHeading(asset("Plain title", null, null)))
    }
}

class XPostCounterTest {
    @Test
    fun warnsOnlyPastTheNormalLimit() {
        assertEquals("5 / 280" to false, xPostCounter("hello"))
        assertEquals(false, xPostCounter("a".repeat(280)).second)
        val over = xPostCounter("a".repeat(281))
        assertEquals(true, over.second)
        assertTrue(over.first.startsWith("281 / 280"))
    }

    @Test
    fun countsWithoutLeadingOrTrailingWhitespace() {
        assertEquals("2 / 280", xPostCounter("  hi \n").first)
    }
}
