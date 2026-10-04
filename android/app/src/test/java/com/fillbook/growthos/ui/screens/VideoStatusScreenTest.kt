package com.fillbook.growthos.ui.screens

import com.fillbook.growthos.data.VideoRenderMetadata
import com.fillbook.growthos.ui.components.StatusTone
import org.junit.Assert.assertEquals
import org.junit.Test

class VideoStatusScreenTest {
    @Test
    fun `maps every real render status to the right visual tone`() {
        assertEquals(StatusTone.WAITING, statusTone("queued"))
        assertEquals(StatusTone.WAITING, statusTone("rendering"))
        assertEquals(StatusTone.READY, statusTone("ready"))
        assertEquals(StatusTone.FAILED, statusTone("failed"))
        assertEquals(StatusTone.SKIPPED, statusTone("canceled"))
    }

    @Test
    fun `falls back to a neutral tone for an unrecognized future status rather than crashing`() {
        assertEquals(StatusTone.NEUTRAL, statusTone("some_future_status"))
    }

    @Test
    fun `every real status gets a real, human-readable label`() {
        assertEquals("Queued", statusLabel("queued"))
        assertEquals("Rendering", statusLabel("rendering"))
        assertEquals("Ready", statusLabel("ready"))
        assertEquals("Failed", statusLabel("failed"))
        assertEquals("Canceled", statusLabel("canceled"))
    }

    @Test
    fun `capitalizes an unrecognized future status rather than showing a raw db value`() {
        assertEquals("Some_future_status", statusLabel("some_future_status"))
    }
}

/**
 * Regression guard for the Share sheet only ever carrying the video file,
 * never a caption (owner-reported 2026-09-22: TikTok's own share target
 * showed up blank, forcing a manual copy/paste from this screen's TIKTOK
 * section every time). buildTiktokShareText is the single source both the
 * on-screen copy button and the Share intent's EXTRA_TEXT now read from, so
 * they can never drift apart -- these tests pin its exact join behavior.
 */
class VideoStatusScreenShareTextTest {
    private fun meta(
        tiktokCaption: String = "Caption text",
        hashtags: List<String> = emptyList(),
        disclosureCta: String? = null,
    ) = VideoRenderMetadata(
        youtubeTitle = "Title",
        youtubeDescription = "Description",
        tiktokCaption = tiktokCaption,
        instagramCaption = null,
        hashtags = hashtags,
        disclosureCta = disclosureCta,
        youtubeThumbnailConcept = null,
    )

    @Test
    fun `joins caption, hashtags, and disclosure CTA on their own lines`() {
        val text = buildTiktokShareText(
            meta(tiktokCaption = "Watch this", hashtags = listOf("FuturesTrading", "TradingJournal"), disclosureCta = "Not financial advice."),
        )
        assertEquals("Watch this\n#FuturesTrading #TradingJournal\nNot financial advice.", text)
    }

    @Test
    fun `omits the hashtag line entirely when there are no hashtags, rather than leaving a blank line`() {
        val text = buildTiktokShareText(meta(tiktokCaption = "Watch this", hashtags = emptyList(), disclosureCta = "Not financial advice."))
        assertEquals("Watch this\nNot financial advice.", text)
    }

    @Test
    fun `YouTube share text is the plain title, with any hashtags stripped`() {
        val m = meta(hashtags = listOf("FuturesTrading")).copy(youtubeTitle = "Drawdown Rules Explained #shorts #FuturesTrading")
        assertEquals("Drawdown Rules Explained", buildYoutubeShareText(m))
    }

    @Test
    fun `omits the disclosure line entirely when null, rather than leaving a blank line`() {
        val text = buildTiktokShareText(meta(tiktokCaption = "Watch this", hashtags = listOf("FuturesTrading"), disclosureCta = null))
        assertEquals("Watch this\n#FuturesTrading", text)
    }

    @Test
    fun `is just the caption alone when there are no hashtags or disclosure CTA`() {
        assertEquals("Watch this", buildTiktokShareText(meta(tiktokCaption = "Watch this")))
    }
}

/**
 * Regression guard for the same real, confirmed-with-a-real-finger bug fixed
 * on ProspectingScreen (2026-09-07), independently found here too by
 * inspection: this screen's "No videos yet" empty state used to sit entirely
 * outside PullToRefreshBox, so pull-to-refresh was inert on it. Fix: wrap the
 * whole branch (empty and populated) in a single PullToRefreshBox, with the
 * empty state rendered inside a LazyColumn -- a genuine nested-scroll
 * participant -- instead of a bare, non-scrollable PolishedEmptyState.
 *
 * Same structural-check rationale as ProspectingScreenEmptyStateStructureTest:
 * this project has no instrumentation-test infrastructure, so a true gesture
 * test isn't added here (see that class's kdoc for the full explanation).
 */
