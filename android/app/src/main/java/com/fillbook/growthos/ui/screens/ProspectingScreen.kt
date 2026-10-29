package com.fillbook.growthos.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.fillbook.growthos.data.DraftRejectedException
import com.fillbook.growthos.data.GrowthOsRepository
import com.fillbook.growthos.data.authErrorMessage
import com.fillbook.growthos.data.ProspectingCandidate
import com.fillbook.growthos.data.ProspectingDiagnostics
import com.fillbook.growthos.data.ProspectingMaybeItem
import com.fillbook.growthos.data.ProspectingPacing
import com.fillbook.growthos.data.ProspectingSearchRunResult
import com.fillbook.growthos.ui.components.ExpandableText
import com.fillbook.growthos.ui.adaptive.DetailPlaceholder
import com.fillbook.growthos.ui.adaptive.LocalWindowLayout
import com.fillbook.growthos.ui.adaptive.RowTitleSubtitle
import com.fillbook.growthos.ui.adaptive.SelectableRow
import com.fillbook.growthos.ui.adaptive.TwoPane
import com.fillbook.growthos.ui.adaptive.resolveSelection
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.IconPill
import com.fillbook.growthos.ui.components.Pill
import com.fillbook.growthos.ui.components.PlatformActions
import com.fillbook.growthos.ui.components.PolishedEmptyState
import com.fillbook.growthos.ui.components.PrimaryButton
import com.fillbook.growthos.ui.components.ProspectingPostLink
import com.fillbook.growthos.ui.components.ScoreBadge
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.SkeletonListLoading
import com.fillbook.growthos.ui.components.copyToClipboard
import com.fillbook.growthos.ui.components.openExternalUrl
import com.fillbook.growthos.ui.components.openInBrowser
import com.fillbook.growthos.ui.components.platformDisplayName
import com.fillbook.growthos.ui.components.platformIcon
import com.fillbook.growthos.ui.components.relativeTime
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Border
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.Success
import com.fillbook.growthos.ui.theme.TextPrimary
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary
import com.fillbook.growthos.ui.theme.Warning
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Prospecting -- the proactive-outreach half of growth, distinct from
 * Radar/Inbound (which only ever surface people already talking TO
 * Fillbook). This queue surfaces OTHER traders' public posts on X worth
 * joining. Same non-negotiable guarantee as everywhere else
 * in this app: nothing here ever posts anything. The furthest any action
 * here reaches is "opened the candidate's own platform with a draft copied
 * to the clipboard" -- the owner reviews, edits, and posts every reply
 * themselves (see
 * fillbookhq/docs/social/MASTER_SOCIAL_STRATEGY.md's human-execution
 * boundary, which this screen implements as an app UI instead of a manual
 * chat workflow).
 *
 * Designed to be worked as a fast daily queue: highest-opportunity-score
 * candidate first, one glance to judge relevance, one tap to draft, one
 * tap to copy+open, one tap to record the outcome -- the operating target
 * is completing ~8-15 of these a day without it turning into research.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProspectingScreen(repo: GrowthOsRepository) {
    var items by remember { mutableStateOf<List<ProspectingCandidate>>(emptyList()) }
    var diagnostics by remember { mutableStateOf<ProspectingDiagnostics?>(null) }
    var pacing by remember { mutableStateOf<ProspectingPacing?>(null) }
    var maybe by remember { mutableStateOf<List<ProspectingMaybeItem>>(emptyList()) }
    var maybeOpen by rememberSaveable { mutableStateOf(false) }
    var nowMillis by remember { mutableStateOf(System.currentTimeMillis()) }
    var loaded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var searchingNow by remember { mutableStateOf(false) }
    var lastSearchNowRun by remember { mutableStateOf<ProspectingSearchRunResult?>(null) }
    var draftingId by remember { mutableStateOf<String?>(null) }
    var busyId by remember { mutableStateOf<String?>(null) }
    // "Draft anyway" on a Maybe row: the row being drafted (one at a time, it costs a model call) and the card to bring into view afterwards.
    var maybeDraftingId by remember { mutableStateOf<String?>(null) }
    var scrollToId by remember { mutableStateOf<String?>(null) }
    val listState = rememberLazyListState()
    // Wide layout only: the candidate shown in the detail pane. Saveable so it survives a fold/unfold.
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    val twoPane = LocalWindowLayout.current.twoPane
    // Edits the owner makes before copying -- keyed by candidate id so
    // switching cards (or a refresh) never mixes up whose edit is whose.
    // Never sent anywhere until "Replied" is tapped; a draft the owner
    // never touches is copied exactly as the LLM wrote it.
    val editedDrafts = remember { mutableStateMapOf<String, String>() }
    // Two-option drafts: which option (sharp / helpful) the owner last copied or edited, per candidate. "Replied" posts that one.
    val chosenStyles = remember { mutableStateMapOf<String, String>() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    suspend fun refresh() {
        try {
            val result = repo.getProspectingQueue()
            items = result.candidates
            diagnostics = result.diagnostics
            pacing = result.pacing
            maybe = result.maybe
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = authErrorMessage(e) ?: "Couldn't load Prospecting. Check your connection and try again."
        }
        loaded = true
    }

    LaunchedEffect(Unit) { refresh() }
    // Keeps the "next reply in N min" countdown and the held reply button current.
    LaunchedEffect(Unit) {
        while (true) {
            delay(15_000)
            nowMillis = System.currentTimeMillis()
        }
    }
    val replyHold = replyHoldLabel(pacing, nowMillis)

    // Owner-triggered "search now" -- bypasses the 08:00/13:00/18:00
    // schedule so a tap has a real chance at surfacing something new right
    // away, rather than re-searching whatever the next scheduled slot
    // would already cover (see runProspectingSearchNow's own doc comment).
    // Same shape as PartnershipsScreen's runDiscoveryRefresh: track the
    // last run's result for the status line, then refresh() so any new
    // candidate actually shows up in the list without a second manual pull.
    fun runSearchNow() {
        scope.launch {
            searchingNow = true
            try {
                lastSearchNowRun = repo.runProspectingSearchNow()
                refresh()
                actionError = null
            } catch (e: Exception) {
                actionError = searchFailureMessage(e)
            }
            searchingNow = false
        }
    }

    fun startDraft(candidate: ProspectingCandidate) {
        scope.launch {
            draftingId = candidate.id
            try {
                val updated = repo.draftProspectingReply(candidate.id)
                items = items.map { if (it.id == updated.id) updated else it }
                if (updated.draftOptions.isEmpty()) editedDrafts[updated.id] = updated.draftReply.orEmpty()
                actionError = null
            } catch (e: DraftRejectedException) {
                // A real, meaningful rejection (the reply guardrail catching a
                // banned phrase, an unverified claim, or an undeclared link) --
                // never a connectivity problem. Shown directly, not swallowed
                // into the generic message below.
                actionError = e.shortReason
            } catch (e: Exception) {
                actionError = "Couldn't draft a reply. Check your connection and try again."
            }
            draftingId = null
        }
    }

    // Owner override of the AI screen. On success the queue is refreshed so the new card (with its options) is in `items`, then it is
    // selected (two-pane detail) and scrolled to (one-pane list). On failure the server's reason is shown and the Maybe row stays as it was.
    fun startDraftAnyway(item: ProspectingMaybeItem) {
        scope.launch {
            maybeDraftingId = item.id
            try {
                val drafted = repo.draftScreenedOutProspectingPost(item.id)
                refresh()
                if (drafted.draftOptions.isEmpty()) editedDrafts[drafted.id] = drafted.draftReply.orEmpty()
                selectedId = drafted.id
                scrollToId = drafted.id
                actionError = null
            } catch (e: DraftRejectedException) {
                actionError = e.shortReason
            } catch (e: Exception) {
                actionError = "Couldn't draft that post. Check your connection and try again."
            }
            maybeDraftingId = null
        }
    }

    LaunchedEffect(scrollToId, items) {
        val id = scrollToId ?: return@LaunchedEffect
        val index = items.indexOfFirst { it.id == id }
        if (index >= 0) {
            listState.animateScrollToItem(index)
            scrollToId = null
        }
    }

    // Copies the (possibly edited) draft and opens the post in the
    // candidate's OWN platform app -- X for an X post -- with the
    // confirmation worded to match. A failed launch
    // (no handler on the device) is reported, not swallowed; the timestamp
    // call is best-effort and never blocks the owner.
    fun copyAndOpen(candidate: ProspectingCandidate, style: String? = null) {
        if (style != null) chosenStyles[candidate.id] = style
        val text = currentReplyText(candidate, editedDrafts, chosenStyles[candidate.id])
        if (text != null) copyToClipboard(context, "Reply to ${candidate.authorHandle ?: "unknown"}", text)
        val opened = openExternalUrl(context, ProspectingPostLink.buildOpenUrl(candidate.platform, candidate.postUrl, candidate.authorHandle))
        scope.launch {
            if (opened) runCatching { repo.openProspectingCandidate(candidate.id) }
            ProspectingPostLink.copyAndOpenMessage(candidate.platform, copied = text != null, opened = opened)
                ?.let { snackbarHostState.showSnackbar(it) }
        }
    }

    // Same as copyAndOpen, but the post opens in a web browser instead of the platform's app (see openInBrowser).
    fun copyAndOpenInBrowser(candidate: ProspectingCandidate) {
        val text = currentReplyText(candidate, editedDrafts, chosenStyles[candidate.id])
        if (text != null) copyToClipboard(context, "Reply to ${candidate.authorHandle ?: "unknown"}", text)
        val opened = openInBrowser(context, ProspectingPostLink.buildOpenUrl(candidate.platform, candidate.postUrl, candidate.authorHandle))
        scope.launch {
            if (opened) runCatching { repo.openProspectingCandidate(candidate.id) }
            ProspectingPostLink.copyAndBrowserMessage(candidate.platform, copied = text != null, opened = opened)
                ?.let { snackbarHostState.showSnackbar(it) }
        }
    }

    fun runOutcome(candidate: ProspectingCandidate, afterSuccess: suspend () -> Unit = {}, action: suspend () -> Unit) {
        scope.launch {
            busyId = candidate.id
            try {
                action()
                items = items.filterNot { it.id == candidate.id }
                editedDrafts.remove(candidate.id)
                editedDrafts.keys.filter { it.startsWith("${candidate.id}:") }.forEach { editedDrafts.remove(it) }
                chosenStyles.remove(candidate.id)
                actionError = null
                afterSuccess()
            } catch (e: Exception) {
                actionError = "Couldn't record that. Check your connection and try again."
            }
            busyId = null
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        ScreenHeader(
            "Prospecting",
            "Real conversations worth joining -- drafted for you, posted by you.",
            kicker = if (loaded && items.isNotEmpty()) "${items.size} opportunit${if (items.size == 1) "y" else "ies"} queued" else null,
            dense = true,
        )

        // The pacing status line and "Search now" share one row so the first candidate starts higher on the cover screen.
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val pacingLine = replyPacingLine(pacing, nowMillis)
            Text(
                pacingLine.orEmpty(),
                style = MaterialTheme.typography.bodySmall,
                color = if (replyHold != null) Warning else TextTertiary,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { runSearchNow() }, enabled = !searchingNow) {
                Text(if (searchingNow) "Searching..." else "Search now", color = Accent, maxLines = 1)
            }
        }
        searchNowStatusLine(lastSearchNowRun)?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = TextTertiary, modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp))
        }

        (errorMessage ?: actionError)?.let { message ->
            Row(modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(message, style = MaterialTheme.typography.bodyMedium, color = Danger, modifier = Modifier.weight(1f))
                if (errorMessage != null) {
                    TextButton(onClick = { scope.launch { refresh() } }) { Text("Retry") }
                } else {
                    TextButton(onClick = { actionError = null }) { Text("Dismiss") }
                }
            }
        }

        if (!loaded) {
            SkeletonListLoading()
        } else {
            // Real bug found on-device with an actual finger, twice (2026-09-07): PullToRefreshBox detects the pull
            // gesture through a NESTED SCROLL connection, which a plain non-scrollable Column (PolishedEmptyState)
            // never dispatches. The empty state therefore sits in a trivial LazyColumn, the same scrollable
            // container the populated case uses.
            val validSelectedId = resolveSelection(selectedId, items.map { it.id })
            val selectedCandidate = items.firstOrNull { it.id == validSelectedId }

            @Composable
            fun cardFor(candidate: ProspectingCandidate) {
                ProspectingCard(
                    candidate = candidate,
                    editedText = editedDrafts[candidate.id],
                    onEditedTextChange = { editedDrafts[candidate.id] = it },
                    editedDrafts = editedDrafts,
                    chosenStyle = chosenStyles[candidate.id],
                    onOptionEdit = { style, text ->
                        editedDrafts[optionEditKey(candidate.id, style)] = text
                        chosenStyles[candidate.id] = style
                    },
                    onCopyOption = { style, open ->
                        if (open) {
                            copyAndOpen(candidate, style)
                        } else {
                            chosenStyles[candidate.id] = style
                            currentReplyText(candidate, editedDrafts, style)?.let { copyToClipboard(context, "Reply to ${candidate.authorHandle ?: "unknown"}", it) }
                            scope.launch { snackbarHostState.showSnackbar("Copied the ${styleLabel(style).lowercase()} reply.") }
                        }
                    },
                    drafting = draftingId == candidate.id,
                    busy = busyId == candidate.id,
                    replyHold = replyHold,
                    onDraft = { startDraft(candidate) },
                    onCopyAndOpen = { copyAndOpen(candidate) },
                    onCopyAndOpenInBrowser = { copyAndOpenInBrowser(candidate) },
                    onReplied = {
                        // Refresh afterwards so the pacing line and the held button reflect this reply.
                        runOutcome(candidate, afterSuccess = { refresh() }) {
                            repo.markProspectingReplied(
                                candidate.id,
                                finalReplyToSend(candidate, editedDrafts, chosenStyles[candidate.id]),
                                candidate.replyMentionsFillbook,
                                candidate.replyUsedLink,
                            )
                        }
                    },
                    onSkip = { runOutcome(candidate) { repo.markProspectingSkipped(candidate.id, null) } },
                    onNotRelevant = { runOutcome(candidate) { repo.markProspectingNotRelevant(candidate.id) } },
                    onAlreadyHandled = { runOutcome(candidate) { repo.markProspectingAlreadyHandled(candidate.id) } },
                )
            }

            @Composable
            fun listPane() {
                PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    if (errorMessage == null && items.isEmpty()) {
                        LazyColumn(modifier = Modifier.fillMaxSize()) {
                            item {
                                PolishedEmptyState(
                                    icon = Icons.Filled.TrendingUp,
                                    headline = "Queue is clear",
                                    subtitle = prospectingEmptyStateMessage(diagnostics),
                                )
                            }
                            maybeSection(
                                maybe, maybeOpen, { maybeOpen = !maybeOpen }, maybeDraftingId, ::startDraftAnyway,
                            ) { item ->
                                openExternalUrl(context, ProspectingPostLink.buildOpenUrl("x", item.postUrl, item.authorHandle))
                            }
                        }
                    } else {
                        LazyColumn(
                            state = listState,
                            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                            verticalArrangement = Arrangement.spacedBy(if (twoPane) 8.dp else 12.dp),
                        ) {
                            items(items, key = { it.id }) { candidate ->
                                if (twoPane) {
                                    SelectableRow(selected = candidate.id == validSelectedId, onClick = { selectedId = candidate.id }) {
                                        RowTitleSubtitle(
                                            title = "@${candidate.authorHandle ?: "unknown"}",
                                            subtitle = candidate.postText,
                                            trailing = "${candidate.opportunityScore.toInt()}",
                                        )
                                        Spacer(Modifier.height(4.dp))
                                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                            Pill(platformDisplayName(candidate.platform), TextSecondary)
                                            if (candidate.draftReply != null) Pill("DRAFTED", Accent)
                                        }
                                    }
                                } else {
                                    cardFor(candidate)
                                }
                            }
                            maybeSection(
                                maybe, maybeOpen, { maybeOpen = !maybeOpen }, maybeDraftingId, ::startDraftAnyway,
                            ) { item ->
                                openExternalUrl(context, ProspectingPostLink.buildOpenUrl("x", item.postUrl, item.authorHandle))
                            }
                        }
                    }
                }
            }

            if (twoPane) {
                TwoPane(
                    list = { listPane() },
                    detail = {
                        if (selectedCandidate != null) {
                            // The same card the phone shows inline, scrollable on its own in the detail pane.
                            Column(
                                modifier = Modifier
                                    .fillMaxSize()
                                    .verticalScroll(rememberScrollState())
                                    .padding(horizontal = 20.dp, vertical = 4.dp),
                            ) { cardFor(selectedCandidate) }
                        } else {
                            DetailPlaceholder(
                                title = if (items.isEmpty()) "Nothing to reply to" else "Pick a candidate",
                                hint = if (items.isEmpty()) "New opportunities are found on a schedule." else "Its post, draft reply and actions show here.",
                            )
                        }
                    },
                )
            } else {
                listPane()
            }
        }
    }
    SnackbarHost(hostState = snackbarHostState, modifier = Modifier.align(Alignment.BottomCenter))
    }
}

