package com.fillbook.growthos.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.material3.Icon
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ThumbUp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import com.fillbook.growthos.data.EngagementActionException
import com.fillbook.growthos.data.EngagementItem
import com.fillbook.growthos.data.EngagementStatus
import com.fillbook.growthos.data.GrowthOsRepository
import com.fillbook.growthos.data.authErrorMessage
import com.fillbook.growthos.data.engagementSpacingLine
import com.fillbook.growthos.data.engagementTodayLine
import com.fillbook.growthos.ui.adaptive.DetailPlaceholder
import com.fillbook.growthos.ui.adaptive.LocalWindowLayout
import com.fillbook.growthos.ui.adaptive.RowTitleSubtitle
import com.fillbook.growthos.ui.adaptive.SelectableRow
import com.fillbook.growthos.ui.adaptive.TwoPane
import com.fillbook.growthos.ui.adaptive.resolveSelection
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.Pill
import com.fillbook.growthos.ui.components.PolishedEmptyState
import com.fillbook.growthos.ui.components.PrimaryButton
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.SecondaryButton
import com.fillbook.growthos.ui.components.SkeletonListLoading
import com.fillbook.growthos.ui.components.copyToClipboard
import com.fillbook.growthos.ui.components.openExternalUrl
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Border
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.TextPrimary
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary
import com.fillbook.growthos.ui.theme.Warning
import kotlinx.coroutines.launch

/** The platform's own comment length limit as the backend enforces it (commentGuardrails.ts COMMENT_MAX_CHARS). */
fun engagementCharLimit(platform: String): Int = if (platform == "tiktok") 150 else 280

fun engagementPlatformLabel(platform: String): String = if (platform == "tiktok") "TikTok" else "YouTube"

/** What the empty queue should tell the owner to do next. */
fun engagementEmptyMessage(status: EngagementStatus): String =
    if (status.youtubeConfigured) {
        val next = status.nextFillLabel?.let { "The next automatic fill runs around $it." } ?: "The queue refills automatically a few times a day."
        "You're caught up. $next TikTok links still need to be pasted below."
    } else {
        "Paste a TikTok link below. YouTube discovery turns on once YOUTUBE_API_KEY is set on the server."
    }

/**
 * Engage: other creators' Shorts and TikToks worth a thoughtful comment, with drafted options. Same guarantee as
 * every screen here: nothing posts from the app. "Open" and "Copy" hand the owner the link and the text; the owner
 * posts natively and then taps Done, which only records it. The server enforces the daily cap, the gap between
 * actions and the per-creator cooldown, and the screen shows its refusals as written.
 */
/**
 * A video link shared to Fillbook from TikTok's or YouTube's share sheet (MainActivity.handleSharedLink). The screen
 * takes it once, adds it to the queue through the same call as the paste box, drafts comments and opens the item.
 * Process-wide so a share that arrives before the app is unlocked or before this tab is first shown is not lost.
 */