class VideoStatusScreenEmptyStateStructureTest {
    private fun screenSource(): String {
        val candidates = listOf(
            "src/main/java/com/fillbook/growthos/ui/screens/VideoStatusScreen.kt",
            "app/src/main/java/com/fillbook/growthos/ui/screens/VideoStatusScreen.kt",
        )
        val file = candidates.map { java.io.File(it) }.firstOrNull { it.exists() }
            ?: error(
                "Could not locate VideoStatusScreen.kt from working directory " +
                    "${java.io.File(".").absolutePath} -- tried: $candidates.",
            )
        return file.readText()
    }

    @Test
    fun `the empty-state branch is inside PullToRefreshBox and wraps PolishedEmptyState in a LazyColumn`() {
        val source = screenSource()

        val pullToRefreshIndex = source.indexOf("PullToRefreshBox(")
        val emptyBranchIndex = source.indexOf("errorMessage == null && renders.isEmpty()")
        check(pullToRefreshIndex >= 0) { "Could not find PullToRefreshBox in VideoStatusScreen.kt -- has this screen been restructured?" }
        check(emptyBranchIndex >= 0) { "Could not find the empty-state condition in VideoStatusScreen.kt -- has this branch been restructured?" }
        check(pullToRefreshIndex < emptyBranchIndex) {
            "The empty-state condition must be evaluated INSIDE PullToRefreshBox, not before/outside it -- " +
                "otherwise pull-to-refresh is unreachable while the render list is empty, confirmed by inspection (2026-09-07)."
        }

        val window = source.substring(emptyBranchIndex, minOf(emptyBranchIndex + 400, source.length))
        val lazyColumnIndex = window.indexOf("LazyColumn(")
        val polishedEmptyStateIndex = window.indexOf("PolishedEmptyState(")
        check(polishedEmptyStateIndex >= 0) { "Expected to find PolishedEmptyState right after the empty-state condition." }
        check(lazyColumnIndex in 0 until polishedEmptyStateIndex) {
            "PolishedEmptyState must be wrapped inside a LazyColumn (or another genuine nested-scroll " +
                "participant) so PullToRefreshBox's pull gesture has something to detect."
        }
    }
}

/**
 * Regression guard for the release-audit finding (2026-09-07): the
 * Download button had no busy/in-flight guard, so a rapid double-tap
 * could enqueue two DownloadManager requests for the same render. Fixed
 * with a `downloadingIds: Set<String>` checked before starting a new
 * download and released on every path: enqueue failure (synchronously),
 * and both the success and failure/cancellation branches of the
 * DownloadManager completion broadcast receiver.
 */
class VideoStatusScreenDownloadGuardStructureTest {
    private fun screenSource(): String {
        val file = java.io.File("src/main/java/com/fillbook/growthos/ui/screens/VideoStatusScreen.kt")
            .let { if (it.exists()) it else java.io.File("app/src/main/java/com/fillbook/growthos/ui/screens/VideoStatusScreen.kt") }
        check(file.exists()) { "Could not locate VideoStatusScreen.kt from working directory ${java.io.File(".").absolutePath}." }
        return file.readText()
    }

    @Test
    fun `download() checks the guard and adds this render's id before enqueuing`() {
        val source = screenSource()
        val downloadFnIndex = source.indexOf("fun download(render: VideoRenderStatus) {")
        check(downloadFnIndex >= 0) { "Could not find the download() function -- has it been renamed or restructured?" }

        val enqueueIndex = source.indexOf("downloadManager.enqueue(request)", downloadFnIndex)
        check(enqueueIndex >= 0) { "Could not find the enqueue() call inside download()." }

        val window = source.substring(downloadFnIndex, enqueueIndex)
        check(window.contains("if (render.id in downloadingIds) return")) {
            "Expected download() to bail out early when this render's id is already in downloadingIds -- " +
                "otherwise a rapid double-tap can start two downloads for the same render."
        }
        check(window.contains("downloadingIds = downloadingIds + render.id")) {
            "Expected download() to add render.id to downloadingIds before calling enqueue() -- otherwise " +
                "the button never shows a busy/disabled state while the download is starting."
        }
    }

