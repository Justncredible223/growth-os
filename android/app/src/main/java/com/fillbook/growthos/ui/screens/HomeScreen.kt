package com.fillbook.growthos.ui.screens

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.Radar
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import com.fillbook.growthos.data.AttributionSummary
import com.fillbook.growthos.data.GrowthOsRepository
import com.fillbook.growthos.data.authErrorMessage
import com.fillbook.growthos.data.HealthItem
import com.fillbook.growthos.data.HomeSummary
import com.fillbook.growthos.data.InboundSummary
import com.fillbook.growthos.data.TodayXPost
import com.fillbook.growthos.data.TodayXPostState
import com.fillbook.growthos.data.TodaysVideo
import com.fillbook.growthos.data.TodaysVideoState
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.HeroActionCard
import com.fillbook.growthos.ui.components.InsetRow
import com.fillbook.growthos.ui.components.MetricTile
import com.fillbook.growthos.ui.components.QuickActionChip
import com.fillbook.growthos.ui.components.QuietStatusLabel
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.SectionHeader
import com.fillbook.growthos.ui.components.SkeletonListLoading
import com.fillbook.growthos.ui.components.StatusTone
import com.fillbook.growthos.ui.components.autoDraftSkipReasonLabel
import com.fillbook.growthos.ui.components.copyToClipboard
import com.fillbook.growthos.ui.components.openExternalUrl
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Border
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.Success
import com.fillbook.growthos.ui.theme.TextPrimary
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary
import com.fillbook.growthos.ui.theme.Warning
import kotlinx.coroutines.launch

