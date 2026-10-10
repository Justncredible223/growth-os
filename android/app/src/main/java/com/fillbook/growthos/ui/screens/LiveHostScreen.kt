package com.fillbook.growthos.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.fillbook.growthos.data.GrowthOsRepository
import com.fillbook.growthos.data.LiveHostFeedItem
import com.fillbook.growthos.data.LiveHostSession
import com.fillbook.growthos.data.LiveHostStatus
import com.fillbook.growthos.data.authErrorMessage
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.PolishedEmptyState
import com.fillbook.growthos.ui.components.PrimaryButton
import com.fillbook.growthos.ui.components.QuietStatusLabel
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.SectionHeader
import com.fillbook.growthos.ui.components.SkeletonListLoading
import com.fillbook.growthos.ui.components.StatusTone
import com.fillbook.growthos.ui.components.platformDisplayName
import com.fillbook.growthos.ui.components.relativeTime
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary
import com.fillbook.growthos.ui.theme.Warning
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale

/** How often the tab refreshes while the host is switched on, so the feed follows the stream. */
internal const val LIVE_HOST_POLL_MILLIS = 5_000L

/** The one-line state shown under the switch. Pure so the wording is unit-testable. */
internal fun liveHostHeadline(status: LiveHostStatus): Pair<String, StatusTone> {
    val settings = status.settings ?: return "Not set up yet" to StatusTone.WAITING
    val session = status.session
    return when {
        status.systemPaused && settings.switchedOn -> "Held: the system is paused" to StatusTone.BLOCKED
        !settings.switchedOn -> "Off" to StatusTone.NEUTRAL
        session == null -> "Switched on, waiting for the PC worker" to StatusTone.WAITING
        !session.workerOnline -> "PC worker stopped responding" to StatusTone.FAILED
        status.budgetReached -> "Live, but quiet: daily budget reached" to StatusTone.BLOCKED
        else -> "Live" to StatusTone.ACTIVE
    }
}

internal fun liveHostFeedStatus(item: LiveHostFeedItem): Pair<String, StatusTone> = when {
    item.isHostLine && item.status == "spoken" -> "Said on stream" to StatusTone.READY
    item.isHostLine && item.status == "queued" -> "Saying now" to StatusTone.ACTIVE
    item.isHostLine -> "Not said" to StatusTone.SKIPPED
    item.status == "answered" -> "Answered" to StatusTone.READY
    item.status == "pending" -> "Waiting" to StatusTone.WAITING
    item.status == "blocked" -> "Blocked" to StatusTone.BLOCKED
    else -> "Skipped" to StatusTone.SKIPPED
}