/**
 * The collapsed "Maybe (n)" section at the end of the queue list (works in the one-pane and two-pane layouts, since both use this list):
 * posts the AI relevance screen turned away this week. Each row is the handle, the post text, "Draft anyway" (owner override, one at a time) and
 * "Open on X". Hidden when there is nothing to show.
 */
private fun LazyListScope.maybeSection(
    maybe: List<ProspectingMaybeItem>,
    open: Boolean,
    onToggle: () -> Unit,
    draftingId: String?,
    onDraftAnyway: (ProspectingMaybeItem) -> Unit,
    onOpenOnX: (ProspectingMaybeItem) -> Unit,
) {
    if (maybe.isEmpty()) return
    item(key = "maybe-header") {
        Row(
            modifier = Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Maybe (${maybe.size})", style = MaterialTheme.typography.titleMedium, color = TextSecondary, modifier = Modifier.weight(1f))
            Text(if (open) "Hide" else "Show", style = MaterialTheme.typography.labelLarge, color = Accent)
        }
    }
    if (open) {
        item(key = "maybe-hint") {
            Text(
                "Turned away by the AI check in the last 7 days. If many of these look fine, the check is too strict.",
                style = MaterialTheme.typography.bodySmall,
                color = TextTertiary,
            )
        }
        items(maybe, key = { "maybe-${it.id}" }) { item ->
            GrowthCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "@${item.authorHandle ?: "unknown"}",
                        style = MaterialTheme.typography.titleSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    item.at?.let { relativeTime(it) }?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = TextTertiary) }
                }
                Spacer(Modifier.height(4.dp))
                Text(item.postText, style = MaterialTheme.typography.bodyMedium, maxLines = 6, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(
                        onClick = { onDraftAnyway(item) },
                        enabled = maybeDraftEnabled(draftingId),
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(maybeDraftLabel(draftingId == item.id), color = Accent, maxLines = 1) }
                    TextButton(onClick = { onOpenOnX(item) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Open on X", color = Accent, maxLines = 1) }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProspectingCard(
    candidate: ProspectingCandidate,
    editedText: String?,
    onEditedTextChange: (String) -> Unit,
    editedDrafts: Map<String, String>,
    chosenStyle: String?,
    onOptionEdit: (style: String, text: String) -> Unit,
    onCopyOption: (style: String, open: Boolean) -> Unit,
    drafting: Boolean,
    busy: Boolean,
    replyHold: String?,
    onDraft: () -> Unit,
    onCopyAndOpen: () -> Unit,
    onCopyAndOpenInBrowser: () -> Unit,
    onReplied: () -> Unit,
    onSkip: () -> Unit,
    onNotRelevant: () -> Unit,
    onAlreadyHandled: () -> Unit,
) {
    GrowthCard(accentBar = Accent) {
        Row(verticalAlignment = Alignment.Top) {
            ScoreBadge(score = candidate.opportunityScore.toInt(), semanticLabel = "Opportunity score ${candidate.opportunityScore.toInt()}")
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "@${candidate.authorHandle ?: "unknown"}",
                    style = MaterialTheme.typography.titleLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(4.dp))
                // FlowRow, not Row: up to five variable-width chips here, and
                // "CREATOR CANDIDATE" alone can be wider than a narrow phone
                // leaves after the score badge -- wrapping beats clipping.
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    IconPill(platformDisplayName(candidate.platform), platformIcon(candidate.platform), TextSecondary)
                    Pill("CLASS ${candidate.replyClass}", Accent)
                    Pill(candidate.discoveryLabel, TextSecondary)
                    candidate.authorFollowerCount?.let { count -> Pill(formatFollowerCount(count), TextTertiary) }
                    if (candidate.creatorCandidate) Pill("CREATOR CANDIDATE", Success)
                }
                // Both real timestamps, shown together deliberately (2026-09-07
                // freshness review): "posted" is the original X post time,
                // "queued" is when Growth OS itself found it -- these can
                // diverge (a candidate sitting in backlog for days before
                // winning a daily slot), and the gap itself is useful
                // information the owner shouldn't have to infer.
                val postedTime = candidate.postCreatedAt?.let { relativeTime(it) }
                val queuedTime = candidate.discoveredAt?.let { relativeTime(it) }
                if (postedTime != null || queuedTime != null) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        listOfNotNull(
                            postedTime?.let { "Posted $it" },
                            queuedTime?.let { "Queued $it" },
                        ).joinToString("  ·  "),
                        style = MaterialTheme.typography.labelMedium,
                        color = TextTertiary,
                    )
                }
            }
        }

        Spacer(Modifier.height(10.dp))
        ExpandableText(candidate.postText, style = MaterialTheme.typography.bodyMedium, color = TextPrimary, collapsedMaxLines = 3)
        suggestedInteractionLine(candidate.scoreBreakdown)?.let { line ->
            Spacer(Modifier.height(6.dp))
            Text(line, style = MaterialTheme.typography.labelMedium, color = Accent)
        }

        Spacer(Modifier.height(8.dp))
        TextButton(
            onClick = { onCopyAndOpen() },
            contentPadding = PaddingValues(0.dp),
        ) { Text("View original post", style = MaterialTheme.typography.labelMedium, color = Accent) }

        val draft = candidate.draftReply
        val twoOptions = hasTwoOptions(candidate)
        if (draft != null && twoOptions) {
            // Reply-style experiment: two short labelled blocks, each with its own Copy / Copy + Open. Compact on purpose.
            candidate.draftOptions.forEach { option ->
                val text = optionText(candidate, option.style, editedDrafts) ?: option.text
                val active = activeStyle(candidate, chosenStyle) == option.style
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(styleLabel(option.style).uppercase(), style = MaterialTheme.typography.labelMedium, color = if (active) Accent else TextSecondary)
                    Spacer(Modifier.weight(1f))
                    Text(
                        "${text.length} / 280",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (text.length > 280) Danger else TextTertiary,
                    )
                }
                Spacer(Modifier.height(2.dp))
                OutlinedTextField(
                    value = text,
                    onValueChange = { onOptionEdit(option.style, it) },
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = MaterialTheme.typography.bodyMedium,
                    colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Accent, cursorColor = Accent, unfocusedBorderColor = if (active) Accent else Border),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { onCopyOption(option.style, false) }, enabled = !busy) { Text("Copy", maxLines = 1) }
                    TextButton(onClick = { onCopyOption(option.style, true) }, enabled = !busy && replyHold == null) {
                        Text(PlatformActions.copyAndOpenLabel(candidate.platform, hasLink = true), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            replyHold?.let {
                Text(it, style = MaterialTheme.typography.labelMedium, color = Warning)
            }
            if (candidate.replyMentionsFillbook == true || candidate.replyUsedLink == true) {
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (candidate.replyMentionsFillbook == true) Pill("MENTIONS FILLBOOK", TextSecondary)
                    if (candidate.replyUsedLink == true) Pill("INCLUDES LINK", TextSecondary)
                }
            }
        } else if (draft != null) {
            Spacer(Modifier.height(8.dp))
            Text("DRAFT REPLY", style = MaterialTheme.typography.labelMedium, color = Accent)
            Spacer(Modifier.height(4.dp))
            OutlinedTextField(
                value = editedText ?: draft,
                onValueChange = onEditedTextChange,
                modifier = Modifier.fillMaxWidth(),
                textStyle = MaterialTheme.typography.bodyMedium,
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Accent, cursorColor = Accent, unfocusedBorderColor = Border),
            )
            val charCount = (editedText ?: draft).length
            Text(
                "$charCount / 280",
                style = MaterialTheme.typography.labelSmall,
                color = if (charCount > 280) Danger else TextTertiary,
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.End,
            )
            if (candidate.replyMentionsFillbook == true || candidate.replyUsedLink == true) {
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (candidate.replyMentionsFillbook == true) Pill("MENTIONS FILLBOOK", TextSecondary)
                    if (candidate.replyUsedLink == true) Pill("INCLUDES LINK", TextSecondary)
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        // Defensive guard (2026-09-07): the backend now filters an
        // obviously-irrelevant candidate (e.g. crypto-only content) to
        // 'not_relevant' before it's ever returned by the queue endpoint,
        // so this candidate.status branch should be structurally
        // unreachable in practice. Kept anyway as a real backward-
        // compatible guard against a stale/cached response, or an older
        // backend build that hasn't deployed that filter yet -- status is
        // an existing plain String field, so an old API response that
        // never sends "not_relevant" here simply never triggers this
        // branch, no new field or schema change required.
        if (candidate.status == "not_relevant") {
            Text(
                "Not relevant to futures trading",
                style = MaterialTheme.typography.labelMedium,
                color = TextTertiary,
            )
        } else if (draft == null) {
            PrimaryButton(text = "Draft reply", onClick = onDraft, enabled = !drafting, busy = drafting, modifier = Modifier.fillMaxWidth())
        } else if (!twoOptions) {
            PrimaryButton(
                text = replyHold ?: PlatformActions.copyAndOpenLabel(candidate.platform, hasLink = true),
                onClick = onCopyAndOpen,
                enabled = !busy && replyHold == null,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Spacer(Modifier.height(6.dp))
        // FlowRow, not a fixed 4-column Row: "Not relevant" cramped/near-
        // ellipsis against 3 siblings sharing equal weight on a 360dp
        // phone -- wraps to a second line instead, same fix already used
        // for this card's own platform/class/follower chips above.
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(0.dp), modifier = Modifier.fillMaxWidth()) {
            if (draft != null && candidate.status != "not_relevant") {
                TextButton(onClick = onCopyAndOpenInBrowser, enabled = !busy && replyHold == null) {
                    Text("Open in browser", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            TextButton(onClick = onReplied, enabled = !busy) { Text("Replied", maxLines = 1, overflow = TextOverflow.Ellipsis) }
            TextButton(onClick = onSkip, enabled = !busy) { Text("Skip", maxLines = 1, overflow = TextOverflow.Ellipsis) }
            TextButton(onClick = onNotRelevant, enabled = !busy) { Text("Not relevant", maxLines = 1, overflow = TextOverflow.Ellipsis) }
            TextButton(onClick = onAlreadyHandled, enabled = !busy) { Text("Handled", maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}

/**
 * The pacing status line under the header (2026-09-25): replies posted in a burst got @FillbookHQ's replies
 * hidden on X, so the queue says when the next reply is sensible. Null when the API sent no pacing.
 */
internal fun replyPacingLine(pacing: ProspectingPacing?, nowMillis: Long): String? {
    if (pacing == null) return null
    val waitMillis = pacing.nextReplyAtMillis?.minus(nowMillis)?.takeIf { it > 0 }
    val count = "${pacing.repliedLast24h} of ${pacing.dailyCap} replies in the last 24h."
    if (waitMillis == null) return "$count Space them at least ${pacing.cooldownMinutes} min apart."
    return if (pacing.reason == "daily_cap") {
        "$count Next reply ${waitLabel(waitMillis)}. Posting in bursts gets replies hidden on X."
    } else {
        "Next reply ${waitLabel(waitMillis)}. Posting in bursts gets replies hidden on X."
    }
}

/** One "Draft anyway" at a time: it costs a model call, so every Maybe row is held while one is drafting. */
internal fun maybeDraftEnabled(draftingId: String?): Boolean = draftingId == null

internal fun maybeDraftLabel(thisRowDrafting: Boolean): String = if (thisRowDrafting) "Drafting..." else "Draft anyway"

/** The label that replaces "Copy & open" while the next reply should wait, or null when it can go now. */
internal fun replyHoldLabel(pacing: ProspectingPacing?, nowMillis: Long): String? {
    val waitMillis = pacing?.nextReplyAtMillis?.minus(nowMillis)?.takeIf { it > 0 } ?: return null
    return "Next reply ${waitLabel(waitMillis)}"
}

private fun waitLabel(waitMillis: Long): String {
    val minutes = (waitMillis + 59_999) / 60_000
    return if (minutes < 60) "in $minutes min" else "in ${minutes / 60}h ${minutes % 60}m"
}

/**
 * Owner-friendly explanation of what the last "Search now" tap actually
 * did -- mirrors PartnershipsScreen's discoveryStatusLine, translating the
 * real skip reasons runProspectingSearch can return (system_paused,
 * monthly_budget_reached, queue_full -- see prospectingSearch.ts) into
 * plain language instead of surfacing the raw internal string.
 */
internal fun searchNowStatusLine(lastRun: ProspectingSearchRunResult?): String? {
    if (lastRun == null) return null
    if (lastRun.skipped) {
        return when {
            lastRun.skipReason?.startsWith("system_paused") == true -> "Search skipped -- Prospecting is currently paused."
            lastRun.skipReason?.startsWith("monthly_budget_reached") == true -> "Search skipped -- this month's Prospecting budget is used up."
            lastRun.skipReason?.startsWith("queue_full") == true -> "Search skipped -- the queue already has plenty of candidates waiting."
            else -> lastRun.skipReason?.let { "Search skipped: $it" } ?: "Search skipped."
        }
    }
    return if (lastRun.newCandidates > 0) {
        "Found ${lastRun.newCandidates} new candidate${if (lastRun.newCandidates == 1) "" else "s"} (read ${lastRun.postsRead} posts)."
    } else {
        "No new candidates this search (read ${lastRun.postsRead} posts)."
    }
}

private fun formatFollowerCount(count: Int): String = when {
    count >= 1_000_000 -> "${count / 1_000_000}M followers"
    count >= 1_000 -> "${count / 1_000}K followers"
    else -> "$count followers"
}

/**
 * Owner-friendly explanation for an empty queue -- never surfaces internal
 * field names like "tooOldForToday" or "belowQualityBar" (2026-09-07
 * freshness/audience-quality follow-up). Pure function, no Compose/Android
 * dependency, directly unit-testable.
 *
 * [diagnostics] is null only when the API response predates that field
 * (see NetworkGrowthOsRepository.getProspectingQueue) -- that case keeps
 * the exact original generic copy rather than guessing at a reason.
 *
 * When diagnostics ARE present but the pool considered was itself empty
 * (totalConsidered == 0), that's a genuinely different situation from
 * "we had candidates but none were shown today" -- discovery found
 * nothing at all this run, not "found some, excluded them."
 *
 * Otherwise, builds one honest sentence from whichever reasons actually
 * apply -- a real production case had BOTH too-old and below-quality-bar
 * candidates at once, so this never hides one reason to only report the
 * other.
 */
internal fun prospectingEmptyStateMessage(diagnostics: ProspectingDiagnostics?): String {
    val fallback = "New opportunities are found once a day. Check back soon, or pull to refresh."
    if (diagnostics == null) return fallback
    if (diagnostics.totalConsidered == 0) {
        return "No new candidates were found. Discovery will try again on its next scheduled run."
    }

    val reasons = buildList {
        if (diagnostics.tooOldForToday > 0) {
            val n = diagnostics.tooOldForToday
            add(if (n == 1) "1 post was too old for today's active reply window" else "$n posts were too old for today's active reply window")
        }
        if (diagnostics.belowQualityBar > 0) {
            val n = diagnostics.belowQualityBar
            add(if (n == 1) "1 candidate didn't meet today's quality bar" else "$n candidates didn't meet today's quality bar")
        }
    }
    if (reasons.isEmpty()) return fallback

    return "${reasons.joinToString(", and ")}. Check back soon, or pull to refresh."
}

/** What to tell the owner when Search now fails: the X API running out of credits is not a connection problem. */
internal fun searchFailureMessage(e: Exception): String {
    val text = e.message.orEmpty()
    return if (text.contains("credits depleted", ignoreCase = true) || text.contains("HTTP 402")) {
        "X search is paused: the X API credits are used up. Add credits in the X developer portal, then search again."
    } else {
        "Couldn't search for new candidates. Check your connection and try again."
    }
}

/**
 * The one-line suggestion under a candidate's post (2026-10-28): what to do with it and the angle to take, from the keys the server
 * stores in the score breakdown (backend/src/prospecting/prospectingInteraction.ts). Null for candidates scored before it existed.
 */
internal fun suggestedInteractionLine(breakdown: Map<String, String>): String? {
    val action = breakdown["suggestedAction"]?.takeIf { it.isNotBlank() } ?: return null
    val angle = breakdown["suggestedAngle"]?.takeIf { it.isNotBlank() } ?: return null
    return "Suggested: ${action.replaceFirstChar { it.uppercase() }}. $angle"
}
