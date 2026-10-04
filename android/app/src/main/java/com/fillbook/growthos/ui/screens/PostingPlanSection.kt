package com.fillbook.growthos.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.fillbook.growthos.data.PlanSlot
import com.fillbook.growthos.data.PlanVideo
import com.fillbook.growthos.data.PostingPlan
import com.fillbook.growthos.data.PostingPlatform
import com.fillbook.growthos.ui.components.GrowthCard
import com.fillbook.growthos.ui.components.QuietStatusLabel
import com.fillbook.growthos.ui.components.StatusTone
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Success
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary

/** "06:30" -> "6:30 AM", "17:30" -> "5:30 PM". */
internal fun slotLabel(time: String): String {
    val (h, m) = time.split(":").map { it.toInt() }
    val hour12 = if (h % 12 == 0) 12 else h % 12
    return "$hour12:${m.toString().padStart(2, '0')} ${if (h < 12) "AM" else "PM"}"
}

internal fun slotStatusLabel(slot: PlanSlot): Pair<String, StatusTone> = when (slot.status) {
    "done" -> "Posted everywhere" to StatusTone.READY
    "due" -> (if (slot.remaining.size == PostingPlatform.entries.size) "Post now" else "${slot.remaining.size} left to post") to StatusTone.WAITING
    "upcoming" -> "Up next" to StatusTone.NEUTRAL
    else -> "No video ready" to StatusTone.SKIPPED
}

/**
 * Today's posting slot, at the top of Video Status (owner request 2026-09-25). Each slot's video shows one chip per
 * platform: a check when its link is saved, otherwise a tap to add the link after posting.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PostingPlanCard(plan: PostingPlan, onAddLink: (PlanVideo, PostingPlatform) -> Unit) {
    GrowthCard(accentBar = Accent) {
        Text("Today's posting plan", style = MaterialTheme.typography.titleMedium)
        Text("One video a day, Arizona time. Add each link after you post.", style = MaterialTheme.typography.bodySmall, color = TextSecondary)
        Spacer(Modifier.height(10.dp))
        plan.slots.forEachIndexed { i, slot ->
            if (i > 0) Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(slotLabel(slot.time), style = MaterialTheme.typography.labelLarge, modifier = Modifier.width(72.dp))
                val (label, tone) = slotStatusLabel(slot)
                QuietStatusLabel(label, tone)
            }
            val video = slot.video
            if (video != null) {
                Text(video.title, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 72.dp, top = 2.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(start = 64.dp)) {
                    PostingPlatform.entries.forEach { platform ->
                        val posted = video.posts.any { it.platform == platform }
                        TextButton(onClick = { onAddLink(video, platform) }) {
                            Text(if (posted) "✓ ${platform.label}" else "+ ${platform.label}", color = if (posted) Success else Accent, style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
            }
        }
        if (plan.backlog > 0) {
            Spacer(Modifier.height(8.dp))
            Text("${plan.backlog} more ready video${if (plan.backlog == 1) "" else "s"} waiting for the next days.", style = MaterialTheme.typography.bodySmall, color = TextTertiary)
        }
    }
}

/** Asks for the link of a video just posted to [platform]; saving again replaces the link. */
@Composable
fun AddPostLinkDialog(video: PlanVideo, platform: PostingPlatform, saving: Boolean, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    val existing = video.posts.firstOrNull { it.platform == platform }?.url.orEmpty()
    var url by remember(video.campaignAssetId, platform) { mutableStateOf(existing) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("${platform.label} link") },
        text = {
            Column {
                Text(video.title, style = MaterialTheme.typography.bodyMedium, color = TextSecondary)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = url, onValueChange = { url = it }, singleLine = true, placeholder = { Text("Paste the ${platform.label} link") }, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(url.trim()) }, enabled = !saving && url.trim().startsWith("http")) { Text(if (saving) "Saving..." else "Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
