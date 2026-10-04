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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QueryStats
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.fillbook.growthos.data.GrowthOsRepository
import com.fillbook.growthos.data.PostResult
import com.fillbook.growthos.data.PostingResults
import com.fillbook.growthos.data.ReplyVisibility
import com.fillbook.growthos.data.VideoResult
import com.fillbook.growthos.data.authErrorMessage
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.LoadingIndicator
import com.fillbook.growthos.ui.components.PolishedEmptyState
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.SectionHeader
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.Success
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary
import kotlinx.coroutines.launch

/** 1234 -> "1,234", 15300 -> "15.3K", null -> "—". */
internal fun formatCount(n: Int?): String = when {
    n == null -> "—"
    n >= 1_000_000 -> String.format("%.1fM", n / 1_000_000.0)
    n >= 10_000 -> String.format("%.1fK", n / 1_000.0)
    else -> String.format("%,d", n)
}

/** The reply-visibility banner text and whether it's a warning (a warning is red, ok is green, else neutral). */
internal fun replyVisibilityMessage(v: ReplyVisibility): Pair<String, Boolean?> {
    fun median(d: Double?) = d?.let { if (it % 1.0 == 0.0) it.toInt().toString() else String.format("%.1f", it) } ?: "—"
    return when (v.status) {
        "dropped" -> "Your recent X replies are getting ${median(v.recentMedian)} views, against your normal ${median(v.baselineMedian)}. X may be limiting them: space replies out and reply to fresh posts." to true
        "ok" -> "X reply views look normal: ${median(v.recentMedian)} recently, against your usual ${median(v.baselineMedian)}." to false
        else -> "Not enough replies yet to judge reply views (needs 3 recent and 5 older replies)." to null
    }
}

/**
 * Results (owner request 2026-09-25): what each posted video and X reply actually did. YouTube numbers and X reply
 * views are pulled automatically 3 times a day; TikTok and Instagram numbers are typed in here, 2 days after posting.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ResultsScreen(repo: GrowthOsRepository) {
    var results by remember { mutableStateOf<PostingResults?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var statsTarget by remember { mutableStateOf<Pair<VideoResult, PostResult>?>(null) }
    var savingStats by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    suspend fun refresh() {
        try {
            results = repo.getPostingOverview().results
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = authErrorMessage(e) ?: e.message?.takeIf { it.isNotBlank() } ?: "Couldn't load results. Check your connection and try again."
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            ScreenHeader("Results", "How each video and X reply did. YouTube and X update on their own; add TikTok and Instagram numbers when asked.")
            PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } }, modifier = Modifier.fillMaxSize()) {
                val r = results
                when {
                    r == null && errorMessage != null -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                        item { Text(errorMessage!!, color = Danger, modifier = Modifier.padding(20.dp)) }
                    }
                    r == null -> LoadingIndicator()
                    else -> LazyColumn(contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        item(key = "visibility") {
                            val (message, warning) = replyVisibilityMessage(r.replyVisibility)
                            GrowthCard(accentBar = when (warning) { true -> Danger; false -> Success; null -> null }) {
                                Text("X reply views", style = MaterialTheme.typography.titleMedium)
                                Spacer(Modifier.height(4.dp))
                                Text(message, style = MaterialTheme.typography.bodyMedium, color = if (warning == true) Danger else TextSecondary)
                            }
                        }
                        val leaders = rankedVideos(r.videos)
                        if (leaders.size >= 2) {
                            item(key = "leaderboard") {
                                GrowthCard(accentBar = Success) {
                                    Text("Best so far", style = MaterialTheme.typography.titleMedium)
                                    Text("Total views across the platforms with numbers, last 30 days.", style = MaterialTheme.typography.bodySmall, color = TextSecondary)
                                    Spacer(Modifier.height(8.dp))
                                    leaders.forEachIndexed { i, video ->
                                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                                            Text("${i + 1}.", style = MaterialTheme.typography.labelLarge, modifier = Modifier.width(24.dp))
                                            Text(conceptHeading(video), style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                            Text("${formatCount(video.totalViews)} views", style = MaterialTheme.typography.labelLarge, color = Accent)
                                        }
                                    }
                                }
                            }
                        }
                        item(key = "videos-header") { SectionHeader("Videos, last 30 days") }
                        if (r.videos.isEmpty()) {
                            item(key = "videos-empty") {
                                PolishedEmptyState(icon = Icons.Filled.QueryStats, headline = "No posted videos yet", subtitle = "Add each link in Video Status after you post, and the numbers show up here.")
                            }
                        }
                        items(r.videos, key = { it.campaignAssetId }) { video ->
                            GrowthCard {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(conceptHeading(video), style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                    Text("${formatCount(video.totalViews)} views", style = MaterialTheme.typography.labelLarge, color = Accent)
                                }
                                Text("Posted ${video.firstPostedAt.take(10)}", style = MaterialTheme.typography.bodySmall, color = TextTertiary)
                                Spacer(Modifier.height(6.dp))
                                video.posts.forEach { post ->
                                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                                        Text(post.platform.label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(84.dp))
                                        Text(
                                            if (post.views == null && post.likes == null) "No numbers yet" else "${formatCount(post.views)} views · ${formatCount(post.likes)} likes · ${formatCount(post.comments)} comments",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = TextSecondary,
                                            modifier = Modifier.weight(1f),
                                        )
                                        if (post.platform != com.fillbook.growthos.data.PostingPlatform.YOUTUBE_SHORTS) {
                                            TextButton(onClick = { statsTarget = video to post }) {
                                                Text(statsButtonLabel(post), color = if (post.needsManualStats || post.needsDay7Stats) Accent else TextTertiary, style = MaterialTheme.typography.labelMedium)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        item(key = "x-header") { SectionHeader("Recent X replies") }
                        if (r.xReplies.isEmpty()) {
                            item(key = "x-empty") { Text("No replies tracked yet. They're read from X 3 times a day.", style = MaterialTheme.typography.bodySmall, color = TextTertiary) }
                        }
                        items(r.xReplies, key = { it.tweetId }) { reply ->
                            Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth()) {
                                Text(reply.text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                Spacer(Modifier.width(8.dp))
                                Text("${formatCount(reply.impressions)} views", style = MaterialTheme.typography.labelMedium, color = TextSecondary)
                            }
                        }
                        item(key = "bottom") { Spacer(Modifier.height(24.dp)) }
                    }
                }
            }
        }
        SnackbarHost(hostState = snackbarHostState, modifier = Modifier.align(Alignment.BottomCenter))
    }

    statsTarget?.let { (video, post) ->
        ManualStatsDialog(
            title = "${post.platform.label}: ${video.title}",
            initial = post,
            saving = savingStats,
            onSave = { views, likes, comments, shares ->
                scope.launch {
                    savingStats = true
                    try {
                        repo.recordPostStats(post.id, views, likes, comments, shares)
                        statsTarget = null
                        refresh()
                        snackbarHostState.showSnackbar("Stats saved.")
                    } catch (e: Exception) {
                        snackbarHostState.showSnackbar(e.message?.takeIf { it.isNotBlank() } ?: "Couldn't save the stats. Try again.")
                    }
                    savingStats = false
                }
            },
            onDismiss = { if (!savingStats) statsTarget = null },
        )
    }
}

/** "Day 5 · 5 contracts against a plan of 3": the concept's day in the daily order, when known. */
internal fun conceptHeading(video: VideoResult): String = if (video.day != null) "Day ${video.day} · ${video.title}" else video.title

