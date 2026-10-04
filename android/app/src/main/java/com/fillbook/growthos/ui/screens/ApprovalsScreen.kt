package com.fillbook.growthos.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.fillbook.growthos.data.ApprovalAsset
import com.fillbook.growthos.data.GrowthOsRepository
import com.fillbook.growthos.data.VideoRenderOutcome
import com.fillbook.growthos.data.authErrorMessage
import com.fillbook.growthos.ui.components.CopyButton
import com.fillbook.growthos.ui.components.ExpandableText
import com.fillbook.growthos.ui.components.GhostButton
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.IconPill
import com.fillbook.growthos.ui.components.InsetRow
import com.fillbook.growthos.ui.components.Pill
import com.fillbook.growthos.ui.components.PolishedEmptyState
import com.fillbook.growthos.ui.components.PrimaryButton
import com.fillbook.growthos.ui.components.ScoreBadge
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.SearchField
import com.fillbook.growthos.ui.components.SecondaryButton
import com.fillbook.growthos.ui.components.SkeletonListLoading
import com.fillbook.growthos.ui.components.StatusTone
import com.fillbook.growthos.ui.components.assetTypeDisplayName
import com.fillbook.growthos.ui.components.assetTypeIcon
import com.fillbook.growthos.ui.components.platformDisplayName
import com.fillbook.growthos.ui.components.platformIcon
import com.fillbook.growthos.ui.components.relativeTime
import com.fillbook.growthos.ui.components.reviewSummaryLabel
import com.fillbook.growthos.ui.components.statusToneColor
import com.fillbook.growthos.ui.theme.Warning
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.KpiNumberStyleSmall
import com.fillbook.growthos.ui.theme.Success
import com.fillbook.growthos.ui.theme.TextPrimary
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary
import kotlinx.coroutines.launch

