package com.fillbook.growthos.ui.screens

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import androidx.core.content.FileProvider
import java.io.File
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.CloudSync
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.getSystemService
import com.fillbook.growthos.data.GrowthOsRepository
import com.fillbook.growthos.data.VideoRenderMetadata
import com.fillbook.growthos.data.VideoRenderStatus
import com.fillbook.growthos.data.authErrorMessage
import com.fillbook.growthos.data.extractVideoScriptRequestErrorMessage
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.IconPill
import com.fillbook.growthos.ui.components.PolishedEmptyState
import com.fillbook.growthos.ui.components.PrimaryButton
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.SecondaryButton
import com.fillbook.growthos.ui.components.SkeletonListLoading
import com.fillbook.growthos.ui.components.StatusTone
import com.fillbook.growthos.ui.components.assetStageDisplayName
import com.fillbook.growthos.ui.components.copyToClipboard
import com.fillbook.growthos.ui.components.relativeTime
import com.fillbook.growthos.ui.components.statusToneColor
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.TextPrimary
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary
import com.fillbook.growthos.ui.theme.Warning
import kotlinx.coroutines.launch

/**
 * The durable status view for every video render the owner has ever
 * approved -- queued/rendering/ready/failed/canceled -- independent of
 * whether a push notification about it was ever delivered (a lost push is
 * a convenience miss, never a lost video or a lost "it's ready" fact; see
 * the render-worker's own "Honest limit on exactly-once" note). Download
 * and Share here only ever hand the finished MP4 to Android's own share
 * sheet / Downloads -- this screen never uploads or posts to TikTok,
 * YouTube, or Instagram itself, matching docs/EXTERNAL_WRITE_FIREWALL.md
 * exactly the same way ApprovalsScreen's Copy & Share does for text.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VideoStatusScreen(repo: GrowthOsRepository) {
    var renders by remember { mutableStateOf<List<VideoRenderStatus>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    // videoRenderId -> the local download's content Uri, once this
    // session's download for it has actually completed -- a per-session
    // cache only (never persisted), so re-opening the screen after the
    // app was killed correctly shows "Download" again rather than
    // pretending a stale reference is still good.
    var downloadedUris by remember { mutableStateOf<Map<String, Uri>>(emptyMap()) }
    // videoRenderId -> the system DownloadManager id for an in-flight download, so the completion receiver knows which render it belongs to.
    var pendingDownloads by remember { mutableStateOf<Map<Long, String>>(emptyMap()) }
    // Duplicate-tap guard (2026-09-07 release audit): renderIds with a
    // download currently in flight -- checked before starting a new one and
    // used to disable/show-busy on that render's own Download button, so a
    // rapid double-tap can't enqueue two DownloadManager requests for the
    // same video. Released in every path: enqueue failure (synchronously,
    // right in download()), and both the success and failure branches of
    // the completion broadcast receiver below -- there is no user-facing
    // cancel action in this screen, so "cancellation" here is exactly the
    // same DownloadManager non-success outcome the failure branch already
    // handles.
    var downloadingIds by remember { mutableStateOf<Set<String>>(emptySet()) }

    // "Create Fillbook Video": a fresh video_script request for one of the 30 daily motion concepts. Motion render is the only way
    // to make a video now (owner decision, 2026-10-03), so the custom-topic and Radar-opportunity choices are gone. Two-step
    // flow -- the entry dialog picks the concept, the confirmation dialog is the one place the required real-draft/LLM-budget/
    // no-auto-post/approval-starts-render disclosure lives, separately from the entry step so it can never be skipped by habit.
    var showCreateVideoDialog by remember { mutableStateOf(false) }
    var showVideoConfirmDialog by remember { mutableStateOf(false) }
    // The concepts offered are the backend's fixed daily list (motionCatalog.ts / dailyConcepts.ts), in day order.
    var selectedMotionConceptId by rememberSaveable { mutableStateOf<String?>(null) }
    var motionConcepts by remember { mutableStateOf<List<com.fillbook.growthos.data.MotionConcept>>(emptyList()) }
    var unavailableConcepts by remember { mutableStateOf<List<com.fillbook.growthos.data.UnavailableMotionConcept>>(emptyList()) }
    // The one-a-day rule and which concept is next, from the same call as the list.
    var dailyLimit by remember { mutableStateOf<com.fillbook.growthos.data.DailyRequestLimit?>(null) }
    var nextConceptId by remember { mutableStateOf<String?>(null) }
    var loadingMotionConcepts by remember { mutableStateOf(false) }
    // Doubles as both the busy/spinner state AND the duplicate-tap guard --
    // a rapid double-tap on Confirm can't fire two requests since the
    // button is disabled the instant the first tap sets this true.
    var creatingVideoScript by remember { mutableStateOf(false) }
    var createVideoResultMessage by remember { mutableStateOf<String?>(null) }

    // Today's posting plan (Posting.kt). Loaded alongside the renders but separately: if it fails (e.g. migration 0043
    // not applied yet) the card just doesn't show, and the render list still works.
    var postingPlan by remember { mutableStateOf<com.fillbook.growthos.data.PostingPlan?>(null) }
    var linkTarget by remember { mutableStateOf<Pair<com.fillbook.growthos.data.PlanVideo, com.fillbook.growthos.data.PostingPlatform>?>(null) }
    var savingLink by remember { mutableStateOf(false) }

    suspend fun refresh() {
        try {
            renders = repo.getVideoRenderStatuses()
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = authErrorMessage(e) ?: "Couldn't load video status. Check your connection and try again."
        }
        postingPlan = try {
            repo.getPostingOverview().plan
        } catch (e: Exception) {
            null
        }
        loaded = true
    }

    LaunchedEffect(Unit) { refresh() }

    // Registered once for the screen's lifetime -- DownloadManager posts
    // this broadcast for EVERY completed download system-wide (not just
    // this app's), so pendingDownloads is what filters it down to ones
    // this screen actually started.
    DisposableEffect(Unit) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
                val videoRenderId = pendingDownloads[id] ?: return
                // Released before anything below can return early. A download canceled from its notification has its
                // row deleted before this broadcast arrives, so the lookup finds nothing -- and returning there used
                // to leave the Download button disabled until the screen was reopened.
                pendingDownloads = pendingDownloads - id
                downloadingIds = downloadingIds - videoRenderId
                val downloadManager = context.getSystemService<DownloadManager>() ?: return
                val query = DownloadManager.Query().setFilterById(id)
                downloadManager.query(query).use { cursor ->
                    if (!cursor.moveToFirst()) {
                        scope.launch { snackbarHostState.showSnackbar("Download canceled.") }
                        return@use
                    }
                    val statusIndex = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS)
                    val status = if (statusIndex >= 0) cursor.getInt(statusIndex) else DownloadManager.STATUS_FAILED
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        val localUriIndex = cursor.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI)
                        val localUriStr = if (localUriIndex >= 0) cursor.getString(localUriIndex) else null
                        val shareUri: Uri? = localUriStr?.let {
                            runCatching {
                                val file = File(Uri.parse(it).path!!)
                                FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
                            }.getOrNull()
                        }
                        if (shareUri != null) {
                            downloadedUris = downloadedUris + (videoRenderId to shareUri)
                            scope.launch { snackbarHostState.showSnackbar("Downloaded — tap Share to send it") }
                        } else {
                            scope.launch { snackbarHostState.showSnackbar("Download saved but couldn't prepare share link.") }
                        }
                    } else {
                        // Most likely cause for THIS feature specifically: the
                        // signed URL's ~1h expiry passed between fetching status
                        // and the download actually running -- pulling to
                        // refresh mints a fresh one (see videoStatusHandlers.ts).
                        // Also where a user-cancelled download lands (DownloadManager
                        // reports cancellation as a non-successful status, same as
                        // any other failure) -- the guard was already released above.
                        scope.launch { snackbarHostState.showSnackbar("Download failed — the link may have expired. Pull to refresh and try again.") }
                    }
                }
            }
        }
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        // MUST be RECEIVER_EXPORTED, not RECEIVER_NOT_EXPORTED -- this
        // broadcast comes from the separate Download Manager provider app,
        // not from this app's own process. On API 33+, NOT_EXPORTED
        // silently drops broadcasts from any sender outside this app (only
        // "the system" itself or same-signing-cert apps get through, and
        // the Download Manager provider is neither), which is exactly why
        // downloads previously spun forever and Share never enabled: the
        // completion broadcast was never actually delivered to this
        // receiver. The onReceive body above only acts on download ids
        // already present in our own pendingDownloads map, so exporting
        // this receiver doesn't meaningfully widen what another app could
        // trigger.
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
        onDispose { context.unregisterReceiver(receiver) }
    }

    fun download(render: VideoRenderStatus) {
        // Defensive: the button itself is already disabled while this
        // render's id is in downloadingIds, but a second tap can still land
        // in the same frame before recomposition disables it.
        if (render.id in downloadingIds) return
        val url = render.downloadUrl
        if (url == null) {
            scope.launch { snackbarHostState.showSnackbar("No download link yet — pull to refresh.") }
            return
        }
        val downloadManager = context.getSystemService<DownloadManager>()
        if (downloadManager == null) {
            scope.launch { snackbarHostState.showSnackbar("Downloads aren't available on this device.") }
            return
        }
        downloadingIds = downloadingIds + render.id
        val fileName = "fillbook-video-${render.id}.mp4"
        val request = DownloadManager.Request(Uri.parse(url))
            .setTitle(fileName)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            .setMimeType("video/mp4")
        val id = runCatching { downloadManager.enqueue(request) }.getOrNull()
        if (id == null) {
            // Enqueue itself failed (or threw) -- release the guard right
            // here since no broadcast will ever arrive for a download that
            // never started.
            downloadingIds = downloadingIds - render.id
            scope.launch { snackbarHostState.showSnackbar("Couldn't start the download. Check your connection and try again.") }
            return
        }
        pendingDownloads = pendingDownloads + (id to render.id)
        scope.launch { snackbarHostState.showSnackbar("Downloading…") }
    }

    fun share(render: VideoRenderStatus) {
        val uri = downloadedUris[render.id]
        if (uri == null) {
            scope.launch { snackbarHostState.showSnackbar("Download it first, then Share.") }
            return
        }
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "video/mp4"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            // Attach the TikTok caption so it's at least on the share sheet's
            // clipboard/text payload -- previously this intent carried only
            // the video file, so the caption always had to be copied from
            // this screen's own TIKTOK section and pasted by hand.
            render.videoMetadata?.let { meta -> putExtra(Intent.EXTRA_TEXT, buildTiktokShareText(meta)) }
        }
        // A generic chooser (not a package-targeted intent) needs no
        // <queries> manifest declaration to see installed apps like TikTok
        // or YouTube -- that visibility restriction only applies to intents
        // naming a specific target package.
        val chooser = Intent.createChooser(shareIntent, "Share video")
        // YouTube fills its upload TITLE from EXTRA_TEXT, so the TikTok
        // caption (hashtags and all) became the Shorts title. When the owner
        // picks YouTube, the chooser swaps in the plain YouTube title instead.
        render.videoMetadata?.let { meta ->
            val youtubeExtras = Bundle().apply { putString(Intent.EXTRA_TEXT, buildYoutubeShareText(meta)) }
            chooser.putExtra(Intent.EXTRA_REPLACEMENT_EXTRAS, Bundle().apply { putBundle(YOUTUBE_PACKAGE, youtubeExtras) })
        }
        context.startActivity(chooser)

        // ACTION_SEND is fire-and-forget: Android gives the sender no result
        // and no way to ask what the receiving app did with EXTRA_TEXT, so
        // there's no way to detect "TikTok ignored the caption" after the
        // fact -- not every app prefills its caption field from EXTRA_TEXT
        // for a media share, and some silently drop it. Instead of pretending
        // to detect that, this copies the caption to the clipboard as a
        // guaranteed fallback and tells the owner so up front, every time.
        render.videoMetadata?.let { meta ->
            copyToClipboard(context, "TikTok caption", buildTiktokShareText(meta))
            scope.launch {
                snackbarHostState.showSnackbar("Caption copied — paste it if it doesn't fill in automatically.")
            }
        }
    }

    // Simpler, one-shot fire-and-forget than download()/share() above: the
    // thumbnail is a small JPG the owner picks up from the system Downloads
    // folder to attach in YouTube Studio's own thumbnail upload picker, so
    // there is no in-app Share step to gate behind a completion broadcast --
    // just get it into Downloads and tell them it's there.
    fun downloadThumbnail(render: VideoRenderStatus) {
        val url = render.thumbnailDownloadUrl
        if (url == null) {
            scope.launch { snackbarHostState.showSnackbar("No thumbnail available for this video.") }
            return
        }
        val downloadManager = context.getSystemService<DownloadManager>()
        if (downloadManager == null) {
            scope.launch { snackbarHostState.showSnackbar("Downloads aren't available on this device.") }
            return
        }
        val fileName = "fillbook-thumbnail-${render.id}.jpg"
        val request = DownloadManager.Request(Uri.parse(url))
            .setTitle(fileName)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            .setMimeType("image/jpeg")
        val id = runCatching { downloadManager.enqueue(request) }.getOrNull()
        scope.launch {
            snackbarHostState.showSnackbar(
                if (id != null) "Downloading thumbnail…" else "Couldn't start the thumbnail download.",
            )
        }
    }

    fun dismiss(render: VideoRenderStatus) {
        scope.launch {
            try {
                repo.dismissVideoRender(render.id)
                renders = renders.filter { it.id != render.id }
            } catch (e: Exception) {
                snackbarHostState.showSnackbar("Couldn't dismiss — try again.")
            }
        }
    }


    fun loadMotionConcepts() {
        scope.launch {
            loadingMotionConcepts = true
            try {
                val catalog = repo.getMotionConceptCatalog()
                motionConcepts = catalog.concepts
                unavailableConcepts = catalog.unavailable
                dailyLimit = catalog.dailyLimit
                nextConceptId = catalog.nextConceptId
            } catch (e: Exception) {
                motionConcepts = emptyList()
                unavailableConcepts = emptyList()
                dailyLimit = null
                nextConceptId = null
            }
            loadingMotionConcepts = false
        }
    }

    fun requestVideoScript() {
        // Duplicate-tap guard: the Confirm button is also disabled while
        // this is true, but a second tap can still land in the same frame
        // before recomposition disables it.
        if (creatingVideoScript) return
        val motionConceptId = selectedMotionConceptId ?: return
        scope.launch {
            creatingVideoScript = true
            try {
                val result = repo.requestVideoScript(motionConceptId)
                createVideoResultMessage = if (result.finalStage == "ready_for_owner") {
                    "Video script sent to Approvals for your review."
                } else {
                    "Didn't clear review (${assetStageDisplayName(result.finalStage)})" +
                        if (result.blockReasons.isNotEmpty()) ": ${result.blockReasons.joinToString("; ")}" else "."
                }
                showVideoConfirmDialog = false
                showCreateVideoDialog = false
                // A concept is used up once requested (owner rule 2026-09-25): drop it now, and the next open reloads
                // the list from the server, which also leaves out anything queued, waiting, made or rejected.
                motionConcepts = motionConcepts.filterNot { it.id == motionConceptId }
                selectedMotionConceptId = null
                refresh()
            } catch (e: com.fillbook.growthos.data.NetworkException) {
                createVideoResultMessage = extractVideoScriptRequestErrorMessage(e.httpCode, e.message)
                    ?: authErrorMessage(e)
                    ?: "Couldn't create the video script. Check your connection and try again."
                showVideoConfirmDialog = false
                showCreateVideoDialog = false
            } catch (e: Exception) {
                createVideoResultMessage = "Couldn't create the video script. Check your connection and try again."
                showVideoConfirmDialog = false
                showCreateVideoDialog = false
            }
            creatingVideoScript = false
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            ScreenHeader(
                "Video Status",
                "Approve a video script and it renders here — download it, then share it to TikTok, YouTube, or Instagram Reels yourself.",
                kicker = if (loaded && renders.isNotEmpty()) "${renders.size} render${if (renders.size == 1) "" else "s"}" else null,
            )

            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp)) {
                SecondaryButton(
                    text = "+ Create Fillbook Video",
                    onClick = {
                        selectedMotionConceptId = null
                        // Always fetch a fresh concept list: the server hides concepts used since the last load.
                        motionConcepts = emptyList()
                        showCreateVideoDialog = true
                        loadMotionConcepts()
                    },
                )
            }

            errorMessage?.let { message ->
                Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(message, style = MaterialTheme.typography.bodyMedium, color = Danger, modifier = Modifier.weight(1f))
                    TextButton(onClick = { scope.launch { refresh() } }) { Text("Retry") }
                }
            }

            createVideoResultMessage?.let { message ->
                // A rejected request's message is every reviewer's full
                // objection joined together (see requestVideoScript() above)
                // -- often several hundred words, unlike the one-line success
                // message. Sitting in this fixed header (outside the
                // LazyColumn below) with no height cap or scroll of its own,
                // it used to just keep growing and push the entire rest of
                // the screen -- including the render list and pull-to-refresh
                // area -- off the bottom, with nothing on the page able to
                // scroll far enough to read the rest of it. Capped height +
                // its own vertical scroll keeps this banner readable without
                // hiding whatever's below it.
                Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        message,
                        style = MaterialTheme.typography.bodyMedium,
                        color = TextSecondary,
                        modifier = Modifier.weight(1f).heightIn(max = 240.dp).verticalScroll(rememberScrollState()),
                    )
                    TextButton(onClick = { createVideoResultMessage = null }) { Text("Dismiss") }
                }
            }

            if (!loaded) {
                SkeletonListLoading()
            } else {
                // Same nested-scroll fix as ProspectingScreen (2026-09-07):
                // PullToRefreshBox only detects the pull gesture through a
                // scrollable descendant's nested-scroll connection. The
                // empty state used to sit entirely outside PullToRefreshBox
                // (and even wrapped, a bare PolishedEmptyState -- a plain,
                // non-scrollable Column -- would never dispatch drag deltas
                // to it anyway). Fix: PullToRefreshBox now wraps both
                // branches, and the empty branch uses a LazyColumn (the same
                // genuine nested-scroll participant the populated branch
                // already uses) instead of a bare Column.
                PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    if (errorMessage == null && renders.isEmpty()) {
                        LazyColumn(modifier = Modifier.fillMaxSize()) {
                            item {
                                PolishedEmptyState(
                                    icon = Icons.Filled.Movie,
                                    headline = "No videos yet",
                                    subtitle = "Approve a video script draft in Approvals and it'll start rendering here.",
                                )
                            }
                        }
                    } else {
                        LazyColumn(
                            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            postingPlan?.let { plan ->
                                item(key = "posting-plan") {
                                    PostingPlanCard(plan = plan, onAddLink = { video, platform -> linkTarget = video to platform })
                                }
                            }
                            items(renders, key = { it.id }) { render ->
                                VideoRenderCard(
                                    render = render,
                                    alreadyDownloaded = downloadedUris.containsKey(render.id),
                                    downloading = render.id in downloadingIds,
                                    onDownload = { download(render) },
                                    onShare = { share(render) },
                                    onDownloadThumbnail = { downloadThumbnail(render) },
                                    onDismiss = { dismiss(render) },
                                )
                            }
                        }
                    }
                }
            }
        }
        SnackbarHost(hostState = snackbarHostState, modifier = Modifier.align(Alignment.BottomCenter))
    }

    linkTarget?.let { (video, platform) ->
        AddPostLinkDialog(
            video = video,
            platform = platform,
            saving = savingLink,
            onSave = { url ->
                scope.launch {
                    savingLink = true
                    try {
                        repo.recordVideoPost(video.campaignAssetId, video.videoRenderId, platform, url)
                        linkTarget = null
                        refresh()
                        snackbarHostState.showSnackbar("${platform.label} link saved.")
                    } catch (e: Exception) {
                        snackbarHostState.showSnackbar(e.message?.takeIf { it.isNotBlank() } ?: "Couldn't save the link. Try again.")
                    }
                    savingLink = false
                }
            },
            onDismiss = { if (!savingLink) linkTarget = null },
        )
    }

    if (showCreateVideoDialog) {
        val requestedToday = dailyLimit?.requestedToday
        AlertDialog(
            onDismissRequest = { showCreateVideoDialog = false },
            title = { Text("Create Fillbook Video") },
            text = {
                Column {
                    Text("Motion render", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        "Uses a REAL recorded Fillbook product interaction, not stock footage. One new video can be requested per day.",
                        style = MaterialTheme.typography.labelMedium,
                        color = TextTertiary,
                        modifier = Modifier.padding(top = 2.dp, bottom = 8.dp),
                    )
                    if (requestedToday != null) {
                        Text(
                            dailyLimitMessage(requestedToday, dailyLimit?.nextRequestAt),
                            style = MaterialTheme.typography.bodySmall,
                            color = Warning,
                            modifier = Modifier.padding(bottom = 8.dp),
                        )
                    }
                    if (loadingMotionConcepts) {
                        CircularProgressIndicator(modifier = Modifier.height(18.dp))
                    } else if (motionConcepts.isEmpty() && unavailableConcepts.isEmpty()) {
                        Text("No motion concepts available right now.", style = MaterialTheme.typography.bodySmall, color = TextTertiary)
                    } else {
                        LazyColumn(modifier = Modifier.fillMaxWidth().height(320.dp)) {
                            items(motionConcepts, key = { it.id }) { concept ->
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    RadioButton(
                                        selected = selectedMotionConceptId == concept.id,
                                        onClick = { selectedMotionConceptId = concept.id },
                                        enabled = requestedToday == null,
                                    )
                                    Column {
                                        Text(conceptLabel(concept.day, concept.title), style = MaterialTheme.typography.bodySmall)
                                        Text(concept.topic, style = MaterialTheme.typography.labelSmall, color = TextTertiary)
                                        if (concept.id == nextConceptId) {
                                            Text("Next in order", style = MaterialTheme.typography.labelSmall, color = Accent)
                                        }
                                    }
                                }
                            }
                            items(unavailableConcepts, key = { "used-" + it.id }) { concept ->
                                Column(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp, horizontal = 12.dp)) {
                                    Text(conceptLabel(concept.day, concept.title), style = MaterialTheme.typography.bodySmall, color = TextTertiary)
                                    Text(unavailableStateLabel(concept.state), style = MaterialTheme.typography.labelSmall, color = TextTertiary)
                                }
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = { showCreateVideoDialog = false; showVideoConfirmDialog = true },
                    enabled = selectedMotionConceptId != null && requestedToday == null,
                ) { Text("Continue") }
            },
            dismissButton = {
                TextButton(onClick = { showCreateVideoDialog = false }) { Text("Cancel") }
            },
        )
    }

    if (showVideoConfirmDialog) {
        val topicSummary = motionConcepts.firstOrNull { it.id == selectedMotionConceptId }?.title ?: "the selected motion concept"
        AlertDialog(
            onDismissRequest = { if (!creatingVideoScript) showVideoConfirmDialog = false },
            title = { Text("Create a real video draft?") },
            text = {
                Column {
                    Text(
                        "This uses paid LLM/render budget and creates a REAL video draft for $topicSummary.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text("• It will use a REAL recorded Fillbook product interaction, not stock footage.", style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                    Text("• It will render on the video worker once approved.", style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                    Text("• It will NOT post anywhere automatically.", style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                    Text("• It lands in Approvals first -- approving it there is what starts the render.", style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                }
            },
            confirmButton = {
                TextButton(onClick = { requestVideoScript() }, enabled = !creatingVideoScript) {
                    Text(if (creatingVideoScript) "Creating…" else "Create")
                }
            },
            dismissButton = {
                TextButton(onClick = { showVideoConfirmDialog = false }, enabled = !creatingVideoScript) { Text("Cancel") }
            },
        )
    }
}

/** "Day 5 · title" for a concept in the daily order, or just the title for one outside it. */
internal fun conceptLabel(day: Int?, title: String): String = if (day != null) "Day $day · $title" else title

