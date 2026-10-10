package com.fillbook.growthos.ui.screens

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
        "Paste a TikTok or YouTube link above, or add a creator to the watchlist and tap Find new videos."
    } else {
        "Paste a TikTok link above. YouTube discovery turns on once YOUTUBE_API_KEY is set on the server."
    }

/**
 * Engage: other creators' Shorts and TikToks worth a thoughtful comment, with drafted options. Same guarantee as
 * every screen here: nothing posts from the app. "Open" and "Copy" hand the owner the link and the text; the owner
 * posts natively and then taps Done, which only records it. The server enforces the daily cap, the gap between
 * actions and the per-creator cooldown, and the screen shows its refusals as written.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EngagementScreen(repo: GrowthOsRepository) {
    var status by remember { mutableStateOf<EngagementStatus?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var selectedId by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var discovering by remember { mutableStateOf(false) }
    var linkText by remember { mutableStateOf("") }
    var watchText by remember { mutableStateOf("") }
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

    val current = status
    val selected = current?.queue?.firstOrNull { it.id == selectedId }
    BackHandler(enabled = selected != null) { selectedId = null }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            ScreenHeader(
                "Engage",
                "Thoughtful comments on other creators' videos. Drafted for you, posted by you.",
                kicker = current?.takeIf { it.configured && it.queue.isNotEmpty() }?.let { "${it.queue.size} to review" },
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
            } else if (selected != null) {
                EngagementDetail(
                    entry = selected,
                    busy = busy,
                    edits = edits,
                    onBack = { selectedId = null },
                    onOpen = {
                        perform("Couldn't open that video. Try again.") {
                            val url = repo.openEngagement(selected.id)
                            if (!openExternalUrl(context, url)) actionError = "No app could open that link."
                        }
                    },
                    onDraft = {
                        perform("Couldn't draft comments. Check your connection and try again.", after = { refresh() }) {
                            repo.draftEngagement(selected.id)
                        }
                    },
                    onCopy = { draftId, text ->
                        perform("Couldn't copy that. Try again.") {
                            val result = repo.copyEngagement(selected.id, draftId, text)
                            copyToClipboard(context, "Comment", result.text)
                            copiedDraft[selected.id] = draftId
                            val warning = result.warnings.firstOrNull()
                            snackbarHostState.showSnackbar(warning ?: "Copied. Paste it into the comment box yourself.")
                        }
                    },
                    onDone = { did ->
                        val draftId = copiedDraft[selected.id]
                        val edited = draftId?.let { edits["${selected.id}/$it"] }
                        val original = selected.drafts.firstOrNull { it.id == draftId }?.text
                        perform("Couldn't record that. Try again.", after = { selectedId = null; refresh() }) {
                            repo.doneEngagement(selected.id, did, draftId, edited?.takeIf { it != original })
                        }
                    },
                    onSkip = {
                        perform("Couldn't skip that. Try again.", after = { selectedId = null; refresh() }) { repo.skipEngagement(selected.id) }
                    },
                )
            } else {
                PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        item {
                            Text(engagementTodayLine(current), style = MaterialTheme.typography.bodySmall, color = TextTertiary)
                            engagementSpacingLine(current)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Warning) }
                        }
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
                                enabled = !busy && !discovering && current.youtubeConfigured,
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
                            if (!current.youtubeConfigured) {
                                Text(
                                    "YouTube discovery needs YOUTUBE_API_KEY on the server.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = TextTertiary,
                                    modifier = Modifier.padding(top = 4.dp),
                                )
                            }
                        }
                        if (current.queue.isEmpty()) {
                            item {
                                PolishedEmptyState(icon = Icons.Filled.ThumbUp, headline = "Queue is clear", subtitle = engagementEmptyMessage(current))
                            }
                        }
                        items(current.queue, key = { it.id }) { item ->
                            GrowthCard(accentBar = Accent, onClick = { selectedId = item.id }) {
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Pill(engagementPlatformLabel(item.platform), TextSecondary)
                                    Pill(if (item.drafts.isEmpty()) "NEEDS DRAFT" else "${item.drafts.size} DRAFTS", Accent)
                                }
                                Spacer(Modifier.height(6.dp))
                                Text(item.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, color = TextPrimary)
                                Text(item.creatorName, style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                                item.blockMessage?.let {
                                    Spacer(Modifier.height(4.dp))
                                    Text(it, style = MaterialTheme.typography.bodySmall, color = Warning)
                                }
                            }
                        }
                    }
                }
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
    onBack: () -> Unit,
    onOpen: () -> Unit,
    onDraft: () -> Unit,
    onCopy: (draftId: String, text: String) -> Unit,
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
            TextButton(onClick = onBack, contentPadding = PaddingValues(0.dp)) { Text("Back to queue", color = Accent) }
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
                SecondaryButton(
                    text = "Copy",
                    onClick = { onCopy(draft.id, text) },
                    enabled = !busy && entry.blockMessage == null && text.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                )
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
