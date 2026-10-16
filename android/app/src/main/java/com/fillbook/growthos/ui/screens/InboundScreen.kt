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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.fillbook.growthos.data.DraftRejectedException
import com.fillbook.growthos.data.GrowthOsRepository
import com.fillbook.growthos.data.authErrorMessage
import com.fillbook.growthos.data.InboundEngagement
import com.fillbook.growthos.data.InboundSummary
import com.fillbook.growthos.ui.components.ExpandableText
import com.fillbook.growthos.ui.adaptive.DetailPlaceholder
import com.fillbook.growthos.ui.adaptive.LocalWindowLayout
import com.fillbook.growthos.ui.adaptive.RowTitleSubtitle
import com.fillbook.growthos.ui.adaptive.SelectableRow
import com.fillbook.growthos.ui.adaptive.TwoPane
import com.fillbook.growthos.ui.adaptive.resolveSelection
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.IconPill
import com.fillbook.growthos.ui.components.InboundFilter
import com.fillbook.growthos.ui.components.InsetRow
import com.fillbook.growthos.ui.components.MetricTile
import com.fillbook.growthos.ui.components.Pill
import com.fillbook.growthos.ui.components.PlatformActions
import com.fillbook.growthos.ui.components.PolishedEmptyState
import com.fillbook.growthos.ui.components.PrimaryButton
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.SecondaryButton
import com.fillbook.growthos.ui.components.SkeletonListLoading
import com.fillbook.growthos.ui.components.StatusChip
import com.fillbook.growthos.ui.components.copyToClipboard
import com.fillbook.growthos.ui.components.inboundPriorityColor
import com.fillbook.growthos.ui.components.inboundPriorityLabel
import com.fillbook.growthos.ui.components.inboundStatusLabel
import com.fillbook.growthos.ui.components.inboundStatusTone
import com.fillbook.growthos.ui.components.InboundReplyLink
import com.fillbook.growthos.ui.components.InboundReplyReminder
import com.fillbook.growthos.ui.components.openExternalUrl
import com.fillbook.growthos.ui.components.platformDisplayName
import com.fillbook.growthos.ui.components.platformIcon
import com.fillbook.growthos.ui.components.relativeTime
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.ui.text.style.TextAlign
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Border
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.Surface
import com.fillbook.growthos.ui.theme.TextPrimary
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary
import com.fillbook.growthos.ui.theme.Warning
import kotlinx.coroutines.launch