/**
 * Command center, not a text report. Structure, top to bottom: masthead
 * -> Next Best Action (the single strongest surface on the screen, by
 * design -- see HeroActionCard) -> a compact operational-summary strip ->
 * system issues (visible but deliberately quieter than the hero above it)
 * -> inbound snapshot when there's something live -> quick actions -> a
 * quiet, timeline-style recent-activity list. Every number here is real
 * (same /api/summary + /api/health this app has always used) -- this
 * screen changes how it's organized and how loudly each part speaks, not
 * what it claims.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(repo: GrowthOsRepository, onNavigate: (String) -> Unit) {
    var summary by remember { mutableStateOf<HomeSummary?>(null) }
    var health by remember { mutableStateOf<List<HealthItem>>(emptyList()) }
    var inbound by remember { mutableStateOf<InboundSummary?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    // rememberSaveable, not remember: reopening after a tab switch or a
    // config change should not silently lose the owner's place mid-review.
    var reviewingXPost by rememberSaveable { mutableStateOf(false) }
    var handingOff by remember { mutableStateOf(false) }
    var confirmNewXDraft by remember { mutableStateOf(false) }
    var xPostActionBusy by remember { mutableStateOf(false) } // Regenerate / Mark posted -- distinct from the review dialog's own handingOff
    // Owner edits before copy -- keyed by campaignAssetId so a genuinely
    // NEW post (a fresh Regenerate result) starts from its own draft
    // text, while edits to the SAME post survive the dialog closing,
    // configuration changes, and (via rememberSaveable) navigating away
    // and back. Never sent anywhere until Copy + Open X is tapped; a
    // draft the owner never touches copies exactly as the LLM wrote it.
    var editedXPostText by rememberSaveable(summary?.todayXPost?.campaignAssetId) {
        mutableStateOf(summary?.todayXPost?.previewText.orEmpty())
    }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    suspend fun refresh() {
        try {
            summary = repo.getHomeSummary()
            health = repo.getHealth()
            inbound = repo.getInboundSummary()
            errorMessage = null
        } catch (e: Exception) {
            android.util.Log.e("GrowthOsDiag", "refresh() failed", e)
            errorMessage = authErrorMessage(e) ?: "Couldn't reach Growth OS. Check your connection and try again."
        }
        loaded = true
    }

    LaunchedEffect(Unit) { refresh() }

    fun handOffXPost(assetId: String, previewText: String) {
        scope.launch {
            handingOff = true
            try {
                repo.handOffAsset(assetId)
                copyToClipboard(context, "Today's X post", previewText)
                val opened = openExternalUrl(context, "https://x.com/compose/post")
                reviewingXPost = false
                refresh()
                snackbarHostState.showSnackbar(if (opened) "Opened in X — posting is still up to you" else "Copied, but no app could open X")
            } catch (e: Exception) {
                snackbarHostState.showSnackbar("Couldn't complete that -- check your connection and try again.")
            }
            handingOff = false
        }
    }

    fun regenerateXPost() {
        scope.launch {
            xPostActionBusy = true
            try {
                summary = summary?.copy(todayXPost = repo.regenerateTodayXPost())
                errorMessage = null
            } catch (e: Exception) {
                snackbarHostState.showSnackbar("Couldn't regenerate today's post. Check your connection and try again.")
            }
            xPostActionBusy = false
        }
    }

    // "New draft": the server only replaces a draft that was rejected (it never regenerates over a good post), so this
    // rejects the current one, then asks for the new one. The reject reason is saved with it.
    fun replaceXPostDraft(assetId: String) {
        scope.launch {
            xPostActionBusy = true
            try {
                repo.decideApproval(assetId, approve = false, reason = "Wanted a different draft")
                summary = summary?.copy(todayXPost = repo.regenerateTodayXPost())
                errorMessage = null
            } catch (e: Exception) {
                snackbarHostState.showSnackbar("Couldn't write a new draft. Check your connection and try again.")
            }
            refresh()
            xPostActionBusy = false
        }
    }

    fun markXPostPosted(assetId: String, postedText: String) {
        scope.launch {
            xPostActionBusy = true
            try {
                summary = summary?.copy(todayXPost = repo.markTodayXPostPosted(assetId, postedText))
            } catch (e: Exception) {
                snackbarHostState.showSnackbar("Couldn't mark that posted. Check your connection and try again.")
            }
            xPostActionBusy = false
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
        modifier = Modifier.fillMaxSize(),
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
            contentPadding = PaddingValues(bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item { ScreenHeader("Fillbook Growth OS", "Mission Control", kicker = "Operator console") }

            errorMessage?.let { message ->
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(horizontal = 20.dp)) {
                        Text(message, style = MaterialTheme.typography.bodyMedium, color = Danger, modifier = Modifier.weight(1f))
                        TextButton(onClick = { scope.launch { refresh() } }) { Text("Retry") }
                    }
                }
            }

            if (!loaded) {
                item { SkeletonListLoading() }
            }

            summary?.let { s ->
                val issueCount = health.count { it.status.name == "DOWN" || it.status.name == "DEGRADED" }

                item { Box20 { NextBestActionCard(s, inbound, onNavigate) } }

                s.video?.let { video -> item { Box20 { TodaysVideoCard(video, onNavigate) } } }

                item {
                    Box20 {
                        Column {
                            TodayXPostCard(
                                post = s.todayXPost,
                                busy = xPostActionBusy,
                                onReview = { reviewingXPost = true },
                                onRegenerate = { regenerateXPost() },
                                // editedXPostText is the same state the owner edited before
                                // handoff (survives it -- campaignAssetId doesn't change), so
                                // a same-session Mark posted already carries any edit
                                // correctly; do NOT prefer server text over it here, or an
                                // owner's edit would be silently replaced by the original
                                // generated draft (the backend never persists an edit -- see
                                // handOffAsset's kdoc). Its own rememberSaveable initializer
                                // (line ~110) is what fixes the cross-restart blank-text case,
                                // now that todayXPost.previewText is populated for HANDED_OFF
                                // too (see deriveTodayXPostView's kdoc).
                                onMarkPosted = { s.todayXPost.campaignAssetId?.let { markXPostPosted(it, editedXPostText) } },
                            )
                            TextButton(onClick = { onNavigate("x_feed_post_history") }) { Text("Previous drafts") }
                        }
                    }
                }

                item {
                    Box20 {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            MetricTile("Opportunities", s.opportunitiesFound.toString(), Icons.Filled.Search, Modifier.weight(1f))
                            MetricTile(
                                "Waiting on you",
                                s.pendingReview.toString(),
                                Icons.Filled.CheckCircle,
                                Modifier.weight(1f),
                                valueColor = if (s.pendingReview > 0) Warning else TextPrimary,
                                highlighted = s.pendingReview > 0,
                                highlightColor = Warning,
                            )
                        }
                    }
                }
                item {
                    Box20 {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            MetricTile("Today's spend", "$%.4f".format(s.analytics.todaySpendUsd), Icons.Filled.Bolt, Modifier.weight(1f))
                            MetricTile(
                                "System health",
                                if (issueCount == 0) "All clear" else "$issueCount issue${if (issueCount == 1) "" else "s"}",
                                Icons.Filled.PauseCircle,
                                Modifier.weight(1f),
                                valueColor = if (issueCount == 0) Success else Warning,
                                highlighted = issueCount > 0,
                                highlightColor = Warning,
                            )
                        }
                    }
                }

                if (issueCount > 0) {
                    item { Box20 { SystemIssuesCard(health, issueCount, onNavigate) } }
                }

                inbound?.let { i ->
                    if (i.needsResponse > 0 || i.followUp > 0 || i.repeatEngagers > 0) {
                        item { Box20 { SectionHeader("Inbound") } }
                        item { Box20 { InboundSummaryCard(i, onNavigate) } }
                    }
                }

                item { Box20 { SectionHeader("Quick actions") } }
                item {
                    Box20 {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            QuickActionChip(Icons.Filled.Forum, "Inbound", { onNavigate("inbound") }, Modifier.weight(1f))
                            QuickActionChip(Icons.Filled.CheckCircle, "Approvals", { onNavigate("approvals") }, Modifier.weight(1f))
                            QuickActionChip(Icons.Filled.Radar, "Radar", { onNavigate("radar") }, Modifier.weight(1f))
                        }
                    }
                }

                item { Box20 { SectionHeader("Attribution") } }
                item { Box20 { AttributionCard(s.attribution) } }

                item { Box20 { SectionHeader("Recent activity") } }
                item { Box20 { RecentActivity(s, health) } }
            }
        }
    }
    SnackbarHost(hostState = snackbarHostState, modifier = Modifier.align(Alignment.BottomCenter))
    }

    if (confirmNewXDraft) {
        AlertDialog(
            onDismissRequest = { confirmNewXDraft = false },
            title = { Text("Replace this draft?") },
            text = { Text("The current draft is discarded and a new one is written. Copy it first if you want to keep it. A new draft uses one of today's attempts.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmNewXDraft = false
                    summary?.todayXPost?.campaignAssetId?.let { replaceXPostDraft(it) }
                }) { Text("Replace") }
            },
            dismissButton = { TextButton(onClick = { confirmNewXDraft = false }) { Text("Cancel") } },
        )
    }

    if (reviewingXPost) {
        val post = summary?.todayXPost
        val counter = xPostCounter(editedXPostText)
        AlertDialog(
            onDismissRequest = { if (!handingOff) reviewingXPost = false },
            title = { Text("Today's X Post") },
            text = {
                Column {
                    Text(
                        "Edit the draft below if you want, then copy it and open X -- posting is still up to you.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = TextSecondary,
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = editedXPostText,
                        onValueChange = { editedXPostText = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = MaterialTheme.typography.bodyMedium,
                        // Tall enough to read a whole post without scrolling inside the box.
                        minLines = 8,
                        maxLines = 16,
                        supportingText = {
                            Text(counter.first, color = if (counter.second) Warning else TextTertiary, style = MaterialTheme.typography.labelMedium)
                        },
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Accent, cursorColor = Accent, unfocusedBorderColor = Border),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton(
                            onClick = { copyToClipboard(context, "Today's X post", editedXPostText) },
                            enabled = !handingOff && editedXPostText.isNotBlank(),
                        ) { Text("Copy only") }
                        TextButton(
                            onClick = { confirmNewXDraft = true },
                            enabled = !handingOff && !xPostActionBusy && canReplaceXDraft(post),
                        ) { Text(if (xPostActionBusy) "Writing..." else "New draft") }
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val assetId = post?.campaignAssetId
                        if (assetId != null) handOffXPost(assetId, editedXPostText)
                    },
                    enabled = !handingOff && post?.campaignAssetId != null && editedXPostText.isNotBlank(),
                ) { Text(if (handingOff) "Opening..." else "Copy + Open X") }
            },
            dismissButton = {
                TextButton(onClick = { reviewingXPost = false }, enabled = !handingOff) { Text("Cancel") }
            },
        )
    }
}

/** A draft can be replaced while it is ready, before it is handed to X. */
internal fun canReplaceXDraft(post: TodayXPost?): Boolean = post != null && post.state == TodayXPostState.READY && post.campaignAssetId != null