object EngagementShareInbox {
    val link = mutableStateOf<String?>(null)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EngagementScreen(repo: GrowthOsRepository) {
    var status by remember { mutableStateOf<EngagementStatus?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    // Saveable: the open item survives a fold/unfold or process recreation.
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var discovering by remember { mutableStateOf(false) }
    var linkText by rememberSaveable { mutableStateOf("") }
    var watchText by rememberSaveable { mutableStateOf("") }
    // Owner edits and the draft last copied, keyed by "itemId/draftId" and itemId, so a refresh never mixes them up.
    val edits = remember { mutableStateMapOf<String, String>() }
    val copiedDraft = remember { mutableStateMapOf<String, String>() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    suspend fun refresh() {
        try {
            status = repo.getEngagementStatus()
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = authErrorMessage(e) ?: "Couldn't load Engage. Check your connection and try again."
        }
        loaded = true
    }

    fun failure(e: Exception, fallback: String): String =
        authErrorMessage(e) ?: (e as? EngagementActionException)?.reason ?: fallback

    fun perform(fallback: String, after: suspend () -> Unit = {}, block: suspend () -> Unit) {
        if (busy) return
        scope.launch {
            busy = true
            try {
                block()
                actionError = null
                after()
            } catch (e: Exception) {
                actionError = failure(e, fallback)
            }
            busy = false
        }
    }

    LaunchedEffect(Unit) { refresh() }

    // A link shared from the TikTok or YouTube share sheet: add it, draft comments, and open it ready to copy.
    val sharedLink = EngagementShareInbox.link.value
    LaunchedEffect(sharedLink) {
        val link = sharedLink ?: return@LaunchedEffect
        EngagementShareInbox.link.value = null
        busy = true
        try {
            val added = repo.addEngagementLink(link)
            actionError = null
            val ready = try {
                repo.draftEngagement(added.id)
            } catch (e: Exception) {
                actionError = failure(e, "Added the video, but couldn't draft comments. Open it and tap Draft comments.")
                added
            }
            refresh()
            selectedId = ready.id
        } catch (e: Exception) {
            actionError = failure(e, "Couldn't add that shared link. Try pasting it instead.")
            refresh()
        }
        busy = false
    }

    val twoPane = LocalWindowLayout.current.twoPane
    val current = status
    val selectedValidId = current?.let { c -> resolveSelection(selectedId, c.queue.map { it.id }) }
    val selected = current?.queue?.firstOrNull { it.id == selectedValidId }
    // On the wide layout the detail sits beside the list, so Back has nothing to go back to.
    BackHandler(enabled = selected != null && !twoPane) { selectedId = null }

    fun openItem(item: EngagementItem) {
        perform("Couldn't open that video. Try again.") {
            val url = repo.openEngagement(item.id)
            if (!openExternalUrl(context, url)) actionError = "No app could open that link."
        }
    }

    fun draftItem(item: EngagementItem) {
        perform("Couldn't draft comments. Check your connection and try again.", after = { refresh() }) {
            repo.draftEngagement(item.id)
        }
    }

    fun copyDraft(item: EngagementItem, draftId: String, text: String) {
        perform("Couldn't copy that. Try again.") {
            val result = repo.copyEngagement(item.id, draftId, text)
            copyToClipboard(context, "Comment", result.text)
            copiedDraft[item.id] = draftId
            val warning = result.warnings.firstOrNull()
            snackbarHostState.showSnackbar(warning ?: "Copied. Paste it into the comment box yourself.")
        }
    }

    fun copyAndOpenDraft(item: EngagementItem, draftId: String, text: String) {
        perform("Couldn't copy that. Try again.") {
            val result = repo.copyEngagement(item.id, draftId, text)
            copyToClipboard(context, "Comment", result.text)
            copiedDraft[item.id] = draftId
            val url = repo.openEngagement(item.id)
            if (!openExternalUrl(context, url)) actionError = "Copied, but no app could open that link."
        }
    }

    fun doneItem(item: EngagementItem, did: String) {
        val draftId = copiedDraft[item.id]
        val edited = draftId?.let { edits["${item.id}/$it"] }
        val original = item.drafts.firstOrNull { it.id == draftId }?.text
        perform("Couldn't record that. Try again.", after = { selectedId = null; refresh() }) {
            repo.doneEngagement(item.id, did, draftId, edited?.takeIf { it != original })
        }
    }

    fun skipItem(item: EngagementItem) {
        perform("Couldn't skip that. Try again.", after = { selectedId = null; refresh() }) { repo.skipEngagement(item.id) }
    }

    @Composable
    fun detailFor(entry: EngagementItem) {
        EngagementDetail(
            entry = entry,
            busy = busy,
            edits = edits,
            showBack = !twoPane,
            onBack = { selectedId = null },
            onOpen = { openItem(entry) },
            onDraft = { draftItem(entry) },
            onCopy = { draftId, text -> copyDraft(entry, draftId, text) },
            onCopyAndOpen = { draftId, text -> copyAndOpenDraft(entry, draftId, text) },
            onDone = { did -> doneItem(entry, did) },
            onSkip = { skipItem(entry) },
        )
    }

    @Composable
    fun queueList(status: EngagementStatus) {
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
            modifier = Modifier.fillMaxSize(),
        ) {
            // Collapsed by default once there is a queue to work: the pacing line and first card stay above the fold.
            var showAdd by rememberSaveable { mutableStateOf(status.queue.isEmpty()) }
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    Text(engagementTodayLine(status), style = MaterialTheme.typography.bodySmall, color = TextTertiary)
                    engagementSpacingLine(status)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Warning) }
                }
                if (status.queue.isEmpty()) {
                    item {
                        PolishedEmptyState(icon = Icons.Filled.ThumbUp, headline = "All caught up", subtitle = engagementEmptyMessage(status))
                    }
                }
                itemsIndexed(status.queue, key = { _, item -> item.id }) { index, item ->
                    if (twoPane) {
                        SelectableRow(selected = item.id == selected?.id, onClick = { selectedId = item.id }) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Pill(engagementPlatformLabel(item.platform), TextSecondary)
                                Pill(if (item.drafts.isEmpty()) "DRAFT PENDING" else "READY: ${item.drafts.size} DRAFTS", Accent)
                            }
                            Spacer(Modifier.height(4.dp))
                            RowTitleSubtitle(item.title, item.creatorName)
                            item.blockMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Warning, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                        }
                    } else {
                        GrowthCard(accentBar = Accent, onClick = { selectedId = item.id }) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Pill(engagementPlatformLabel(item.platform), TextSecondary)
                                Pill(if (item.drafts.isEmpty()) "DRAFT PENDING" else "READY: ${item.drafts.size} DRAFTS", Accent)
                            }
                            Spacer(Modifier.height(6.dp))
                            Text(item.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, color = TextPrimary)
                            Text(item.creatorName, style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                            item.drafts.firstOrNull()?.let {
                                Spacer(Modifier.height(4.dp))
                                Text(it.text, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis, color = TextSecondary)
                            }
                            item.blockMessage?.let {
                                Spacer(Modifier.height(4.dp))
                                Text(it, style = MaterialTheme.typography.bodySmall, color = Warning)
                            }
                            // The next one up gets its primary actions right on the card, so the cover screen's first
                            // viewport already has Copy / Copy + open. The full detail (edit, Done, Skip) is one tap away.
                            val firstDraft = item.drafts.firstOrNull()
                            if (index == 0 && firstDraft != null && item.blockMessage == null) {
                                val text = edits["${item.id}/${firstDraft.id}"] ?: firstDraft.text
                                Spacer(Modifier.height(8.dp))
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    SecondaryButton(
                                        text = "Copy",
                                        onClick = { copyDraft(item, firstDraft.id, text) },
                                        enabled = !busy && text.isNotBlank(),
                                        modifier = Modifier.weight(1f),
                                    )
                                    PrimaryButton(
                                        text = "Copy + open video",
                                        onClick = { copyAndOpenDraft(item, firstDraft.id, text) },
                                        enabled = !busy && text.isNotBlank(),
                                        modifier = Modifier.weight(1f),
                                    )
                                }
                            }
                        }
                    }
                }
                item {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .clickable { showAdd = !showAdd }
                            .padding(top = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Add one yourself", style = MaterialTheme.typography.labelMedium, color = TextTertiary)
                            Text(
                                "The queue fills itself. Use these to add a video or a creator on top.",
                                style = MaterialTheme.typography.bodySmall,
                                color = TextTertiary,
                            )
                        }
                        Icon(
                            if (showAdd) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                            contentDescription = if (showAdd) "Hide the add controls" else "Show the add controls",
                            tint = TextTertiary,
                        )
                    }
                }
                if (showAdd) {
                    item {
                        AddRow(
                            label = "Paste a TikTok or YouTube link",
                            value = linkText,
                            button = "Add",
                            enabled = !busy && linkText.isNotBlank(),
                            onChange = { linkText = it },
                            onSubmit = {
                                perform("Couldn't add that link. Check it and try again.", after = { linkText = ""; refresh() }) {
                                    repo.addEngagementLink(linkText)
                                }
                            },
                        )
                    }
                    item {
                        AddRow(
                            label = "Watch a creator (@handle or channel id) or a search",
                            value = watchText,
                            button = "Watch",
                            enabled = !busy && watchText.isNotBlank(),
                            onChange = { watchText = it },
                            onSubmit = {
                                perform("Couldn't add that. Check it and try again.", after = { watchText = ""; refresh() }) {
                                    repo.addEngagementWatch(watchText)
                                }
                            },
                        )
                    }
                    item {
                        SecondaryButton(
                            text = if (discovering) "Finding..." else "Find new videos",
                            enabled = !busy && !discovering && status.youtubeConfigured,
                            onClick = {
                                scope.launch {
                                    discovering = true
                                    try {
                                        val result = repo.discoverEngagement()
                                        actionError = null
                                        refresh()
                                        snackbarHostState.showSnackbar(
                                            result.stoppedReason ?: "Added ${result.added} video${if (result.added == 1) "" else "s"}.",
                                        )
                                    } catch (e: Exception) {
                                        actionError = failure(e, "Couldn't search YouTube. Try again.")
                                    }
                                    discovering = false
                                }
                            },
                        )
                        if (!status.youtubeConfigured) {
                            Text(
                                "YouTube discovery needs YOUTUBE_API_KEY on the server.",
                                style = MaterialTheme.typography.bodySmall,
                                color = TextTertiary,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                        }
                    }
                }
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            ScreenHeader(
                "Engage",
                "Thoughtful comments on other creators' videos. Drafted for you, posted by you.",
                kicker = current?.takeIf { it.configured && it.queue.isNotEmpty() }?.let { "${it.queue.size} to review" },
                dense = true,
            )
            (errorMessage ?: actionError)?.let { message ->
                Row(modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(message, style = MaterialTheme.typography.bodyMedium, color = Danger, modifier = Modifier.weight(1f))
                    if (errorMessage != null) TextButton(onClick = { scope.launch { refresh() } }) { Text("Retry") }
                    else TextButton(onClick = { actionError = null }) { Text("Dismiss") }
                }
            }

            if (!loaded) {
                SkeletonListLoading()
            } else if (current == null) {
                PolishedEmptyState(icon = Icons.Filled.ThumbUp, headline = "Nothing to show yet", subtitle = "Pull down to try again.")
            } else if (!current.configured) {
                PolishedEmptyState(
                    icon = Icons.Filled.ThumbUp,
                    headline = "Engage isn't set up yet",
                    subtitle = current.message ?: "The database step (migration 0050) hasn't been applied on the server.",
                )
            } else if (twoPane) {
                TwoPane(
                    list = { queueList(current) },
                    detail = {
                        if (selected != null) detailFor(selected)
                        else DetailPlaceholder(
                            title = if (current.queue.isEmpty()) "Nothing to review" else "Pick a video",
                            hint = if (current.queue.isEmpty()) "New videos land in the queue on their own." else "Its drafted comments, Copy and Done show here.",
                        )
                    },
                )
            } else if (selected != null) {
                detailFor(selected)
            } else {
                queueList(current)
            }
        }
        SnackbarHost(hostState = snackbarHostState, modifier = Modifier.align(Alignment.BottomCenter))
    }
}