/** What a used-up concept is doing, in the owner's words. */
internal fun unavailableStateLabel(state: String): String = when (state) {
    "made" -> "Already made"
    "waiting" -> "Waiting in Approvals"
    "rejected" -> "Rejected"
    else -> "Not available"
}

/** The one-a-day message: today's concept, and when the next request opens (US Eastern, the zone the limit uses). */
internal fun dailyLimitMessage(requestedToday: String, nextRequestAt: String?): String {
    val opens = nextRequestAt?.let {
        runCatching {
            java.time.format.DateTimeFormatter.ofPattern("EEE h:mm a", java.util.Locale.US)
                .withZone(java.time.ZoneId.of("America/New_York"))
                .format(java.time.Instant.parse(it))
        }.getOrNull()
    }
    return "Today's video is already requested: \"$requestedToday\"." + if (opens != null) " The next request opens $opens Eastern." else ""
}

/** The exact TikTok caption text this screen's own TIKTOK section shows/copies -- reused as the share intent's EXTRA_TEXT so both paths always agree. */
internal fun buildTiktokShareText(meta: VideoRenderMetadata): String =
    listOfNotNull(
        meta.tiktokCaption,
        meta.hashtags.takeIf { it.isNotEmpty() }?.joinToString(" ") { "#$it" },
        meta.disclosureCta,
    ).joinToString("\n")