/**
 * A decision screen, not a report: the review score is the first thing
 * you see on every card, the two decisions (approve/reject) sit at the
 * bottom where a thumb already is, and everything else (auto-draft
 * badge, cost, timestamp) is secondary metadata below the content. This
 * screen must never contain a button labeled "Publish", "Post", "Send",
 * or similar -- every action either stays internal (Approve, Reject) or
 * copies the draft and hands it to whatever app the owner picks to
 * finish and press post themselves (see docs/EXTERNAL_WRITE_FIREWALL.md).
 * Approve/Reject only change what this app displays (campaigns.status
 * server-side) -- neither one ever contacts X, YouTube, or any other
 * external platform.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ApprovalsScreen(repo: GrowthOsRepository) {
    var assets by remember { mutableStateOf<List<ApprovalAsset>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var pendingReject by remember { mutableStateOf<ApprovalAsset?>(null) }
    var rejectReason by remember { mutableStateOf<String?>(null) }
    var pendingRenderConfirm by remember { mutableStateOf<ApprovalAsset?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    // Guards against a fast double-tap firing decideApproval twice for the
    // same asset before the first call's refresh() completes -- every other
    // screen with an in-flight mutating action (Inbound, Prospecting,
    // Notifications, Partnerships) already disables its action buttons this
    // same way; this screen had been the one exception, including for the
    // video-render-triggering approve path specifically.
    var busyId by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    suspend fun refresh() {
        try {
            assets = repo.getApprovals()
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = authErrorMessage(e) ?: "Couldn't load approvals. Check your connection and try again."
        }
        loaded = true
    }

    LaunchedEffect(Unit) { refresh() }

    val filtered = remember(assets, query) {
        if (query.isBlank()) assets
        else assets.filter { it.campaignTitle.contains(query, ignoreCase = true) || it.previewText.contains(query, ignoreCase = true) }
    }

    fun decide(asset: ApprovalAsset, approve: Boolean, reason: String? = null) {
        if (busyId == asset.id) return
        scope.launch {
            busyId = asset.id
            try {
                val renderOutcome = repo.decideApproval(asset.id, approve, reason)
                actionError = null
                refresh()
                snackbarHostState.showSnackbar(
                    message = approvalSnackbarMessage(approve, renderOutcome),
                    // A refused render needs reading, not a two-second flash.
                    duration = if (renderOutcome != null && !renderOutcome.queued) SnackbarDuration.Long else SnackbarDuration.Short,
                )
            } catch (e: Exception) {
                actionError = "Couldn't record that decision. Check your connection and try again."
            } finally {
                busyId = null
            }
        }
    }

    /**
     * Universal, platform-agnostic handoff: copies the draft to the
     * clipboard and opens Android's own share sheet so the owner can pick
     * literally any installed app -- X, YouTube Studio, TikTok, a blog
     * CMS, or anything else -- instead of this app trying to maintain a
     * pre-fill URL scheme per platform (which only ever worked for X).
     * Paste is still the owner's action; nothing here ever posts on its
     * own.
     */
    fun copyAndShare(asset: ApprovalAsset) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Draft", asset.previewText))
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, asset.previewText)
        }
        context.startActivity(Intent.createChooser(shareIntent, "Post to ${platformDisplayName(asset.platform)}"))
        scope.launch { snackbarHostState.showSnackbar("Copied to clipboard") }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            ScreenHeader(
                "Approvals",
                "You always press publish — this app only ever hands off a draft.",
                kicker = if (loaded && assets.isNotEmpty()) "${assets.size} waiting on you" else null,
            )

            (errorMessage ?: actionError)?.let { message ->
                Row(modifier = Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(message, style = MaterialTheme.typography.bodyMedium, color = Danger, modifier = Modifier.weight(1f))
                    if (errorMessage != null) {
                        TextButton(onClick = { scope.launch { refresh() } }) { Text("Retry") }
                    }
                }
            }

            if (!loaded) {
                SkeletonListLoading()
            } else if (errorMessage == null && assets.isEmpty()) {
                // Same nested-scroll fix as Prospecting/Inbound/VideoStatus
                // (2026-09-07): PullToRefreshBox only detects the pull gesture
                // through a scrollable descendant's nested-scroll connection --
                // a bare PolishedEmptyState never dispatched drag deltas to it.
                PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        item {
                            PolishedEmptyState(
                                icon = Icons.Filled.CheckCircle,
                                headline = "Nothing waiting on you",
                                subtitle = "Drafts land here once the Campaign Factory finishes AI review.",
                            )
                        }
                    }
                }
            } else {
                SearchField(query, { query = it }, "Search drafts", modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    LazyColumn(
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        // "No matches" state for a search that returns zero
                        // results (2026-09-07 release audit finding) --
                        // previously this silently rendered an empty list
                        // with no indication the search itself was the reason.
                        if (filtered.isEmpty()) {
                            item {
                                PolishedEmptyState(
                                    icon = Icons.Filled.CheckCircle,
                                    headline = "No matches",
                                    subtitle = "No drafts match \"$query\".",
                                )
                            }
                        }
                        items(filtered, key = { it.id }) { asset ->
                            ApprovalCard(
                                asset = asset,
                                busy = busyId == asset.id,
                                onApprove = {
                                    // Approving a video_script asset triggers a REAL server-side
                                    // render (see enqueue_video_render in approvals.ts) -- unlike
                                    // every other asset type, this isn't reversible from here once
                                    // it starts, so it gets its own explicit confirmation instead
                                    // of firing immediately like a plain text-post approval does.
                                    if (asset.assetType == "video_script") pendingRenderConfirm = asset
                                    else decide(asset, approve = true)
                                },
                                onReject = { pendingReject = asset },
                                onCopyAndShare = { copyAndShare(asset) },
                            )
                        }
                    }
                }
            }
        }
        SnackbarHost(hostState = snackbarHostState, modifier = Modifier.align(Alignment.BottomCenter))
    }

    pendingReject?.let { asset ->
        AlertDialog(
            onDismissRequest = { pendingReject = null },
            title = { Text("Reject this draft?") },
            text = {
                Column {
                    Text("\"${asset.campaignTitle}\" will be retired. This can't be undone from here.")
                    Spacer(Modifier.height(8.dp))
                    Text("Why? (optional)", style = MaterialTheme.typography.labelMedium, color = TextTertiary)
                    REJECT_REASONS.forEach { option ->
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                            RadioButton(selected = rejectReason == option, onClick = { rejectReason = if (rejectReason == option) null else option })
                            Text(option, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { decide(asset, approve = false, reason = rejectReason); pendingReject = null; rejectReason = null }) { Text("Reject") }
            },
            dismissButton = {
                TextButton(onClick = { pendingReject = null }) { Text("Cancel") }
            },
        )
    }

    pendingRenderConfirm?.let { asset ->
        AlertDialog(
            onDismissRequest = { pendingRenderConfirm = null },
            title = { Text("Render this video?") },
            text = {
                Text(
                    "\"${asset.campaignTitle}\" will queue on the render server now, unless today's render limit (3, " +
                        "which leaves room to retry a failed render) is already used (then it waits and renders automatically after the midnight reset). " +
                        "Once it renders you'll get a notification and can download it from Video Status. " +
                        "This never posts anywhere on its own; you still choose to share it yourself.",
                )
            },
            confirmButton = {
                TextButton(onClick = { decide(asset, approve = true); pendingRenderConfirm = null }) { Text("Render video") }
            },
            dismissButton = {
                TextButton(onClick = { pendingRenderConfirm = null }) { Text("Cancel") }
            },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ApprovalCard(
    asset: ApprovalAsset,
    busy: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    onCopyAndShare: () -> Unit,
) {
    val total = asset.reviewPassCount + asset.reviewFailCount
    val flagged = asset.reviewFailCount > 0
    GrowthCard(accentBar = if (total > 0) (if (flagged) Warning else Success) else null) {
        Row(verticalAlignment = Alignment.Top) {
            if (total > 0) {
                ScoreBadge(
                    score = (asset.reviewPassCount * 100) / total,
                    colorOverride = if (flagged) Warning else null,
                    semanticLabel = "Review score ${(asset.reviewPassCount * 100) / total}, ${if (flagged) "flagged" else "passed review"}",
                )
                Spacer(Modifier.width(12.dp))
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(asset.campaignTitle, style = MaterialTheme.typography.titleLarge, maxLines = 3, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                Spacer(Modifier.height(6.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    IconPill(platformDisplayName(asset.platform), platformIcon(asset.platform), TextSecondary)
                    IconPill(assetTypeDisplayName(asset.assetType), assetTypeIcon(asset.assetType), TextSecondary)
                    if (asset.isAutoDraft) Pill("AUTO-DRAFT", statusToneColor(StatusTone.NEW))
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        ExpandableText(asset.previewText, style = MaterialTheme.typography.bodyMedium, color = TextPrimary, collapsedMaxLines = 4)
        Spacer(Modifier.height(10.dp))
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            if (total > 0) {
                Text(reviewSummaryLabel(asset.reviewPassCount, total), style = MaterialTheme.typography.labelMedium, color = if (flagged) Warning else TextTertiary)
            } else {
                Spacer(Modifier.width(1.dp))
            }
            relativeTime(asset.generatedAt)?.let { time ->
                Text(time, style = MaterialTheme.typography.labelMedium, color = TextTertiary)
            }
        }
        if (flagged) {
            Spacer(Modifier.height(8.dp))
            InsetRow {
                Text(
                    "Flagged by review — read it closely before you send it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Warning,
                )
            }
        }
        if (asset.trackingQuery.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            InsetRow {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Tracking tag", style = MaterialTheme.typography.labelMedium, color = TextTertiary)
                        Text(
                            "Append to any fillbookhq.com link: ?${asset.trackingQuery}",
                            style = MaterialTheme.typography.bodySmall,
                            color = TextSecondary,
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        )
                    }
                    CopyButton(text = "?${asset.trackingQuery}", label = "Tag")
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PrimaryButton(text = "Approve", onClick = onApprove, enabled = !busy, busy = busy, modifier = Modifier.weight(1f))
            SecondaryButton(text = "Reject", onClick = onReject, enabled = !busy, contentColor = Danger)
        }
        Spacer(Modifier.height(2.dp))
        GhostButton(text = "Copy & Share", onClick = onCopyAndShare, enabled = !busy, modifier = Modifier.fillMaxWidth())
    }
}

/**
 * The confirmation shown after a decision. For an approved video it says what the server actually did about
 * rendering, because a render can be refused (daily or monthly limit) while the approval itself still
 * succeeds -- and before this the app said only "Approved", so a refused render looked like nothing happened.
 */
internal fun approvalSnackbarMessage(approve: Boolean, outcome: VideoRenderOutcome?): String {
    if (!approve) return "Rejected"
    if (outcome == null) return "Approved"
    if (outcome.alreadyExisted) return "Approved. This video is already rendering."
    if (outcome.queued) return "Approved. Video queued for rendering. Check Video Status in a minute or two."
    val reason = outcome.reason.orEmpty()
    return when {
        reason.startsWith("daily_render_cap_reached") ->
            "Approved, but not rendering yet: today's video limit is used. It will render automatically at the first check after midnight (usually late morning)."
        reason.startsWith("monthly_render_cap_reached") ->
            "Approved, but not rendering: this month's video limit is used."
        reason.isNotBlank() -> "Approved, but the video was not queued: $reason"
        else -> "Approved, but the video was not queued."
    }
}


/** The quick reasons offered when rejecting a draft; saved with the rejection (migration 0048). */
internal val REJECT_REASONS = listOf("Wrong figure or claim", "Wrong tone", "Weak topic", "Too similar to another video")
