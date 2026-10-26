package com.fillbook.growthos.ui.screens

import com.fillbook.growthos.data.ProspectingDiagnostics
import com.fillbook.growthos.data.ProspectingPacing
import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

private fun diagnostics(
    totalConsidered: Int,
    selected: Int = 0,
    deferred: Int = 0,
    belowQualityBar: Int = 0,
    tooOldForToday: Int = 0,
) = ProspectingDiagnostics(
    totalConsidered = totalConsidered,
    selected = selected,
    deferred = deferred,
    belowQualityBar = belowQualityBar,
    tooOldForToday = tooOldForToday,
)

/**
 * Regression/behavior coverage for the 2026-09-07 empty-state follow-up:
 * the Prospecting queue's empty state used to say the same generic thing
 * ("New opportunities are found once a day...") whether discovery had
 * genuinely found nothing, or a real backlog existed but was entirely
 * excluded as stale/low-quality -- indistinguishable to the owner. These
 * tests exercise every diagnostic combination the real API can return.
 */
class ProspectingScreenTest {
    @Test
    fun `falls back to the original generic copy when diagnostics is null -- an API response that predates the field`() {
        assertEquals(
            "New opportunities are found once a day. Check back soon, or pull to refresh.",
            prospectingEmptyStateMessage(null),
        )
    }

    @Test
    fun `reports a genuinely empty backlog distinctly from an excluded one`() {
        val message = prospectingEmptyStateMessage(diagnostics(totalConsidered = 0))
        assertEquals("No new candidates were found. Discovery will try again on its next scheduled run.", message)
    }

    @Test
    fun `explains a too-old-only exclusion using owner-friendly wording, plural`() {
        val message = prospectingEmptyStateMessage(diagnostics(totalConsidered = 23, tooOldForToday = 23))
        assertEquals("23 posts were too old for today's active reply window. Check back soon, or pull to refresh.", message)
    }

    @Test
    fun `explains a single too-old exclusion with correct singular grammar`() {
        val message = prospectingEmptyStateMessage(diagnostics(totalConsidered = 1, tooOldForToday = 1))
        assertEquals("1 post was too old for today's active reply window. Check back soon, or pull to refresh.", message)
    }

    @Test
    fun `explains a below-quality-bar-only exclusion using owner-friendly wording, plural`() {
        val message = prospectingEmptyStateMessage(diagnostics(totalConsidered = 6, belowQualityBar = 6))
        assertEquals("6 candidates didn't meet today's quality bar. Check back soon, or pull to refresh.", message)
    }

    @Test
    fun `explains a single below-quality-bar exclusion with correct singular grammar`() {
        val message = prospectingEmptyStateMessage(diagnostics(totalConsidered = 1, belowQualityBar = 1))
        assertEquals("1 candidate didn't meet today's quality bar. Check back soon, or pull to refresh.", message)
    }

    @Test
    fun `combines both reasons honestly when both apply -- a real production case had 23 too-old and 6 below the bar at once`() {
        val message = prospectingEmptyStateMessage(diagnostics(totalConsidered = 29, tooOldForToday = 23, belowQualityBar = 6))
        assertEquals(
            "23 posts were too old for today's active reply window, and 6 candidates didn't meet today's quality bar. Check back soon, or pull to refresh.",
            message,
        )
    }

    @Test
    fun `never mentions internal field names like tooOldForToday or belowQualityBar`() {
        val message = prospectingEmptyStateMessage(diagnostics(totalConsidered = 29, tooOldForToday = 23, belowQualityBar = 6))
        assertFalse(message.contains("tooOldForToday"))
        assertFalse(message.contains("belowQualityBar"))
        assertFalse(message.contains("Considered"))
    }

    @Test
    fun `falls back to the generic message if diagnostics are present but neither known exclusion reason explains the empty queue`() {
        // A hypothetical future/edge shape (e.g. all deferred, none too-old or below-bar) --
        // should never leave the owner with a blank or nonsensical explanation.
        val message = prospectingEmptyStateMessage(diagnostics(totalConsidered = 5, deferred = 5))
        assertEquals("New opportunities are found once a day. Check back soon, or pull to refresh.", message)
    }
}

