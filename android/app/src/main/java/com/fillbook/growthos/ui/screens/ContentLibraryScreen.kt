package com.fillbook.growthos.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.fillbook.growthos.data.CampaignAsset
import com.fillbook.growthos.data.GrowthOsRepository
import com.fillbook.growthos.data.authErrorMessage
import com.fillbook.growthos.ui.components.CopyButton
import com.fillbook.growthos.ui.components.ExpandableText
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.IconPill
import com.fillbook.growthos.ui.components.Pill
import com.fillbook.growthos.ui.components.SkeletonListLoading
import com.fillbook.growthos.ui.components.PolishedEmptyState
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.QuietStatusLabel
import com.fillbook.growthos.ui.components.SectionHeader
import com.fillbook.growthos.ui.components.assetStageDisplayName
import com.fillbook.growthos.ui.components.assetStageTone
import com.fillbook.growthos.ui.components.assetTypeDisplayName
import com.fillbook.growthos.ui.components.assetTypeIcon
import com.fillbook.growthos.ui.components.reviewSummaryLabel
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.Success
import com.fillbook.growthos.ui.theme.Surface
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary
import com.fillbook.growthos.ui.theme.Warning
import kotlinx.coroutines.launch

/**
 * Every draft this system has produced, grouped by platform -- the same
 * real data as GET /api/campaigns (the former Campaigns screen), just organized
 * for browsing content instead of tracking pipeline progress. No new
 * endpoint: adding one would push this project over Vercel Hobby's
 * 12-serverless-function cap (see docs/PROGRESS_LEDGER.md Phase 15).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContentLibraryScreen(repo: GrowthOsRepository) {
    var allAssets by remember { mutableStateOf<List<CampaignAsset>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var stageFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try {
            val campaigns = repo.getCampaigns()
            allAssets = campaigns.flatMap { it.assets }.filter { it.latestBody != null }
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = authErrorMessage(e) ?: "Couldn't load the content library. Check your connection and try again."
        }
        loaded = true
    }

    LaunchedEffect(Unit) { refresh() }

    val stages = remember(allAssets) { allAssets.map { it.stage }.distinct().sorted() }
    val filtered = remember(allAssets, stageFilter) {
        stageFilter?.let { stage -> allAssets.filter { it.stage == stage } } ?: allAssets
    }
    val assetsByPlatform = remember(filtered) { filtered.groupBy { it.platform } }

    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        ScreenHeader(
            "Content Library",
            "Every draft the system has produced -- browse, copy, and reuse.",
            kicker = if (loaded && allAssets.isNotEmpty()) "${allAssets.size} draft${if (allAssets.size == 1) "" else "s"}" else null,
        )

        errorMessage?.let { message ->
            Row(modifier = Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(message, style = MaterialTheme.typography.bodyMedium, color = Danger, modifier = Modifier.weight(1f))
                TextButton(onClick = { scope.launch { refresh() } }) { Text("Retry") }
            }
        }

        if (!loaded) {
            SkeletonListLoading()
        } else if (errorMessage == null && allAssets.isEmpty()) {
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
                            icon = Icons.Filled.VideoLibrary,
                            headline = "No drafts produced yet",
                            subtitle = "Once an opportunity runs through the pipeline, drafts show up here.",
                        )
                    }
                }
            }
        } else {
            if (stages.size > 1) {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    item { StageFilterChip("All", stageFilter == null) { stageFilter = null } }
                    items(stages) { stage ->
                        StageFilterChip(assetStageDisplayName(stage), stageFilter == stage) { stageFilter = stage }
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    assetsByPlatform.entries.sortedByDescending { it.value.size }.forEach { (platform, assets) ->
                        item { SectionHeader("${com.fillbook.growthos.ui.components.platformDisplayName(platform)} (${assets.size})") }
                        items(assets) { asset -> LibraryCard(asset) }
                    }
                }
            }
        }
    }
}

@Composable
private fun StageFilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label) },
        colors = FilterChipDefaults.filterChipColors(
            selectedContainerColor = Accent.copy(alpha = 0.2f),
            selectedLabelColor = Accent,
            containerColor = Surface,
            labelColor = TextSecondary,
        ),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LibraryCard(asset: CampaignAsset) {
    GrowthCard {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            IconPill(assetTypeDisplayName(asset.assetType), assetTypeIcon(asset.assetType), TextSecondary)
            QuietStatusLabel(assetStageDisplayName(asset.stage), assetStageTone(asset.stage))
            if (asset.reviewPassCount + asset.reviewFailCount > 0) {
                Pill(
                    reviewSummaryLabel(asset.reviewPassCount, asset.reviewPassCount + asset.reviewFailCount),
                    if (asset.reviewFailCount == 0) Success else Warning,
                )
            }
        }
        Spacer(Modifier.height(10.dp))
        ExpandableText(asset.latestBody ?: "", style = MaterialTheme.typography.bodyMedium, color = TextSecondary, collapsedMaxLines = 3)
        asset.latestBody?.let { body ->
            Spacer(Modifier.height(10.dp))
            CopyButton(text = body, label = "${asset.platform} ${assetTypeDisplayName(asset.assetType)}")
        }
    }
}