@Composable
private fun AddRow(label: String, value: String, button: String, enabled: Boolean, onChange: (String) -> Unit, onSubmit: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            label = { Text(label) },
            singleLine = true,
            modifier = Modifier.weight(1f),
            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Accent, cursorColor = Accent, unfocusedBorderColor = Border),
        )
        TextButton(onClick = onSubmit, enabled = enabled) { Text(button, color = Accent) }
    }
}

@Composable
private fun EngagementDetail(
    entry: EngagementItem,
    busy: Boolean,
    edits: MutableMap<String, String>,
    showBack: Boolean,
    onBack: () -> Unit,
    onOpen: () -> Unit,
    onDraft: () -> Unit,
    onCopy: (draftId: String, text: String) -> Unit,
    onCopyAndOpen: (draftId: String, text: String) -> Unit,
    onDone: (did: String) -> Unit,
    onSkip: () -> Unit,
) {
    val limit = engagementCharLimit(entry.platform)
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            if (showBack) TextButton(onClick = onBack, contentPadding = PaddingValues(0.dp)) { Text("Back to queue", color = Accent) }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { Pill(engagementPlatformLabel(entry.platform), TextSecondary) }
            Spacer(Modifier.height(6.dp))
            Text(entry.title, style = MaterialTheme.typography.titleLarge, color = TextPrimary)
            Text(entry.creatorName, style = MaterialTheme.typography.bodyMedium, color = TextSecondary)
            entry.blockMessage?.let {
                Spacer(Modifier.height(6.dp))
                Text(it, style = MaterialTheme.typography.bodyMedium, color = Warning)
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton(text = "Open video", onClick = onOpen, enabled = !busy, modifier = Modifier.weight(1f))
                PrimaryButton(
                    text = if (entry.drafts.isEmpty()) "Draft comments" else "Redraft",
                    onClick = onDraft,
                    busy = busy,
                    enabled = entry.blockMessage == null,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        if (entry.topComments.isNotEmpty()) {
            item {
                Text("TOP COMMENTS", style = MaterialTheme.typography.labelMedium, color = TextTertiary)
                entry.topComments.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = TextSecondary, modifier = Modifier.padding(top = 2.dp)) }
            }
        }
        items(entry.drafts, key = { it.id }) { draft ->
            val key = "${entry.id}/${draft.id}"
            val text = edits[key] ?: draft.text
            GrowthCard {
                Text("OPTION ${draft.id.removePrefix("d")}", style = MaterialTheme.typography.labelMedium, color = Accent)
                Spacer(Modifier.height(4.dp))
                OutlinedTextField(
                    value = text,
                    onValueChange = { edits[key] = it },
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = MaterialTheme.typography.bodyMedium,
                    colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Accent, cursorColor = Accent, unfocusedBorderColor = Border),
                )
                Text(
                    "${text.length} / $limit",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (text.length > limit) Danger else TextTertiary,
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.End,
                )
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton(
                        text = "Copy",
                        onClick = { onCopy(draft.id, text) },
                        enabled = !busy && entry.blockMessage == null && text.isNotBlank(),
                        modifier = Modifier.weight(1f),
                    )
                    PrimaryButton(
                        text = "Copy + open video",
                        onClick = { onCopyAndOpen(draft.id, text) },
                        enabled = !busy && entry.blockMessage == null && text.isNotBlank(),
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        item {
            Text(
                "Paste the copied text into the comment box yourself, then tap Done.",
                style = MaterialTheme.typography.bodySmall,
                color = TextTertiary,
            )
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryButton(text = "Done: commented", onClick = { onDone("commented") }, enabled = !busy, modifier = Modifier.weight(1f))
                SecondaryButton(text = "Done: liked", onClick = { onDone("liked") }, enabled = !busy, modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(6.dp))
            SecondaryButton(text = "Skip", onClick = onSkip, enabled = !busy, modifier = Modifier.fillMaxWidth(), contentColor = TextSecondary)
        }
    }
}