/**
 * Live Host: the owner's switch for the AI character that hosts their live stream, and the record of every
 * chat message it saw and every line it said. The switch here is the only way to turn the host on: the PC
 * worker cannot, and the server only lets the character speak while it is on (see
 * docs/EXTERNAL_WRITE_FIREWALL.md, "Live Host exception").
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveHostScreen(repo: GrowthOsRepository) {
    var status by remember { mutableStateOf<LiveHostStatus?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var switchInFlight by remember { mutableStateOf(false) }
    var showGoLiveConfirm by remember { mutableStateOf(false) }
    var youtubeDraft by remember { mutableStateOf("") }
    var youtubeTouched by remember { mutableStateOf(false) }
    var savingYoutube by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try {
            val fresh = repo.getLiveHostStatus()
            status = fresh
            if (!youtubeTouched) youtubeDraft = fresh.settings?.youtubeVideoId ?: ""
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = authErrorMessage(e) ?: "Couldn't load the Live Host. Check your connection and try again."
        }
        loaded = true
    }

    fun setSwitch(on: Boolean) {
        if (switchInFlight) return
        scope.launch {
            switchInFlight = true
            try {
                repo.setLiveHostSwitch(on)
                actionError = null
                refresh()
            } catch (e: Exception) {
                actionError = authErrorMessage(e) ?: if (on) "Couldn't switch the host on. Try again." else "Couldn't switch the host off. Try again, or close the worker on the PC."
            } finally {
                switchInFlight = false
            }
        }
    }

    fun saveYoutube() {
        if (savingYoutube) return
        scope.launch {
            savingYoutube = true
            try {
                repo.setLiveHostYoutubeVideo(youtubeDraft.trim())
                youtubeTouched = false
                actionError = null
                refresh()
            } catch (e: Exception) {
                actionError = authErrorMessage(e) ?: "That doesn't look like a YouTube video link. Paste the link to your live stream."
            } finally {
                savingYoutube = false
            }
        }
    }

    LaunchedEffect(Unit) { refresh() }

    val switchedOn = status?.settings?.switchedOn == true
    LaunchedEffect(switchedOn) {
        while (switchedOn) {
            delay(LIVE_HOST_POLL_MILLIS)
            refresh()
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        val current = status
        ScreenHeader(
            "Live Host",
            "${current?.hostName ?: "Tilt"} hosts your live stream: reads chat and answers out loud.",
            kicker = current?.session?.let { "${it.messagesAnswered} answered" },
        )

        errorMessage?.let { message ->
            Row(modifier = Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(message, style = MaterialTheme.typography.bodyMedium, color = Danger, modifier = Modifier.weight(1f))
                TextButton(onClick = { scope.launch { refresh() } }) { Text("Retry") }
            }
        }

        if (!loaded) {
            SkeletonListLoading()
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
                    if (current == null) {
                        item {
                            PolishedEmptyState(icon = Icons.Filled.Podcasts, headline = "Nothing to show yet", subtitle = "Pull down to try again.")
                        }
                    } else if (!current.configured) {
                        item {
                            PolishedEmptyState(
                                icon = Icons.Filled.Podcasts,
                                headline = "Live Host isn't set up yet",
                                subtitle = "The database step (migration 0049) hasn't been applied on the server. Once it is, the switch appears here.",
                            )
                        }
                    } else {
                        item {
                            SwitchCard(
                                status = current,
                                enabled = !switchInFlight,
                                onToggle = { if (current.settings?.switchedOn == true) setSwitch(false) else showGoLiveConfirm = true },
                            )
                        }
                        actionError?.let { message ->
                            item { Text(message, style = MaterialTheme.typography.bodyMedium, color = Danger) }
                        }
                        current.session?.let { session -> item { SessionCard(session, current) } }
                        if (current.session == null) {
                            current.lastSession?.let { last ->
                                item {
                                    Text(
                                        "Last stream ended ${relativeTime(last.endedAt ?: last.startedAt) ?: ""}" + (last.endedReason?.let { " ($it)" } ?: ""),
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = TextTertiary,
                                    )
                                }
                            }
                        }
                        item {
                            YoutubeCard(
                                value = youtubeDraft,
                                saved = current.settings?.youtubeVideoId,
                                saving = savingYoutube,
                                onChange = { youtubeDraft = it; youtubeTouched = true },
                                onSave = ::saveYoutube,
                            )
                        }
                        item { SectionHeader(if (current.session != null) "This stream" else "Last stream") }
                        if (current.feed.isEmpty()) {
                            item {
                                Text(
                                    "Chat messages and everything ${current.hostName} says will appear here.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = TextTertiary,
                                )
                            }
                        } else {
                            items(current.feed, key = { (if (it.isHostLine) "u" else "m") + it.id }) { item -> FeedRow(item, current.hostName) }
                        }
                        item { Spacer(Modifier.height(16.dp)) }
                    }
                }
            }
        }
    }

    if (showGoLiveConfirm) {
        AlertDialog(
            onDismissRequest = { showGoLiveConfirm = false },
            title = { Text("Switch the Live Host on?") },
            text = {
                Text(
                    "${status?.hostName ?: "Tilt"} will start answering chat out loud on your stream, on its own, as soon as the PC worker is running. " +
                        "Every line is checked first and recorded here. Switch off at any time to stop it.",
                )
            },
            confirmButton = { TextButton(onClick = { showGoLiveConfirm = false; setSwitch(true) }) { Text("Switch on") } },
            dismissButton = { TextButton(onClick = { showGoLiveConfirm = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SwitchCard(status: LiveHostStatus, enabled: Boolean, onToggle: () -> Unit) {
    val on = status.settings?.switchedOn == true
    val (headline, tone) = liveHostHeadline(status)
    GrowthCard(accentBar = if (on) Accent else null) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.weight(1f)) {
                Text("${status.hostName} on air", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(4.dp))
                QuietStatusLabel(if (enabled) headline else "Updating...", tone)
            }
            // The switch is the only actionable control here, so it carries the spoken label.
            Switch(
                checked = on,
                onCheckedChange = { onToggle() },
                enabled = enabled,
                modifier = Modifier.semantics { contentDescription = if (on) "Live Host, on" else "Live Host, off" },
            )
        }
        if (on && status.session == null) {
            Spacer(Modifier.height(8.dp))
            Text(
                "Start the worker on your PC (npm run live-host) with OBS open. It picks the switch up within a few seconds.",
                style = MaterialTheme.typography.bodyMedium,
                color = TextSecondary,
            )
        }
    }
}

@Composable
private fun SessionCard(session: LiveHostSession, status: LiveHostStatus) {
    GrowthCard {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Stat("Seen", session.messagesSeen.toString())
            Stat("Answered", session.messagesAnswered.toString())
            Stat("Waiting", session.messagesPending.toString())
            Stat("Blocked", session.messagesBlocked.toString())
        }
        Spacer(Modifier.height(12.dp))
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Stat("Lines said", session.linesSpoken.toString())
            Stat("Fillbook mentions", session.fillbookMentions.toString())
            Stat(
                "Spend today",
                String.format(Locale.US, "$%.2f / $%.2f", status.todaySpendUsd, status.settings?.dailyBudgetUsd ?: 0.0),
                warn = status.budgetReached,
            )
        }
        Spacer(Modifier.height(10.dp))
        Text(
            "Started ${relativeTime(session.startedAt) ?: ""} · worker last seen ${relativeTime(session.lastHeartbeatAt) ?: ""}",
            style = MaterialTheme.typography.labelMedium,
            color = TextTertiary,
        )
    }
}

@Composable
private fun Stat(label: String, value: String, warn: Boolean = false) {
    Column {
        Text(value, style = MaterialTheme.typography.titleMedium, color = if (warn) Warning else MaterialTheme.colorScheme.onBackground)
        Text(label, style = MaterialTheme.typography.labelMedium, color = TextTertiary)
    }
}

@Composable
private fun YoutubeCard(value: String, saved: String?, saving: Boolean, onChange: (String) -> Unit, onSave: () -> Unit) {
    GrowthCard {
        Text("YouTube chat", style = MaterialTheme.typography.titleMedium)
        Text(
            if (saved == null) "Paste the link to your YouTube live stream so the host can read its chat." else "Reading chat from video $saved.",
            style = MaterialTheme.typography.bodyMedium,
            color = TextTertiary,
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            label = { Text("YouTube live link") },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        PrimaryButton(if (value.isBlank() && saved != null) "Clear" else "Save", onClick = onSave, enabled = value.trim() != (saved ?: ""), busy = saving)
    }
}

@Composable
private fun FeedRow(item: LiveHostFeedItem, hostName: String) {
    val (label, tone) = liveHostFeedStatus(item)
    GrowthCard(accentBar = if (item.isHostLine) Accent else null) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (item.isHostLine) hostName else listOfNotNull(item.authorName, item.platform?.let { platformDisplayName(it) }).joinToString(" · "),
                style = MaterialTheme.typography.labelLarge,
                color = if (item.isHostLine) Accent else TextSecondary,
                modifier = Modifier.weight(1f),
            )
            QuietStatusLabel(label, tone)
        }
        Spacer(Modifier.height(6.dp))
        Text(item.text, style = MaterialTheme.typography.bodyMedium)
        val detail = listOfNotNull(
            relativeTime(item.at),
            item.statusReason,
            if (item.mentionsFillbook) "mentions Fillbook" else null,
            item.segment?.let { "segment: ${it.replace('_', ' ')}" },
        ).joinToString(" · ")
        if (detail.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text(detail, style = MaterialTheme.typography.labelMedium, color = TextTertiary)
        }
    }
}