/** Where X cuts a long post in the feed behind "Show more". The account has Premium, so longer posts are allowed; this is only the fold. */
internal const val X_POST_NORMAL_LIMIT = 280

/** The counter line under the draft, and whether the post runs past the feed fold ("412 / 280 - readers tap Show more to see the rest"). */
internal fun xPostCounter(text: String): Pair<String, Boolean> {
    val length = text.trim().length
    return if (length > X_POST_NORMAL_LIMIT) {
        "$length / $X_POST_NORMAL_LIMIT - past the fold, readers tap Show more to see the rest" to true
    } else {
        "$length / $X_POST_NORMAL_LIMIT" to false
    }
}

/** contentPadding was 20dp all around on the old flat LazyColumn; the masthead needs full-bleed control of its own padding now, so every other item opts into the same 20dp horizontal inset individually. */
@Composable
private fun Box20(content: @Composable () -> Unit) {
    Column(modifier = Modifier.padding(horizontal = 20.dp)) { content() }
}

/**
 * Priority order matches the explicit model: unresolved inbound engagement
 * outranks drafts waiting for review, which outrank fresh outbound
 * discovery -- a stranger's cold-discovery topic idea should never bury a
 * real person waiting on a reply. This card is deliberately the first and
 * strongest thing on the screen after the masthead -- see HeroActionCard.
 */