    @Test
    fun `the guard is released when enqueue fails, so a failed start never leaves the button stuck disabled`() {
        val source = screenSource()
        val enqueueIndex = source.indexOf("downloadManager.enqueue(request)")
        check(enqueueIndex >= 0)
        val afterEnqueue = source.substring(enqueueIndex, minOf(enqueueIndex + 400, source.length))
        check(afterEnqueue.contains("downloadingIds = downloadingIds - render.id")) {
            "Expected the id == null (enqueue failed) branch to release the guard (downloadingIds - " +
                "render.id) -- otherwise a failed enqueue leaves the Download button permanently disabled."
        }
    }

    @Test
    fun `the guard is released in the completion receiver, covering both the success and failure-or-cancellation branches`() {
        val source = screenSource()
        val onReceiveIndex = source.indexOf("override fun onReceive(")
        check(onReceiveIndex >= 0) { "Could not find the download-completion BroadcastReceiver's onReceive()." }

        // Window covering the whole onReceive body (success branch,
        // failure/cancellation branch, and the shared cleanup after both),
        // bounded by the receiver's registration right after it rather than
        // a fixed character count -- a fixed 2200-char window broke when
        // cb6bdc4 legitimately grew the success branch (FileProvider share
        // URI), even though the guard was still released.
        val receiverEndIndex = source.indexOf("IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)", onReceiveIndex)
        check(receiverEndIndex >= 0) { "Could not find the receiver's IntentFilter registration after onReceive()." }
        val window = source.substring(onReceiveIndex, receiverEndIndex)
        check(window.contains("downloadingIds = downloadingIds - videoRenderId")) {
            "Expected the completion receiver to release this render's id from downloadingIds after handling " +
                "the result -- otherwise the Download button stays disabled forever once a real download " +
                "actually completes (or is cancelled/fails)."
        }
    }

    @Test
    fun `the guard is released before the lookup, so a download canceled from its notification can't leave the button stuck`() {
        // DownloadManager deletes a canceled download's row before broadcasting ACTION_DOWNLOAD_COMPLETE, so the
        // lookup's cursor is empty. The receiver used to return there before releasing the guard (2026-09-25).
        val source = screenSource()
        val onReceiveIndex = source.indexOf("override fun onReceive(")
        val releaseIndex = source.indexOf("downloadingIds = downloadingIds - videoRenderId", onReceiveIndex)
        val emptyCursorIndex = source.indexOf("cursor.moveToFirst()", onReceiveIndex)
        val managerLookupIndex = source.indexOf("getSystemService<DownloadManager>()", onReceiveIndex)
        check(releaseIndex in 0 until emptyCursorIndex) { "The guard must be released before the empty-cursor early return." }
        check(releaseIndex < managerLookupIndex) { "The guard must be released before the DownloadManager lookup can return early." }
        check(source.indexOf("Download canceled.", onReceiveIndex) > emptyCursorIndex) { "A canceled download should say so." }
    }
}

/**
 * Regression guard for the "Create Fillbook Video" feature (2026-09-08):
 * this project has no instrumentation-test infrastructure (see
 * ProspectingScreenEmptyStateStructureTest's kdoc for the full
 * explanation), so these are structural checks on the actual source
 * proving the confirmation dialog exists with its required disclosure
 * points, the duplicate-tap guard is checked before firing a request, and
 * the real backend error message is surfaced rather than a generic one.
 */
class VideoStatusScreenCreateVideoStructureTest {
    private fun screenSource(): String {
        val file = java.io.File("src/main/java/com/fillbook/growthos/ui/screens/VideoStatusScreen.kt")
            .let { if (it.exists()) it else java.io.File("app/src/main/java/com/fillbook/growthos/ui/screens/VideoStatusScreen.kt") }
        check(file.exists()) { "Could not locate VideoStatusScreen.kt from working directory ${java.io.File(".").absolutePath}." }
        return file.readText()
    }

    @Test
    fun `the confirmation dialog explains paid LLM budget, no auto-post, and that approval starts the render`() {
        val source = screenSource()
        val confirmDialogIndex = source.indexOf("Create a real video draft?")
        check(confirmDialogIndex >= 0) { "Expected a confirmation dialog titled 'Create a real video draft?'." }

        val window = source.substring(confirmDialogIndex, minOf(confirmDialogIndex + 1200, source.length))
        check(window.contains("paid LLM/render budget")) { "Expected the confirmation dialog to disclose real paid LLM/render budget usage." }
        check(window.contains("REAL video draft")) { "Expected the confirmation dialog to state this creates a real draft, not a preview." }
        check(window.contains("NOT post anywhere automatically")) { "Expected the confirmation dialog to disclose no auto-posting." }
        check(window.contains("approving it there is what starts the render")) {
            "Expected the confirmation dialog to disclose that approval in Approvals is what starts the render."
        }
    }