/**
 * The Inbound Engagement Queue -- surfaces every person who replied to,
 * mentioned, or quoted Fillbook on X so a meaningful reply is never
 * missed. Never sends anything: "Draft response" only generates
 * text for the owner to review, and "Mark responded" is the one explicit
 * action that records a reply actually went out (this app cannot verify
 * that via either platform's API, so it's a human confirmation, not an
 * assumption -- see docs/INBOUND_ENGAGEMENT.md).
 *
 * Every operator action funnels through [runAction] so a failure always
 * produces the same visible, dismissable error and never escapes the
 * coroutine as an uncaught exception.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboundScreen(repo: GrowthOsRepository) {
    var items by remember { mutableStateOf<List<InboundEngagement>>(emptyList()) }
    var summary by remember { mutableStateOf<InboundSummary?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var recovering by remember { mutableStateOf(false) }
    var busyId by remember { mutableStateOf<String?>(null) }
    // The owner's in-progress edits to a draft, keyed by item id. Sent back when they tap "Responded" so the drafter can learn their wording.
    val editedDrafts = remember { mutableStateMapOf<String, String>() }
    // Without this, a "Follow up" tap has no way back -- the item just sits
    // wherever it landed in the date-sorted list, potentially many screens
    // down once a handful of newer items arrive. Defaults to null (all
    // active statuses), same as the pre-filter behavior. Reconciled against
    // the live list after every refresh (see InboundFilter.reconcile) so it
    // can never point at a status with no remaining items.
    var statusFilter by rememberSaveable { mutableStateOf<String?>(null) }
    // Wide layout only: the item shown in the detail pane. Saveable so it survives a fold/unfold.
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    val twoPane = LocalWindowLayout.current.twoPane
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    suspend fun refresh() {
        try {
            val fresh = repo.getInboundQueue()
            items = fresh
            summary = repo.getInboundSummary()
            statusFilter = InboundFilter.reconcile(statusFilter, fresh.map { it.status })
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = authErrorMessage(e) ?: "Couldn't load inbound engagement. Check your connection and try again."
        }
        loaded = true
    }

    LaunchedEffect(Unit) { refresh() }

    // One combined action instead of a separate Copy button and Open
    // icon -- the owner still does the actual posting, this just removes
    // a redundant tap. Never touches status: opening the platform must
    // never imply a reply was sent, so "Mark responded" stays its own
    // explicit action. Opens the item's OWN platform and words the
    // confirmation to match; a device with nothing able to open the link
    // gets told so instead of a silent no-op.
    fun copyAndOpen(item: InboundEngagement) {
        val draft = editedDrafts[item.id] ?: item.draftResponse
        // Just the drafted reply, no auto-inserted "@handle" -- a
        // deliberate choice, not a gap: the reply-intent URL below no
        // longer pre-fills anything either (see InboundReplyLink's own
        // kdoc for the real, confirmed bug that caused -- X reserving a
        // blank first line above any `text` it was given). The owner
        // pastes/types at row 1 themselves, same as a genuine manual
        // reply would require anyway.
        if (draft != null) copyToClipboard(context, "Reply to ${item.authorHandle ?: "unknown"}", draft)
        val sourceReference = item.sourceReference
        // Opens X's reply-intent URL built from the exact tweet ID in
        // sourceReference, instead of the tweet's plain URL -- opening the
        // plain URL landed on X's generic composer, which risked the
        // owner's reply posting as a new standalone post instead of a real
        // reply. Falls back to sourceReference itself unchanged for any
        // other platform or an unrecognized URL shape. This never changes
        // status -- opening the platform must never imply a reply was
        // sent; "Mark responded" stays its own explicit action, untouched
        // here.
        val urlToOpen = InboundReplyLink.buildInboundReplyUrl(item.platform, sourceReference)
        val opened = urlToOpen != null && openExternalUrl(context, urlToOpen)
        // When X actually opened, remind the owner to verify the reply
        // really posted before marking this item responded -- the app has
        // no way to confirm X's own Post action actually succeeded (it can
        // silently fail with no error surfaced back to us), so this is the
        // one place that guards against tapping "Mark responded" on a
        // reply that never reached X. Falls back to PlatformActions' own
        // message for every other case (nothing copied, nothing to open,
        // or the platform failed to launch) -- those stay exactly as
        // before, since implying "opened" there would be wrong.
        val message = InboundReplyReminder.message(opened) ?: PlatformActions.copyAndOpenMessage(
            platform = item.platform,
            copied = draft != null,
            hadLink = sourceReference != null,
            opened = opened,
        )
        if (message != null) scope.launch { snackbarHostState.showSnackbar(message) }
    }

    fun runAction(id: String, failureMessage: String, action: suspend () -> Unit) {
        scope.launch {
            busyId = id
            try {
                action()
                actionError = null
                refresh()
            } catch (e: DraftRejectedException) {
                // A real, meaningful rejection (the reply guardrail catching a
                // banned phrase, an unverified claim, or an undeclared link) --
                // never a connectivity problem. Shown directly, not swallowed
                // into the generic failureMessage below.
                actionError = e.shortReason
            } catch (e: Exception) {
                actionError = failureMessage
            } finally {
                busyId = null
            }
        }
    }

    fun runBacklogRecovery() {
        scope.launch {
            recovering = true
            try {
                repo.runInboundBacklogRecovery()
                actionError = null
                refresh()
            } catch (e: Exception) {
                actionError = "Couldn't check for missed replies. Check your connection and try again."
            } finally {
                recovering = false
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        ScreenHeader(
            "Inbound",
            "People who engaged with Fillbook on X -- nothing here ever sends itself.",
            kicker = summary?.takeIf { it.needsResponse > 0 }?.let { "${it.needsResponse} need${if (it.needsResponse == 1) "s" else ""} a response" },
            dense = true,
        )

        (errorMessage ?: actionError)?.let { message ->
            Row(modifier = Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
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
            // One status line up top; the four metric tiles and "Check for missed replies" sit at the end of the list
            // (below the fold on the cover screen, nothing removed) so the first item's primary action is on screen.
            summary?.let { s ->
                Text(
                    "${s.needsResponse} need response · ${s.overdue} overdue · ${s.followUp} follow-up${if (s.followUp == 1) "" else "s"} · ${s.repeatEngagers} repeat",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (s.overdue > 0) Danger else TextTertiary,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp),
                )
            }

            @Composable
            fun SummaryBlock() {
                summary?.let { s ->
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 8.dp)) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            MetricTile(
                                "Need response",
                                s.needsResponse.toString(),
                                Icons.Filled.Forum,
                                Modifier.weight(1f),
                                valueColor = if (s.needsResponse > 0) Warning else TextPrimary,
                                highlighted = s.needsResponse > 0,
                                highlightColor = Warning,
                            )
                            MetricTile(
                                "Overdue",
                                s.overdue.toString(),
                                Icons.Filled.Forum,
                                Modifier.weight(1f),
                                valueColor = if (s.overdue > 0) Danger else TextPrimary,
                                highlighted = s.overdue > 0,
                                highlightColor = Danger,
                            )
                        }
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            MetricTile("Follow-ups", s.followUp.toString(), Icons.Filled.Repeat, Modifier.weight(1f))
                            MetricTile("Repeat engagers", s.repeatEngagers.toString(), Icons.Filled.Repeat, Modifier.weight(1f))
                        }
                        OutlinedButton(
                            onClick = { runBacklogRecovery() },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = !recovering,
                        ) {
                            Text(if (recovering) "Checking..." else "Check for missed replies", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Spacer(Modifier.height(12.dp))
                    }
                }
            }

            if (errorMessage == null && items.isEmpty()) {
                // Same nested-scroll fix as ProspectingScreen/VideoStatusScreen (2026-09-07): a genuinely empty queue
                // needs a LazyColumn inside PullToRefreshBox for pull-to-refresh to work at all.
                PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    LazyColumn(modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 20.dp)) {
                        item {
                            PolishedEmptyState(
                                icon = Icons.Filled.Forum,
                                headline = "Nothing waiting on you",
                                subtitle = "New replies, mentions, and follow-ups from Fillbook's audience on X show up here.",
                            )
                        }
                        item { SummaryBlock() }
                    }
                }
            } else {
                val availableStatuses = remember(items) { items.map { it.status }.distinct() }
                val filteredItems = remember(items, statusFilter) {
                    statusFilter?.let { s -> items.filter { it.status == s } } ?: items
                }
                val validSelectedId = resolveSelection(selectedId, filteredItems.map { it.id })
                val selectedItem = filteredItems.firstOrNull { it.id == validSelectedId }

                @Composable
                fun cardFor(item: InboundEngagement) {
                    InboundCard(
                        item = item,
                        busy = busyId == item.id,
                        onDraft = { runAction(item.id, "Couldn't draft a response. Check your connection and try again.") { editedDrafts.remove(item.id); repo.draftInboundResponse(item.id) } },
                        onMarkResponded = { runAction(item.id, "Couldn't mark that as responded. Check your connection and try again.") { repo.markInboundResponded(item.id, null, editedDrafts[item.id]?.takeIf { it != item.draftResponse }); editedDrafts.remove(item.id) } },
                        onFollowUp = { runAction(item.id, "Couldn't flag that for follow-up. Check your connection and try again.") { repo.markInboundFollowUp(item.id) } },
                        onClose = { runAction(item.id, "Couldn't close that. Check your connection and try again.") { repo.closeInbound(item.id) } },
                        onCopyAndOpen = { copyAndOpen(item) },
                        editedText = editedDrafts[item.id],
                        onEditedTextChange = { editedDrafts[item.id] = it },
                    )
                }

                @Composable
                fun listPane() {
                    Column(modifier = Modifier.fillMaxSize()) {
                        if (availableStatuses.size > 1) {
                            LazyRow(
                                contentPadding = PaddingValues(horizontal = 20.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                item { InboundFilterChip("All", statusFilter == null) { statusFilter = null } }
                                items(availableStatuses) { status ->
                                    InboundFilterChip(inboundStatusLabel(status), statusFilter == status) { statusFilter = status }
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                        }
                        PullToRefreshBox(
                            isRefreshing = refreshing,
                            onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
                            modifier = Modifier.fillMaxSize(),
                        ) {
                            if (filteredItems.isEmpty()) {
                                // Defensive: reconcile() clears a stale filter on refresh, but a status can still empty
                                // out between renders. Never show a blank queue without a way back. A LazyColumn (not a
                                // bare Column) so pull-to-refresh stays alive while a filter is narrowed to nothing.
                                LazyColumn(modifier = Modifier.fillMaxSize()) {
                                    item {
                                        Column(modifier = Modifier.fillMaxWidth()) {
                                            PolishedEmptyState(
                                                icon = Icons.Filled.Forum,
                                                headline = "No items in this filter",
                                                subtitle = "Other items are still waiting -- switch back to All to see them.",
                                            )
                                            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.Center) {
                                                TextButton(onClick = { statusFilter = null }) { Text("Show all") }
                                            }
                                        }
                                    }
                                }
                            } else {
                                LazyColumn(
                                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                                    verticalArrangement = Arrangement.spacedBy(if (twoPane) 8.dp else 12.dp),
                                ) {
                                    items(filteredItems, key = { it.id }) { item ->
                                        if (twoPane) {
                                            SelectableRow(selected = item.id == validSelectedId, onClick = { selectedId = item.id }) {
                                                RowTitleSubtitle(
                                                    title = "@${item.authorHandle ?: "unknown"}",
                                                    subtitle = item.body,
                                                    trailing = relativeTime(item.observedAt),
                                                )
                                                Spacer(Modifier.height(4.dp))
                                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                                    Pill(inboundPriorityLabel(item.priority), inboundPriorityColor(item.priority))
                                                    Pill(inboundStatusLabel(item.status).uppercase(), TextSecondary)
                                                }
                                            }
                                        } else {
                                            cardFor(item)
                                        }
                                    }
                                    item { SummaryBlock() }
                                }
                            }
                        }
                    }
                }

                if (twoPane) {
                    TwoPane(
                        list = { listPane() },
                        detail = {
                            if (selectedItem != null) {
                                Column(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .verticalScroll(rememberScrollState())
                                        .padding(horizontal = 20.dp, vertical = 4.dp),
                                ) { cardFor(selectedItem) }
                            } else {
                                DetailPlaceholder(
                                    title = "Pick a conversation",
                                    hint = "What they said, your draft reply and the actions show here.",
                                )
                            }
                        },
                    )
                } else {
                    listPane()
                }
            }
        }
    }
    SnackbarHost(hostState = snackbarHostState, modifier = Modifier.align(Alignment.BottomCenter))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun InboundCard(
    item: InboundEngagement,
    busy: Boolean,
    onDraft: () -> Unit,
    onMarkResponded: () -> Unit,
    onFollowUp: () -> Unit,
    onClose: () -> Unit,
    onCopyAndOpen: () -> Unit,
    editedText: String?,
    onEditedTextChange: (String) -> Unit,
) {
    GrowthCard(accentBar = inboundPriorityColor(item.priority)) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.weight(1f)) {
                Text("@${item.authorHandle ?: "unknown"}", style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(4.dp))
                // FlowRow: three variable-width chips wrap onto a second line
                // on a narrow phone instead of clipping the last one.
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    IconPill(platformDisplayName(item.platform), platformIcon(item.platform), TextSecondary)
                    Pill(inboundPriorityLabel(item.priority), inboundPriorityColor(item.priority))
                    if (item.isRepeatEngager) Pill("REPEAT", Accent)
                }
            }
            StatusChip(inboundStatusLabel(item.status), inboundStatusTone(item.status))
        }

        Spacer(Modifier.height(10.dp))
        ExpandableText(item.body, style = MaterialTheme.typography.bodyMedium, color = TextPrimary, collapsedMaxLines = 3)

        item.inResponseToText?.let { context ->
            Spacer(Modifier.height(8.dp))
            InsetRow {
                Text("Replying to:", style = MaterialTheme.typography.labelMedium, color = TextTertiary)
                Spacer(Modifier.height(2.dp))
                Text(context, style = MaterialTheme.typography.bodyMedium, color = TextSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }

        item.draftResponse?.let { draft ->
            Spacer(Modifier.height(8.dp))
            InsetRow {
                Text("DRAFT", style = MaterialTheme.typography.labelMedium, color = Accent)
                Spacer(Modifier.height(2.dp))
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
            }
        }

        Spacer(Modifier.height(6.dp))
        relativeTime(item.observedAt)?.let { time ->
            Text(time, style = MaterialTheme.typography.labelMedium, color = TextTertiary)
        }

        Spacer(Modifier.height(12.dp))

        val isActive = item.status !in setOf("responded", "closed")
        if (isActive) {
            if (item.draftResponse == null) {
                PrimaryButton(text = "Draft response", onClick = onDraft, enabled = !busy, busy = busy, modifier = Modifier.fillMaxWidth())
            } else {
                PrimaryButton(
                    text = PlatformActions.copyAndOpenLabel(item.platform, hasLink = item.sourceReference != null),
                    onClick = onCopyAndOpen,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
                TextButton(onClick = onFollowUp, enabled = !busy, modifier = Modifier.weight(1f)) { Text("Follow up", maxLines = 1, overflow = TextOverflow.Ellipsis) }
                TextButton(onClick = onMarkResponded, enabled = !busy, modifier = Modifier.weight(1f)) { Text("Responded", maxLines = 1, overflow = TextOverflow.Ellipsis) }
                TextButton(onClick = onClose, enabled = !busy, modifier = Modifier.weight(1f)) { Text("Close", maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        } else if (item.sourceReference != null) {
            SecondaryButton(text = PlatformActions.openLabel(item.platform), onClick = onCopyAndOpen, modifier = Modifier.fillMaxWidth())
        }
    }
}


@Composable
private fun InboundFilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        colors = FilterChipDefaults.filterChipColors(
            selectedContainerColor = Accent.copy(alpha = 0.2f),
            selectedLabelColor = Accent,
            containerColor = Surface,
            labelColor = TextSecondary,
        ),
    )
}