@Composable
private fun NextBestActionCard(summary: HomeSummary, inbound: InboundSummary?, onNavigate: (String) -> Unit) {
    val (kicker, title, subtitle, actionLabel, route, icon) = when {
        inbound != null && inbound.needsResponse > 0 -> NextAction(
            "Next best action",
            "${inbound.needsResponse} inbound repl${if (inbound.needsResponse == 1) "y" else "ies"} need${if (inbound.needsResponse == 1) "s" else ""} a response",
            if (inbound.overdue > 0) "${inbound.overdue} of these have been waiting over 48 hours." else "Real people who engaged with @FillbookHQ, waiting to hear back.",
            "Open Inbound",
            "inbound",
            Icons.Filled.Forum,
        )
        summary.pendingReview > 0 -> NextAction(
            "Next best action",
            "${summary.pendingReview} draft${if (summary.pendingReview == 1) "" else "s"} ready to review",
            "AI-reviewed and waiting on your decision -- approve, reject, or open in-platform.",
            "Review now",
            "approvals",
            Icons.Filled.CheckCircle,
        )
        summary.opportunitiesFound > 0 -> NextAction(
            "Next best action",
            "${summary.opportunitiesFound} open opportunities on Radar",
            "Real signals the system found -- nothing drafted from them yet unless you trigger it.",
            "View Radar",
            "radar",
            Icons.Filled.Radar,
        )
        else -> NextAction(
            "All caught up",
            "Nothing needs you right now",
            "No open opportunities and nothing waiting for review right now.",
            "View Analytics",
            "analytics",
            Icons.Filled.Insights,
        )
    }

    HeroActionCard(
        icon = icon,
        kicker = kicker,
        title = title,
        subtitle = subtitle,
        actionLabel = actionLabel,
        onClick = { onNavigate(route) },
    )
}