/**
 * Regression guard for a real, confirmed-with-a-real-finger bug
 * (2026-09-07): PullToRefreshBox detects the pull gesture via a NESTED
 * SCROLL connection -- it only ever sees drag deltas a scrollable
 * descendant dispatches upward. PolishedEmptyState is a plain,
 * non-scrollable Column (see GrowthComponents.kt), so wrapping it directly
 * in PullToRefreshBox (this file's first, insufficient fix attempt) left
 * the gesture completely inert: no touch drag on static content ever
 * reaches the nested-scroll chain, no matter where it's nested. The real
 * fix wraps the empty state in a LazyColumn (a genuine nested-scroll
 * participant, the same container the populated case already uses).
 *
 * This project has no instrumentation-test infrastructure at all (no
 * androidTest source set, no Espresso/Compose-UI-test dependency, no
 * `./gradlew connectedDebugAndroidTest` target -- confirmed by inspecting
 * app/build.gradle.kts, which explicitly documents "No emulator or
 * instrumentation needed" as this project's deliberate JVM-only testing
 * philosophy) -- a true gesture test (simulate a real swipe, assert the
 * refresh indicator appears) needs `androidx.compose.ui:ui-test-junit4`
 * plus a connected device/emulator, which is a real project-wide
 * infrastructure decision well beyond this one fix's scope, so it isn't
 * added here. This is the strongest coverage available without that:
 * not a behavioral gesture test, but a structural check on the actual
 * source that fails loudly if a future edit reintroduces a bare, unwrapped
 * PolishedEmptyState inside PullToRefreshBox's empty branch.
 */
/**
 * Regression guard for a real, confirmed bug (2026-09-07): the owner's
 * phone showed crypto-only posts as actionable Prospecting cards with an
 * enabled "Draft reply" button, only rejecting them after the tap. The
 * backend fix (prospectingHandlers.ts's listProspectingQueue) now filters
 * these to 'not_relevant' before they're ever returned, so this branch
 * should be structurally unreachable in practice -- this is a defensive,
 * backward-compatible guard (status is a plain existing String field, no
 * new schema) against a stale/cached response or an older backend build.
 *
 * Same structural-check rationale as ProspectingScreenEmptyStateStructureTest
 * below: this project has no instrumentation-test infrastructure, so a true
 * Compose-rendering test isn't added here -- this instead proves, from the
 * actual source, that a "not_relevant" candidate is routed to a
 * non-actionable status line before the code path that renders the
 * "Draft reply" button is ever reached.
 */
class ProspectingScreenIneligibleCandidateStructureTest {
    private fun screenSource(): String {
        val candidates = listOf(
            "src/main/java/com/fillbook/growthos/ui/screens/ProspectingScreen.kt",
            "app/src/main/java/com/fillbook/growthos/ui/screens/ProspectingScreen.kt",
        )
        val file = candidates.map { java.io.File(it) }.firstOrNull { it.exists() }
            ?: error(
                "Could not locate ProspectingScreen.kt from working directory " +
                    "${java.io.File(".").absolutePath} -- tried: $candidates.",
            )
        return file.readText()
    }

    @Test
    fun `a not_relevant candidate is routed to a non-actionable status line before the Draft reply branch`() {
        val source = screenSource()
        val notRelevantCheckIndex = source.indexOf("candidate.status == \"not_relevant\"")
        check(notRelevantCheckIndex >= 0) {
            "Expected an explicit candidate.status == \"not_relevant\" check in ProspectingScreen.kt -- " +
                "has the ineligible-candidate guard been removed or restructured?"
        }

        val draftReplyButtonIndex = source.indexOf("PrimaryButton(text = \"Draft reply\"")
        check(draftReplyButtonIndex >= 0) { "Expected to find the Draft reply PrimaryButton in ProspectingScreen.kt." }

        check(notRelevantCheckIndex < draftReplyButtonIndex) {
            "The candidate.status == \"not_relevant\" check must come before (guard) the Draft reply button, " +
                "as an earlier branch in the same if/else chain -- otherwise an ineligible candidate could still " +
                "render an enabled Draft reply button, confirmed as a real bug on-device (2026-09-07)."
        }

        // The two must be part of the SAME if/else chain, not unrelated
        // code that merely happens to appear in this order -- check no
        // second, unrelated "if (" starts and never closes between them
        // by requiring the not_relevant branch's own "else if (draft == null)"
        // continuation appears before the button.
        val window = source.substring(notRelevantCheckIndex, draftReplyButtonIndex)
        check(window.contains("else if (draft == null)")) {
            "Expected the not_relevant check and the Draft reply button to be part of the same if/else-if " +
                "chain (\"if (candidate.status == \\\"not_relevant\\\") { ... } else if (draft == null) { <Draft reply> }\") " +
                "so the guard actually prevents the button from rendering, not just precedes it textually."
        }
    }
}

