package com.fillbook.growthos.ui.screens

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
import com.fillbook.growthos.data.ProspectingPacing
import com.fillbook.growthos.data.ProspectingSearchRunResult
import com.fillbook.growthos.ui.components.ExpandableText
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.IconPill
import com.fillbook.growthos.ui.components.Pill
import com.fillbook.growthos.ui.components.PlatformActions
import com.fillbook.growthos.ui.components.PolishedEmptyState
import com.fillbook.growthos.ui.components.PrimaryButton
import com.fillbook.growthos.ui.components.ScoreBadge
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.SkeletonListLoading
import com.fillbook.growthos.ui.components.copyToClipboard
import com.fillbook.growthos.ui.components.openExternalUrl
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
    var nowMillis by remember { mutableStateOf(System.currentTimeMillis()) }
    var loaded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var searchingNow by remember { mutableStateOf(false) }
    var lastSearchNowRun by remember { mutableStateOf<ProspectingSearchRunResult?>(null) }
    var draftingId by remember { mutableStateOf<String?>(null) }
    var busyId by remember { mutableStateOf<String?>(null) }
    // Edits the owner makes before copying -- keyed by candidate id so
    // switching cards (or a refresh) never mixes up whose edit is whose.
    // Never sent anywhere until "Replied" is tapped; a draft the owner
    // never touches is copied exactly as the LLM wrote it.
    val editedDrafts = remember { mutableStateMapOf<String, String>() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    suspend fun refresh() {
        try {
            val result = repo.getProspectingQueue()
            items = result.candidates
            diagnostics = result.diagnostics
            pacing = result.pacing
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
                editedDrafts[updated.id] = updated.draftReply.orEmpty()
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

    // Copies the (possibly edited) draft and opens the post in the
    // candidate's OWN platform app -- X for an X post -- with the
    // confirmation worded to match. A failed launch
    // (no handler on the device) is reported, not swallowed; the timestamp
    // call is best-effort and never blocks the owner.
    fun copyAndOpen(candidate: ProspectingCandidate) {
        val text = editedDrafts[candidate.id] ?: candidate.draftReply
        if (text != null) copyToClipboard(context, "Reply to ${candidate.authorHandle ?: "unknown"}", text)
        val opened = openExternalUrl(context, candidate.postUrl)
        scope.launch {
            if (opened) runCatching { repo.openProspectingCandidate(candidate.id) }
            PlatformActions.copyAndOpenMessage(candidate.platform, copied = text != null, hadLink = true, opened = opened)
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
        )

        Row(modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(onClick = { runSearchNow() }, enabled = !searchingNow, contentPadding = PaddingValues(0.dp)) {
                Text(if (searchingNow) "Searching..." else "Search now", color = Accent)
            }
        }
        searchNowStatusLine(lastSearchNowRun)?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = TextTertiary, modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp))
        }
        replyPacingLine(pacing, nowMillis)?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = if (replyHold != null) Warning else TextTertiary,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp),
            )
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
            // Real bug found on-device with an actual finger, twice
            // (2026-09-07): first fix (wrapping the empty state in
            // PullToRefreshBox) wasn't sufficient on its own.
            // PullToRefreshBox detects the pull gesture via a NESTED SCROLL
            // connection -- it only ever sees drag deltas that a scrollable
            // descendant dispatches upward. PolishedEmptyState is a plain,
            // non-scrollable Column (see GrowthComponents.kt), so it never
            // participates in nested scroll at all -- no touch drag on it
            // was ever reaching PullToRefreshBox's connection, no matter
            // where in the tree it was nested. The same bug exists in
            // VideoStatusScreen's and InboundScreen's own empty states
            // (confirmed by inspection, not fixed here -- out of scope).
            //
            // Fix: give the empty state a real (if trivial) LazyColumn, the
            // same scrollable container the populated case already uses --
            // a LazyColumn participates in nested scroll regardless of
            // whether its single item actually overflows the viewport, so
            // PullToRefreshBox has something real to detect the drag against.
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
                    }
                } else {
                    LazyColumn(
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(items, key = { it.id }) { candidate ->
                            ProspectingCard(
                                candidate = candidate,
                                editedText = editedDrafts[candidate.id],
                                onEditedTextChange = { editedDrafts[candidate.id] = it },
                                drafting = draftingId == candidate.id,
                                busy = busyId == candidate.id,
                                replyHold = replyHold,
                                onDraft = { startDraft(candidate) },
                                onCopyAndOpen = { copyAndOpen(candidate) },
                                onReplied = {
                                    // Refresh afterwards so the pacing line and the held button reflect this reply.
                                    runOutcome(candidate, afterSuccess = { refresh() }) {
                                        repo.markProspectingReplied(
                                            candidate.id,
                                            editedDrafts[candidate.id]?.takeIf { it != candidate.draftReply },
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
                    }
                }
            }
        }
    }
    SnackbarHost(hostState = snackbarHostState, modifier = Modifier.align(Alignment.BottomCenter))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProspectingCard(
    candidate: ProspectingCandidate,
    editedText: String?,
    onEditedTextChange: (String) -> Unit,
    drafting: Boolean,
    busy: Boolean,
    replyHold: String?,
    onDraft: () -> Unit,
    onCopyAndOpen: () -> Unit,
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

        Spacer(Modifier.height(8.dp))
        TextButton(
            onClick = { onCopyAndOpen() },
            contentPadding = PaddingValues(0.dp),
        ) { Text("View original post", style = MaterialTheme.typography.labelMedium, color = Accent) }

        val draft = candidate.draftReply
        if (draft != null) {
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
        } else {
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