/**
 * A separate, quieter card from the Next Best Action hero above it --
 * NBA answers "what needs my attention right now" (interrupt-driven);
 * this answers a different, routine question ("did I handle Fillbook's
 * own X post today"), so it never competes with or reorders NBA's
 * priority. Only ever shows a real x_feed_post_runs + campaign_assets row
 * (see api/summary.ts's computeTodayXPostView) -- EMPTY is a genuine,
 * honest state, not a loading placeholder; HANDED_OFF never claims to
 * know the post actually went out on X (POSTED is the owner's own,
 * separate, later confirmation of that); FAILED surfaces the real reason
 * generation didn't produce a passing post, with a bounded Regenerate.
 */
@Composable
private fun TodayXPostCard(
    post: TodayXPost,
    busy: Boolean,
    onReview: () -> Unit,
    onRegenerate: () -> Unit,
    onMarkPosted: () -> Unit,
) {
    GrowthCard(
        onClick = if (post.state == TodayXPostState.READY) onReview else null,
        accentBar = when (post.state) {
            TodayXPostState.READY -> Accent
            TodayXPostState.FAILED -> Warning
            else -> null
        },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Filled.Tag, contentDescription = null, tint = TextTertiary, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Today's X Post", style = MaterialTheme.typography.titleMedium, color = TextPrimary, modifier = Modifier.weight(1f))
            when (post.state) {
                TodayXPostState.READY -> QuietStatusLabel("Ready for review", StatusTone.WAITING)
                TodayXPostState.RUNNING -> QuietStatusLabel("Generating...", StatusTone.WAITING)
                TodayXPostState.HANDED_OFF -> QuietStatusLabel("Opened in X", StatusTone.READY)
                TodayXPostState.POSTED -> QuietStatusLabel("Posted", StatusTone.READY)
                TodayXPostState.FAILED -> QuietStatusLabel("Needs attention", StatusTone.BLOCKED)
                TodayXPostState.EMPTY -> {}
            }
        }
        post.topicLabel?.let { label ->
            Spacer(Modifier.height(2.dp))
            Text(label, style = MaterialTheme.typography.labelMedium, color = Accent)
        }
        when (post.state) {
            TodayXPostState.READY -> {
                Spacer(Modifier.height(6.dp))
                Text(
                    post.previewText.orEmpty(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextSecondary,
                    maxLines = 2,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
                post.selectionReason?.let { reason ->
                    Spacer(Modifier.height(4.dp))
                    Text(reason, style = MaterialTheme.typography.bodySmall, color = TextTertiary, maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                }
            }
            TodayXPostState.RUNNING -> {
                Spacer(Modifier.height(4.dp))
                Text("Working on it -- check back shortly.", style = MaterialTheme.typography.bodySmall, color = TextTertiary)
            }
            TodayXPostState.HANDED_OFF -> {
                Spacer(Modifier.height(4.dp))
                Text("You already opened X with this draft today.", style = MaterialTheme.typography.bodySmall, color = TextTertiary)
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = onMarkPosted, enabled = !busy) { Text(if (busy) "Marking..." else "Mark posted") }
            }
            TodayXPostState.POSTED -> {
                Spacer(Modifier.height(4.dp))
                Text("Confirmed posted to X today.", style = MaterialTheme.typography.bodySmall, color = TextTertiary)
            }
            TodayXPostState.FAILED -> {
                Spacer(Modifier.height(4.dp))
                Text(
                    post.reason?.let { "Couldn't produce a quality post: $it" } ?: "Couldn't produce a quality post today.",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextTertiary,
                    maxLines = 3,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
                if (post.canRegenerate) {
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = onRegenerate, enabled = !busy) { Text(if (busy) "Regenerating..." else "Regenerate") }
                }
            }
            TodayXPostState.EMPTY -> {
                Spacer(Modifier.height(4.dp))
                Text("Nothing queued for X today.", style = MaterialTheme.typography.bodySmall, color = TextTertiary)
                if (post.canRegenerate) {
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = onRegenerate, enabled = !busy) { Text(if (busy) "Regenerating..." else "Regenerate") }
                }
            }
        }
    }
}