class ProspectingScreenEmptyStateStructureTest {
    private fun screenSource(): String {
        val candidates = listOf(
            "src/main/java/com/fillbook/growthos/ui/screens/ProspectingScreen.kt",
            "app/src/main/java/com/fillbook/growthos/ui/screens/ProspectingScreen.kt",
        )
        val file = candidates.map { java.io.File(it) }.firstOrNull { it.exists() }
            ?: error(
                "Could not locate ProspectingScreen.kt from working directory " +
                    "${java.io.File(".").absolutePath} -- tried: $candidates. " +
                    "This test intentionally fails loudly rather than silently " +
                    "skipping the check it exists to enforce.",
            )
        return file.readText()
    }

    @Test
    fun `the empty-state branch wraps PolishedEmptyState in a LazyColumn, not bare -- otherwise pull-to-refresh is silently inert`() {
        val source = screenSource()
        val emptyBranchStart = source.indexOf("errorMessage == null && items.isEmpty()")
        check(emptyBranchStart >= 0) { "Could not find the empty-state condition in ProspectingScreen.kt -- has this branch been restructured?" }

        // Look at a bounded window right after the condition, not the whole
        // file, so this can't accidentally match LazyColumn/PolishedEmptyState
        // usages belonging to the populated-list branch instead.
        val window = source.substring(emptyBranchStart, minOf(emptyBranchStart + 400, source.length))

        val lazyColumnIndex = window.indexOf("LazyColumn")
        val polishedEmptyStateIndex = window.indexOf("PolishedEmptyState")
        check(polishedEmptyStateIndex >= 0) { "Expected to find PolishedEmptyState right after the empty-state condition." }
        check(lazyColumnIndex in 0 until polishedEmptyStateIndex) {
            "PolishedEmptyState must be wrapped inside a LazyColumn (or another genuine nested-scroll " +
                "participant) so PullToRefreshBox's pull gesture has something to detect -- a bare, " +
                "non-scrollable PolishedEmptyState makes the pull-to-refresh gesture silently inert, " +
                "confirmed with a real finger on-device (2026-09-07)."
        }
    }
}

/** Reply pacing (2026-09-25): burst posting got @FillbookHQ's replies hidden on X, so the queue holds the next reply. */
class ReplyPacingTest {
    private val now = 1_000_000_000L
    private fun pacing(replied: Int, nextInMinutes: Long?, reason: String?) =
        ProspectingPacing(replied, 5, 20, nextInMinutes?.let { now + it * 60_000 }, reason)

    @Test
    fun noPacingFromAnOlderApiShowsNothingAndHoldsNothing() {
        assertNull(replyPacingLine(null, now))
        assertNull(replyHoldLabel(null, now))
    }

    @Test
    fun readyToReplyShowsTheCountAndDoesNotHoldTheButton() {
        assertEquals("2 of 5 replies in the last 24h. Space them at least 20 min apart.", replyPacingLine(pacing(2, null, null), now))
        assertNull(replyHoldLabel(pacing(2, null, null), now))
    }

    @Test
    fun cooldownHoldsTheButtonWithAMinuteCountdown() {
        assertEquals("Next reply in 14 min", replyHoldLabel(pacing(1, 14, "cooldown"), now))
        assertEquals("Next reply in 14 min. Posting in bursts gets replies hidden on X.", replyPacingLine(pacing(1, 14, "cooldown"), now))
    }

    @Test
    fun dailyCapShowsHoursAndTheCount() {
        assertEquals("Next reply in 3h 5m", replyHoldLabel(pacing(5, 185, "daily_cap"), now))
        assertEquals("5 of 5 replies in the last 24h. Next reply in 3h 5m. Posting in bursts gets replies hidden on X.", replyPacingLine(pacing(5, 185, "daily_cap"), now))
    }

    @Test
    fun aWaitThatHasAlreadyPassedNoLongerHolds() {
        assertNull(replyHoldLabel(pacing(1, -1, "cooldown"), now))
    }

    @Test
    fun maybeDraftAnywayIsHeldWhileAnyRowIsDraftingAndLabelsOnlyThatRow() {
        assertEquals(true, maybeDraftEnabled(null))
        assertEquals(false, maybeDraftEnabled("m1"))
        assertEquals("Draft anyway", maybeDraftLabel(false))
        assertEquals("Drafting...", maybeDraftLabel(true))
    }
}