    @Test
    fun `requestVideoScript() checks the busy-duplicate-tap guard before doing anything else`() {
        val source = screenSource()
        val fnIndex = source.indexOf("fun requestVideoScript() {")
        check(fnIndex >= 0) { "Could not find requestVideoScript() -- has it been renamed or restructured?" }
        val window = source.substring(fnIndex, minOf(fnIndex + 300, source.length))
        check(window.contains("if (creatingVideoScript) return")) {
            "Expected requestVideoScript() to bail out early when a request is already in flight -- otherwise a " +
                "rapid double-tap on Confirm can fire two real, paid requests for the same topic."
        }
    }

    @Test
    fun `the Confirm button is disabled while a request is in flight`() {
        val source = screenSource()
        val confirmDialogIndex = source.indexOf("Create a real video draft?")
        check(confirmDialogIndex >= 0)
        val window = source.substring(confirmDialogIndex, minOf(confirmDialogIndex + 1500, source.length))
        check(window.contains("enabled = !creatingVideoScript")) {
            "Expected the Confirm button to be disabled while creatingVideoScript is true, showing a busy state."
        }
    }

    @Test
    fun `a real backend rejection (off-topic, duplicate, invalid) is surfaced via extractVideoScriptRequestErrorMessage, not a generic message`() {
        val source = screenSource()
        val fnIndex = source.indexOf("fun requestVideoScript() {")
        check(fnIndex >= 0)
        val fnEnd = source.indexOf("\n    fun ", fnIndex + 1).let { if (it < 0) source.length else it }
        val window = source.substring(fnIndex, fnEnd)
        check(window.contains("extractVideoScriptRequestErrorMessage(e.httpCode, e.message)")) {
            "Expected requestVideoScript() to try extracting the real backend error message before falling back " +
                "to a generic 'check your connection' message -- otherwise an off-topic-topic or duplicate-topic " +
                "rejection is indistinguishable from a network failure."
        }
    }

    @Test
    fun `Continue is disabled until a motion concept is picked, and there is no custom-topic or Radar path`() {
        val source = screenSource()
        check(source.contains("Create Fillbook Video")) { "Expected a 'Create Fillbook Video' entry dialog title." }
        val confirmIndex = source.indexOf("TextButton(\n                    onClick = { showCreateVideoDialog = false; showVideoConfirmDialog = true },")
        check(confirmIndex >= 0) { "Expected the entry dialog's Continue button." }
        val window = source.substring(confirmIndex, minOf(confirmIndex + 200, source.length))
        check(window.contains("selectedMotionConceptId != null") && window.contains("requestedToday == null")) {
            "Expected Continue to require a picked motion concept and a free day (the one-a-day rule)."
        }
        // Owner decision 2026-10-03: Motion render is the only way to make a video; the backend refuses the other two.
        for (gone in listOf("videoTopicInput", "useExistingOpportunity", "selectedOpportunityId", "Custom topic", "Existing Radar opportunity", "getSuggestedTopics")) {
            check(!source.contains(gone)) { "Expected the removed custom-topic/Radar path to be gone, but found '$gone' in VideoStatusScreen." }
        }
    }

    @Test
    fun `ready-with-metadata renders a YouTube, a TikTok, and an Instagram copyable section`() {
        val source = screenSource()
        check(source.contains("\"YOUTUBE TITLE\"")) { "Expected a YouTube metadata section." }
        check(source.contains("\"TIKTOK\"")) { "Expected a TikTok metadata section." }
        check(source.contains("\"INSTAGRAM\"")) { "Expected an Instagram metadata section." }
        check(source.contains("copyToClipboard(context, copyLabel, body)")) {
            "Expected each metadata section to be copyable via copyToClipboard."
        }
    }

    @Test
    fun `the Instagram section is only shown when instagramCaption is present, matching a render that predates the field`() {
        val source = screenSource()
        val instagramIndex = source.indexOf("meta.instagramCaption?.let")
        check(instagramIndex >= 0) {
            "Expected the Instagram metadata section to be gated on a non-null instagramCaption, same null-tolerant " +
                "pattern as youtubeThumbnailConcept -- never shown for a render created before this field existed."
        }
    }
}