/**
 * Makes the "N issues" metric tile actionable instead of a dead end --
 * summarizes the real DOWN/DEGRADED subsystems (same /api/health data the
 * tile above already fetched) so the operator sees what's actually wrong
 * without leaving Home, then one tap into System for the full diagnostic
 * list. Deliberately quieter than the Next Best Action hero above it --
 * a small warning dot per line, not a shouting amber headline -- since a
 * system issue is real but is not automatically the most urgent thing on
 * the screen. Never rendered when healthy (issueCount == 0).
 */
@Composable
private fun SystemIssuesCard(health: List<com.fillbook.growthos.data.HealthItem>, issueCount: Int, onNavigate: (String) -> Unit) {
    val issues = health.filter { it.status.name == "DOWN" || it.status.name == "DEGRADED" }
    GrowthCard(onClick = { onNavigate("system") }, accentBar = Warning) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "$issueCount system issue${if (issueCount == 1) "" else "s"}",
                style = MaterialTheme.typography.titleMedium,
                color = TextPrimary,
            )
        }
        Spacer(Modifier.height(10.dp))
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            issues.take(2).forEach { item ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = Modifier.size(6.dp).background(Warning, CircleShape))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "${item.label} ${if (item.status.name == "DOWN") "is down" else "needs attention"}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = TextSecondary,
                    )
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("View diagnostics", style = MaterialTheme.typography.labelLarge, color = Accent)
            Spacer(Modifier.width(4.dp))
            Text("→", style = MaterialTheme.typography.labelLarge, color = Accent)
        }
    }
}

/** The exact scannable counts the spec asks for: "3 need response / 1 follow-up / 1 repeat engager / 0 overdue," one tap into the full queue. */
@Composable
private fun InboundSummaryCard(inbound: InboundSummary, onNavigate: (String) -> Unit) {
    GrowthCard(onClick = { onNavigate("inbound") }) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            InboundStat(inbound.needsResponse, "need response")
            InboundStat(inbound.followUp, "follow-ups")
            InboundStat(inbound.repeatEngagers, "repeat engager")
            InboundStat(inbound.overdue, "overdue", emphasize = inbound.overdue > 0)
        }
    }
}

@Composable
private fun InboundStat(count: Int, label: String, emphasize: Boolean = false) {
    Column {
        Text(count.toString(), style = com.fillbook.growthos.ui.theme.KpiNumberStyleSmall, color = if (emphasize) Danger else TextPrimary)
        Text(label, style = MaterialTheme.typography.labelMedium, color = TextSecondary)
    }
}

private data class NextAction(
    val kicker: String,
    val title: String,
    val subtitle: String,
    val actionLabel: String,
    val route: String,
    val icon: androidx.compose.ui.graphics.vector.ImageVector,
)

/**
 * Whether real FillbookHQ signups can be tied back to this project's own
 * outreach -- backed by conversion_events, which the FillbookHQ signup
 * webhook writes to (see backend/src/attribution/). Added so that loop is
 * actually visible on Home instead of a table nobody queries. Zero
 * signups is a genuine, expected early state (the webhook only just
 * started reporting) -- shown plainly rather than hidden, same as this
 * screen's other "nothing yet" states.
 */
@Composable
private fun AttributionCard(attribution: AttributionSummary) {
    GrowthCard {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Column {
                Text(
                    "${attribution.signupsLast7Days} signup${if (attribution.signupsLast7Days == 1) "" else "s"} (last 7 days)",
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextPrimary,
                )
                Text(
                    attribution.topSource?.let { "Top source: $it" } ?: "No attributed signups yet",
                    style = MaterialTheme.typography.labelMedium,
                    color = TextTertiary,
                )
            }
        }
    }
}

