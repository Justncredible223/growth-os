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
import androidx.compose.material.icons.filled.History
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.fillbook.growthos.data.GrowthOsRepository
import com.fillbook.growthos.data.authErrorMessage
import com.fillbook.growthos.data.XFeedPostHistoryEntry
import com.fillbook.growthos.data.XFeedPostHistoryState
import com.fillbook.growthos.ui.components.CopyButton
import com.fillbook.growthos.ui.components.ExpandableText
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.PolishedEmptyState
import com.fillbook.growthos.ui.components.QuietStatusLabel
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.SkeletonListLoading
import com.fillbook.growthos.ui.components.StatusTone
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary
import kotlinx.coroutines.launch

/**
 * Previous X feed post drafts -- a ready-but-unposted prior day's post is a
 * recoverable draft, not lost the moment its operating date rolls over;
 * this is the reachable surface for it. Never shows today's own post
 * (that's Home's TodayXPostCard); GET ?resource=x-feed-post-history is
 * read-only -- Regenerate/Mark posted stay on Home.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun XFeedPostHistoryScreen(repo: GrowthOsRepository) {
    var entries by remember { mutableStateOf<List<XFeedPostHistoryEntry>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try {
            entries = repo.getTodayXPostHistory()
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = authErrorMessage(e) ?: "Couldn't load previous drafts. Check your connection and try again."
        }
        loaded = true
    }

    LaunchedEffect(Unit) { refresh() }

    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        ScreenHeader(
            "Previous Drafts",
            "Prior days' X feed posts -- recover an unposted draft, or see what happened.",
            kicker = if (loaded && entries.isNotEmpty()) "${entries.size} entr${if (entries.size == 1) "y" else "ies"}" else null,
        )

        errorMessage?.let { message ->
            Row(modifier = Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(message, style = MaterialTheme.typography.bodyMedium, color = Danger, modifier = Modifier.weight(1f))
                TextButton(onClick = { scope.launch { refresh() } }) { Text("Retry") }
            }
        }

        if (!loaded) {
            SkeletonListLoading()
        } else if (errorMessage == null && entries.isEmpty()) {
            // Same nested-scroll fix as Prospecting/Inbound/VideoStatus/etc.
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
                            icon = Icons.Filled.History,
                            headline = "Nothing here yet",
                            subtitle = "Prior days' X feed post attempts will show up here once there's history to look back on.",
                        )
                    }
                }
            }
        } else {
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(entries) { entry -> HistoryCard(entry) }
                }
            }
        }
    }
}

@Composable
private fun HistoryCard(entry: XFeedPostHistoryEntry) {
    GrowthCard {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(entry.operatingDate, style = MaterialTheme.typography.labelLarge, color = TextTertiary)
            when (entry.state) {
                XFeedPostHistoryState.UNPOSTED_DRAFT -> QuietStatusLabel("Unposted draft", StatusTone.WAITING)
                XFeedPostHistoryState.POSTED -> QuietStatusLabel("Posted", StatusTone.READY)
                XFeedPostHistoryState.FAILED -> QuietStatusLabel("Failed", StatusTone.BLOCKED)
            }
        }
        entry.topicLabel?.let { label ->
            Spacer(Modifier.height(4.dp))
            Text(label, style = MaterialTheme.typography.labelMedium, color = TextSecondary)
        }
        // Picture style test (real Fillbook screen vs drawn card): which picture this post was meant to carry.
        val arm = when (entry.pictureArm) {
            "screen" -> "Picture: real Fillbook screen"
            "drawn" -> "Picture: drawn card"
            else -> null
        }
        if (entry.state == XFeedPostHistoryState.POSTED && arm != null) {
            Spacer(Modifier.height(2.dp))
            Text(arm, style = MaterialTheme.typography.labelSmall, color = TextTertiary)
        }
        Spacer(Modifier.height(8.dp))
        when (entry.state) {
            XFeedPostHistoryState.FAILED -> {
                Text(
                    entry.reason ?: "No reason recorded.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextSecondary,
                    maxLines = 3,
                )
            }
            else -> {
                ExpandableText(entry.previewText ?: "", style = MaterialTheme.typography.bodyMedium, color = TextSecondary, collapsedMaxLines = 3)
                entry.previewText?.let { text ->
                    Spacer(Modifier.height(10.dp))
                    // An unposted draft from a prior day is still a real,
                    // reviewed, reusable candidate -- copy is the one
                    // action that makes sense here; recovering it into
                    // TODAY's slot would require a dedicated backend
                    // action this screen doesn't have (see release notes),
                    // so this stays read-only + copy for now.
                    CopyButton(text = text, label = "X feed post (${entry.operatingDate})")
                }
            }
        }
    }
}
