package com.fillbook.growthos.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachMoney
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Nightlight
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
import com.fillbook.growthos.data.EveningReport
import com.fillbook.growthos.data.GrowthOsRepository
import com.fillbook.growthos.data.authErrorMessage
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.MetricTile
import com.fillbook.growthos.ui.components.PolishedEmptyState
import com.fillbook.growthos.ui.components.ScreenHeader
import com.fillbook.growthos.ui.components.SkeletonListLoading
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.TextSecondary
import kotlinx.coroutines.launch

/**
 * Recap of the trailing 24h -- real counts only. A quiet day shows real
 * zeros, never a fabricated "great progress today!" gloss.
 *
 * Tap-to-navigate (2026-09-07): top opportunity card is informational (Radar was removed).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EveningReportScreen(repo: GrowthOsRepository, onNavigate: (String) -> Unit = {}) {
    var report by remember { mutableStateOf<EveningReport?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try {
            report = repo.getEveningReport()
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = authErrorMessage(e) ?: "Couldn't load the evening report. Check your connection and try again."
        }
        loaded = true
    }

    LaunchedEffect(Unit) { refresh() }

    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        ScreenHeader("Evening Report", "Today's activity, recapped.")

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
                val current = report
                if (current == null) {
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        item {
                            PolishedEmptyState(icon = Icons.Filled.Nightlight, headline = "No report yet", subtitle = "Check back after today's activity settles.")
                        }
                    }
                } else {
                    LazyColumn(contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        item {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                MetricTile("Drafted today", current.assetsDrafted.toString(), Icons.Filled.CheckCircle, modifier = Modifier.weight(1f))
                                MetricTile("LLM spend today", "$%.2f".format(current.costTodayUsd), Icons.Filled.AttachMoney, modifier = Modifier.weight(1f))
                            }
                        }
                        item {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                MetricTile("Approved / Rejected", "${current.approvedToday} / ${current.rejectedToday}", Icons.Filled.CheckCircle, modifier = Modifier.weight(1f))
                                MetricTile("Inbound resolved", current.inboundResolvedToday.toString(), Icons.Filled.Inbox, modifier = Modifier.weight(1f))
                            }
                        }
                        current.reviewPassRate?.let { rate ->
                            item {
                                GrowthCard {
                                    Text("Review pass rate today: ${(rate * 100).toInt()}%", style = MaterialTheme.typography.titleMedium)
                                }
                            }
                        }
                        current.topOpportunity?.let { opp ->
                            item {
                                GrowthCard {
                                    Text("Top new opportunity", style = MaterialTheme.typography.labelMedium, color = TextSecondary)
                                    Text("${opp.title} (score ${opp.score.toInt()})", style = MaterialTheme.typography.titleMedium)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