@Composable
private fun RecentActivity(summary: HomeSummary, health: List<HealthItem>) {
    val autoDraft = summary.analytics.autoDraft
    val syncedSources = health.filter { it.detail.contains("Verified live") }

    val rows = buildList {
        autoDraft.lastRunDate?.let { date ->
            add(
                "Auto-draft ($date)" to when (autoDraft.lastRunStatus) {
                    "drafted" -> "Produced a real draft"
                    "skipped" -> autoDraftSkipReasonLabel(autoDraft.lastRunSkipReason)
                    "failed" -> "Failed -- see System"
                    else -> autoDraft.lastRunStatus ?: "Unknown"
                },
            )
        }
        syncedSources.take(2).forEach { item ->
            add(item.label to item.detail.substringAfter("last synced ").take(19))
        }
    }

    if (rows.isEmpty()) {
        GrowthCard {
            Text("No activity recorded yet.", style = MaterialTheme.typography.bodyMedium, color = TextTertiary)
        }
    } else {
        // A quiet timeline, not another card -- a small dot-and-line rail
        // to the left of each row, so Recent Activity visually reads as
        // "history" rather than one more equally-weighted info card
        // competing with the hero surface above it.
        Column {
            rows.forEachIndexed { index, (label, detail) ->
                TimelineRow(label, detail, isLast = index == rows.lastIndex)
            }
        }
    }
}

@Composable
private fun TimelineRow(label: String, detail: String, isLast: Boolean) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(20.dp)) {
            Box(modifier = Modifier.size(7.dp).background(TextTertiary, CircleShape))
            if (!isLast) {
                Box(modifier = Modifier.width(1.dp).height(28.dp).background(com.fillbook.growthos.ui.theme.Border))
            }
        }
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.padding(bottom = if (isLast) 0.dp else 14.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, color = TextPrimary)
            Text(detail, style = MaterialTheme.typography.labelMedium, color = TextTertiary)
        }
    }
}


/** The tab a video in this state needs the owner in: Approvals to read the script, Video Status for everything else. */
internal fun todaysVideoRoute(state: TodaysVideoState): String = if (state == TodaysVideoState.NEEDS_APPROVAL) "approvals" else "video_status"

/** The label and what the owner has to do, by state; the state decides the colour so a glance tells what needs attention. */
private fun todaysVideoTone(state: TodaysVideoState): Pair<String, androidx.compose.ui.graphics.Color> = when (state) {
    TodaysVideoState.NONE -> "TODAY'S VIDEO" to TextTertiary
    TodaysVideoState.DRAFTING -> "DRAFTING" to Accent
    TodaysVideoState.NEEDS_APPROVAL -> "NEEDS YOU" to Warning
    TodaysVideoState.RENDERING -> "RENDERING" to Accent
    TodaysVideoState.READY -> "READY TO POST" to Warning
    TodaysVideoState.POSTED -> "POSTED" to Success
    TodaysVideoState.FAILED -> "FAILED" to Danger
}

/** Today's video at a glance: the concept and its day, where it is, and one tap to the screen where the next step happens. */
@Composable
private fun TodaysVideoCard(video: TodaysVideo, onNavigate: (String) -> Unit) {
    val (label, tone) = todaysVideoTone(video.state)
    GrowthCard(onClick = { onNavigate(todaysVideoRoute(video.state)) }, accentBar = tone) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = tone)
        Spacer(Modifier.height(6.dp))
        val title = video.title
        if (title != null) {
            Text(
                if (video.day != null) "Day ${video.day} · $title" else title,
                style = MaterialTheme.typography.titleMedium,
                color = TextPrimary,
            )
            Spacer(Modifier.height(4.dp))
        }
        Text(video.headline, style = MaterialTheme.typography.bodyLarge, color = TextPrimary)
        Spacer(Modifier.height(2.dp))
        Text(video.detail, style = MaterialTheme.typography.bodyMedium, color = TextSecondary)
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (video.state == TodaysVideoState.NEEDS_APPROVAL) "Open Approvals" else "Open Video Status", style = MaterialTheme.typography.labelLarge, color = Accent)
            Spacer(Modifier.width(4.dp))
            Text("→", style = MaterialTheme.typography.labelLarge, color = Accent)
        }
    }
}