internal const val YOUTUBE_PACKAGE = "com.google.android.youtube"

/** What the share sheet hands YouTube, which uses it as the video title: the YouTube title alone, never hashtags. */
internal fun buildYoutubeShareText(meta: VideoRenderMetadata): String =
    meta.youtubeTitle.replace(Regex("""\s*#[\p{L}\p{N}_]+"""), "").trim()

internal fun statusTone(status: String): StatusTone = when (status) {
    "ready" -> StatusTone.READY
    "rendering", "queued" -> StatusTone.WAITING
    "failed" -> StatusTone.FAILED
    "canceled" -> StatusTone.SKIPPED
    else -> StatusTone.NEUTRAL
}

internal fun statusLabel(status: String): String = when (status) {
    "queued" -> "Queued"
    "rendering" -> "Rendering"
    "ready" -> "Ready"
    "failed" -> "Failed"
    "canceled" -> "Canceled"
    else -> status.replaceFirstChar { it.uppercase() }
}

@Composable
private fun VideoRenderCard(
    render: VideoRenderStatus,
    alreadyDownloaded: Boolean,
    downloading: Boolean,
    onDownload: () -> Unit,
    onShare: () -> Unit,
    onDownloadThumbnail: () -> Unit,
    onDismiss: (() -> Unit)? = null,
) {
    val tone = statusTone(render.status)
    GrowthCard(accentBar = statusToneColor(tone)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val icon = when (render.status) {
                "ready" -> Icons.Filled.CloudDone
                "rendering" -> Icons.Filled.CloudSync
                "queued" -> Icons.Filled.HourglassEmpty
                "failed" -> Icons.Filled.ErrorOutline
                else -> Icons.Filled.Movie
            }
            IconPill(statusLabel(render.status), icon, statusToneColor(tone))
            Spacer(Modifier.width(8.dp))
            if (render.status == "rendering") {
                CircularProgressIndicator(modifier = Modifier.height(14.dp).width(14.dp), strokeWidth = 2.dp, color = statusToneColor(tone))
            }
            Spacer(Modifier.weight(1f))
            relativeTime(render.updatedAt)?.let { time ->
                Text(time, style = MaterialTheme.typography.labelMedium, color = TextTertiary)
            }
            if (onDismiss != null) {
                Spacer(Modifier.width(8.dp))
                androidx.compose.material3.IconButton(onClick = onDismiss, modifier = Modifier.height(24.dp).width(24.dp)) {
                    androidx.compose.material3.Icon(Icons.Filled.Close, contentDescription = "Dismiss", tint = TextTertiary, modifier = Modifier.height(16.dp).width(16.dp))
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        render.durationSeconds?.let { seconds ->
            Text("${seconds.toInt()}s video", style = MaterialTheme.typography.bodyMedium, color = TextPrimary)
            Spacer(Modifier.height(6.dp))
        }
        render.error?.let { error ->
            Text(error, style = MaterialTheme.typography.bodySmall, color = Danger, maxLines = 4)
            Spacer(Modifier.height(6.dp))
        }
        if (render.status == "queued" || render.status == "rendering") {
            Text(
                "This can take a minute or two — pull to refresh, or wait for the notification.",
                style = MaterialTheme.typography.bodySmall,
                color = TextSecondary,
            )
        }
        render.videoMetadata?.let { meta ->
            Spacer(Modifier.height(10.dp))
            VideoMetadataSection(
                label = "YOUTUBE TITLE",
                copyLabel = "YouTube title",
                body = meta.youtubeTitle,
            )
            Spacer(Modifier.height(8.dp))
            VideoMetadataSection(
                label = "YOUTUBE DESCRIPTION",
                copyLabel = "YouTube description",
                body = listOfNotNull(
                    meta.youtubeDescription,
                    meta.hashtags.takeIf { it.isNotEmpty() }?.joinToString(" ") { "#$it" },
                    meta.disclosureCta,
                ).joinToString("\n"),
            )
            meta.youtubeThumbnailConcept?.let { concept ->
                Spacer(Modifier.height(8.dp))
                VideoMetadataSection(
                    label = "YOUTUBE THUMBNAIL CONCEPT",
                    copyLabel = "YouTube thumbnail concept",
                    body = concept,
                )
            }
            Spacer(Modifier.height(8.dp))
            VideoMetadataSection(
                label = "TIKTOK",
                copyLabel = "TikTok metadata",
                body = buildTiktokShareText(meta),
            )
            meta.pinnedComment?.let { comment ->
                Spacer(Modifier.height(8.dp))
                VideoMetadataSection(
                    label = "PINNED COMMENT (TIKTOK + YOUTUBE)",
                    copyLabel = "Pinned comment",
                    body = comment,
                )
                Text(
                    "After you post, paste this as a comment on the video, then pin it.",
                    style = MaterialTheme.typography.labelMedium,
                    color = TextTertiary,
                )
            }
            meta.instagramCaption?.let { caption ->
                Spacer(Modifier.height(8.dp))
                VideoMetadataSection(
                    label = "INSTAGRAM",
                    copyLabel = "Instagram metadata",
                    body = listOfNotNull(
                        caption,
                        meta.hashtags.takeIf { it.isNotEmpty() }?.joinToString(" ") { "#$it" },
                        meta.disclosureCta,
                    ).joinToString("\n"),
                )
            }
        }
        if (render.status == "ready") {
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PrimaryButton(text = "Download", onClick = onDownload, enabled = !downloading, busy = downloading, modifier = Modifier.weight(1f))
                SecondaryButton(text = "Share", onClick = onShare, enabled = alreadyDownloaded)
            }
            if (!alreadyDownloaded) {
                Spacer(Modifier.height(4.dp))
                Text("Download it first, then Share to TikTok, YouTube, or Instagram Reels.", style = MaterialTheme.typography.labelMedium, color = TextTertiary)
            }
            if (render.thumbnailDownloadUrl != null) {
                Spacer(Modifier.height(8.dp))
                SecondaryButton(text = "Download Thumbnail", onClick = onDownloadThumbnail, modifier = Modifier.fillMaxWidth())
            }
            // Post links are added per platform in the posting plan above; the single "I posted this" field that
            // used to sit here was removed 2026-09-26 (recordVideoPost now feeds everything it fed).
        }
    }
}

/**
 * A copyable metadata block ("Create Fillbook Video", 2026-09-08) -- the
 * owner pastes this straight into TikTok's/YouTube's/Instagram's own
 * upload flow when they manually publish, since this app never uploads to
 * any of those platforms itself (see docs/EXTERNAL_WRITE_FIREWALL.md).
 */
@Composable
private fun VideoMetadataSection(label: String, copyLabel: String, body: String) {
    val context = LocalContext.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(com.fillbook.growthos.ui.theme.Background, androidx.compose.foundation.shape.RoundedCornerShape(10.dp))
            .padding(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = TextTertiary, modifier = Modifier.weight(1f))
            TextButton(
                onClick = { copyToClipboard(context, copyLabel, body) },
                contentPadding = PaddingValues(0.dp),
            ) { Text("Copy", style = MaterialTheme.typography.labelMedium, color = Accent) }
        }
        Spacer(Modifier.height(4.dp))
        Text(body, style = MaterialTheme.typography.bodySmall, color = TextPrimary)
    }
}