/** The videos with numbers, best first (most total views), at most 5. Videos with no numbers yet are left out. */
internal fun rankedVideos(videos: List<VideoResult>): List<VideoResult> =
    videos.filter { (it.totalViews ?: 0) > 0 }.sortedByDescending { it.totalViews }.take(5)

internal fun statsButtonLabel(post: PostResult): String = when {
    post.needsManualStats -> "Add stats"
    post.needsDay7Stats -> "Add day-7 stats"
    else -> "Update"
}

/** Views, likes, comments and shares for one TikTok or Instagram post, as shown in that app's insights. */
@Composable
private fun ManualStatsDialog(title: String, initial: PostResult, saving: Boolean, onSave: (Int?, Int?, Int?, Int?) -> Unit, onDismiss: () -> Unit) {
    var views by remember { mutableStateOf(initial.views?.toString().orEmpty()) }
    var likes by remember { mutableStateOf(initial.likes?.toString().orEmpty()) }
    var comments by remember { mutableStateOf(initial.comments?.toString().orEmpty()) }
    var shares by remember { mutableStateOf(initial.shares?.toString().orEmpty()) }
    fun parse(s: String): Int? = s.filter { it.isDigit() }.takeIf { it.isNotEmpty() }?.toIntOrNull()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("Views" to views, "Likes" to likes, "Comments" to comments, "Shares" to shares).forEachIndexed { i, (label, value) ->
                    OutlinedTextField(
                        value = value,
                        onValueChange = { v -> when (i) { 0 -> views = v; 1 -> likes = v; 2 -> comments = v; else -> shares = v } },
                        label = { Text(label) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            val any = listOf(views, likes, comments, shares).any { parse(it) != null }
            TextButton(onClick = { onSave(parse(views), parse(likes), parse(comments), parse(shares)) }, enabled = any && !saving) { Text(if (saving) "Saving..." else "Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
