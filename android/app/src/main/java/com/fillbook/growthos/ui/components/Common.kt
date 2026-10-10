package com.fillbook.growthos.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Article
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Notes
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.SmartDisplay
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.fillbook.growthos.data.HealthStatus
import com.fillbook.growthos.data.InboundPriority
import com.fillbook.growthos.data.Urgency
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Background
import com.fillbook.growthos.ui.theme.Border
import com.fillbook.growthos.ui.theme.Danger
import com.fillbook.growthos.ui.theme.Success
import com.fillbook.growthos.ui.theme.Surface
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary
import com.fillbook.growthos.ui.theme.Warning

/**
 * One clipboard write, reused everywhere a drafted or curated piece of
 * text needs to leave this app -- Inbound replies, campaign/content
 * drafts. Nothing here ever posts anything itself; this only gets text
 * onto the clipboard so the owner can paste it into the reply box or
 * composer they already have open.
 */
fun copyToClipboard(context: Context, label: String, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
    // Android 13+ shows its own "Copied" system toast for clipboard writes;
    // older versions don't, so this is the only feedback the owner gets there.
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) {
        Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
    }
}

/** Small, consistent copy affordance for any card showing drafted/curated text. */
@Composable
fun CopyButton(text: String, label: String = "Draft", modifier: Modifier = Modifier) {
    val context = LocalContext.current
    OutlinedButton(onClick = { copyToClipboard(context, label, text) }, modifier = modifier) {
        Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text("Copy")
    }
}

@Composable
fun Pill(text: String, color: Color, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .background(color.copy(alpha = 0.16f), RoundedCornerShape(999.dp))
            .padding(PaddingValues(horizontal = 10.dp, vertical = 4.dp)),
    ) {
        Text(text = text, style = MaterialTheme.typography.labelMedium, color = color)
    }
}

/** Same shape as [Pill], with a small leading icon -- platform/asset-type chips read faster with a glyph than text alone. */
@Composable
fun IconPill(text: String, icon: ImageVector, color: Color, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .background(color.copy(alpha = 0.16f), RoundedCornerShape(999.dp))
            .padding(PaddingValues(horizontal = 10.dp, vertical = 4.dp)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.height(12.dp))
        Spacer(Modifier.width(4.dp))
        Text(text = text, style = MaterialTheme.typography.labelMedium, color = color)
    }
}

/**
 * Platform values come from the backend lowercase (matches the DB
 * check constraint: 'x', 'youtube', 'tiktok', 'blog', ...) -- fine for
 * logic, but "Open in x" reads as a typo in UI text. This gives every
 * screen the same real display name instead of each one guessing.
 *
 * platformIcon's glyphs are generic Material stand-ins for real
 * per-platform brand marks (no brand SVGs bundled in this app) -- close
 * enough to be a scannable visual anchor next to the platform name, not
 * meant as a logo.
 */
fun platformIcon(platform: String): ImageVector = when (platform.lowercase()) {
    "x" -> Icons.Filled.Tag
    "youtube" -> Icons.Filled.SmartDisplay
    "tiktok" -> Icons.Filled.MusicNote
    "instagram" -> Icons.Filled.CameraAlt
    "blog" -> Icons.Filled.Article
    else -> Icons.Filled.Public
}

/**
 * Opens a URL in whatever app handles it (X, a browser). Returns
 * false instead of throwing when nothing on the device can handle the
 * intent (no browser, a restricted profile) or the system refuses it --
 * callers show a visible error rather than letting the tap silently do
 * nothing or crash the screen.
 */
fun openExternalUrl(context: Context, url: String): Boolean = runCatching {
    context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
    true
}.getOrElse { false }

/**
 * Opens [url] in a web browser, never in the platform's own app. Prospecting's "Open in browser" uses this because the X
 * Android app (12.32, 2026-10) intercepts x.com links and shows a linked post as the first card of the For You feed instead
 * of the thread. The browser selector limits resolution to apps that handle a plain http page (real browsers), so the X app,
 * which only claims x.com hosts, is not offered. On Android 12+ a user who has set X's links to "open in app" may still be
 * routed to it; the button's label says "browser" and a failed launch is reported, not swallowed.
 */
fun openInBrowser(context: Context, url: String): Boolean = runCatching {
    val browserOnly = android.content.Intent(android.content.Intent.ACTION_VIEW)
        .addCategory(android.content.Intent.CATEGORY_BROWSABLE)
        .setData(android.net.Uri.fromParts("http", "", null))
    val target = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
        .addCategory(android.content.Intent.CATEGORY_BROWSABLE)
        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
    target.selector = browserOnly
    context.startActivity(target)
    true
}.getOrElse { false }

/** "video_script" -> "Video script", "post" -> "Post" -- same lowercase-DB-value pattern as platformDisplayName. */
fun assetTypeDisplayName(assetType: String): String =
    assetType.replace('_', ' ').replaceFirstChar { it.uppercase() }

fun assetTypeIcon(assetType: String): ImageVector = when (assetType) {
    "video_script" -> Icons.Filled.Movie
    "thread" -> Icons.Filled.Forum
    "article" -> Icons.Filled.Article
    else -> Icons.Filled.Notes
}

fun platformDisplayName(platform: String): String = when (platform.lowercase()) {
    "x" -> "X"
    "youtube" -> "YouTube"
    "tiktok" -> "TikTok"
    "instagram" -> "Instagram"
    else -> platform.replaceFirstChar { it.uppercase() }
}

/**
 * Builds a real profile URL for the Creators screen's "Open profile"
 * action -- there's no stored profile URL (creators only have a handle +
 * platform), so this constructs one the same way a person would type it
 * manually. Returns null rather than guessing when the platform isn't one
 * of the three this app actually tracks creators on, or the handle has
 * spaces/is otherwise not a real handle (e.g. a plain display name saved
 * for a creator with category "other") -- a broken link is worse than no
 * button at all.
 */
fun creatorProfileUrl(platform: String, handle: String): String? {
    val cleanHandle = handle.removePrefix("@").trim()
    if (cleanHandle.isEmpty() || cleanHandle.any { it.isWhitespace() }) return null
    return when (platform.lowercase()) {
        "x" -> "https://x.com/$cleanHandle"
        "youtube" -> "https://youtube.com/@$cleanHandle"
        "tiktok" -> "https://www.tiktok.com/@$cleanHandle"
        else -> null
    }
}

fun urgencyColor(urgency: Urgency): Color = when (urgency) {
    Urgency.HIGH -> Danger
    Urgency.NORMAL -> Warning
    Urgency.LOW -> TextTertiary
}

/** Same visual language as urgencyColor -- P1 is the most urgent, matching Urgency.HIGH's red. */
fun inboundPriorityColor(priority: InboundPriority): Color = when (priority) {
    InboundPriority.P1_DIRECT_REPLY -> Danger
    InboundPriority.P2_RELATIONSHIP -> Warning
    InboundPriority.P3_COMMENT -> com.fillbook.growthos.ui.theme.Info
    InboundPriority.P4_MENTION -> TextSecondary
    InboundPriority.LOW_VALUE -> TextTertiary
}

fun inboundPriorityLabel(priority: InboundPriority): String = when (priority) {
    InboundPriority.P1_DIRECT_REPLY -> "Direct reply"
    InboundPriority.P2_RELATIONSHIP -> "Relationship"
    InboundPriority.P3_COMMENT -> "Worth a reply"
    InboundPriority.P4_MENTION -> "Mention"
    InboundPriority.LOW_VALUE -> "Low value"
}

fun inboundStatusTone(status: String): StatusTone = when (status) {
    "responded" -> StatusTone.READY
    "draft_ready" -> StatusTone.NEW
    "needs_response", "new" -> StatusTone.WAITING
    "follow_up" -> StatusTone.ACTIVE
    "review_needed" -> StatusTone.WAITING
    "closed" -> StatusTone.SKIPPED
    else -> StatusTone.NEUTRAL
}

fun inboundStatusLabel(status: String): String = when (status) {
    "needs_response" -> "Needs response"
    "draft_ready" -> "Draft ready"
    "follow_up" -> "Follow up"
    "review_needed" -> "Review needed"
    "responded" -> "Responded"
    "closed" -> "Closed"
    else -> status.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

fun healthColor(status: HealthStatus): Color = when (status) {
    HealthStatus.HEALTHY -> Success
    HealthStatus.DEGRADED -> Warning
    HealthStatus.DOWN -> Danger
    HealthStatus.NOT_CONNECTED -> TextTertiary
}

fun healthLabel(status: HealthStatus): String = when (status) {
    HealthStatus.HEALTHY -> "Healthy"
    HealthStatus.DEGRADED -> "Degraded"
    HealthStatus.DOWN -> "Down"
    HealthStatus.NOT_CONNECTED -> "Not connected"
}

fun healthTone(status: HealthStatus): StatusTone = when (status) {
    HealthStatus.HEALTHY -> StatusTone.HEALTHY
    HealthStatus.DEGRADED -> StatusTone.WAITING
    HealthStatus.DOWN -> StatusTone.BLOCKED
    HealthStatus.NOT_CONNECTED -> StatusTone.NEUTRAL
}

/** Same real stage strings every screen already switches on, mapped to the shared status vocabulary. */
fun assetStageTone(stage: String): StatusTone = when (stage) {
    "ready_for_owner", "handed_off" -> StatusTone.READY
    "final_draft" -> StatusTone.WAITING
    else -> StatusTone.NEUTRAL
}

fun campaignStatusTone(status: String): StatusTone = when (status) {
    "approved" -> StatusTone.READY
    "in_review" -> StatusTone.WAITING
    "retired" -> StatusTone.BLOCKED
    else -> StatusTone.NEUTRAL
}

/**
 * "2h ago" instead of a raw ISO timestamp -- parses the subset of ISO
 * 8601 this backend actually emits (java.time on the server, always
 * UTC). Falls back to the raw string if parsing fails rather than
 * crashing the row it's shown in over a formatting edge case.
 */
fun relativeTime(isoTimestamp: String?): String? {
    if (isoTimestamp == null) return null
    val instant = runCatching { java.time.Instant.parse(isoTimestamp) }.getOrNull() ?: return isoTimestamp
    val seconds = java.time.Duration.between(instant, java.time.Instant.now()).seconds
    return when {
        seconds < 60 -> "just now"
        seconds < 3600 -> "${seconds / 60}m ago"
        seconds < 86400 -> "${seconds / 3600}h ago"
        seconds < 604800 -> "${seconds / 86400}d ago"
        else -> "${seconds / 604800}w ago"
    }
}

/**
 * Shared masthead used at the top of every screen. An optional [kicker]
 * (small uppercase cyan eyebrow above the title) gives a screen a sense of
 * place within the product -- e.g. Radar's kicker can name the signal
 * count -- without needing a second headline. Deliberately no bottom
 * divider/rule: the section-header accent ticks below already provide
 * enough wayfinding without adding another line across every screen.
 */
@Composable
fun ScreenHeader(title: String, subtitle: String, modifier: Modifier = Modifier, kicker: String? = null) {
    Column(modifier = modifier.padding(horizontal = 20.dp, vertical = 22.dp)) {
        if (kicker != null) {
            // A live region here (not the whole screen) means TalkBack
            // announces "N items" once when loading finishes -- because
            // the kicker only exists once there's a real count, this
            // fires on that one meaningful transition, not on every
            // recomposition, so it never turns into repeated noise.
            Text(
                kicker.uppercase(),
                style = com.fillbook.growthos.ui.theme.OverlineStyle,
                color = com.fillbook.growthos.ui.theme.Accent,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
            Spacer(Modifier.height(6.dp))
        }
        Text(title, style = com.fillbook.growthos.ui.theme.AppTypography.displayLarge, color = com.fillbook.growthos.ui.theme.TextPrimary)
        Spacer(Modifier.height(4.dp))
        Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = TextSecondary)
    }
}

/**
 * Uppercase group label ("QUICK ACTIONS", "RECENT ACTIVITY") used to break
 * a screen into scannable sections instead of one undifferentiated column
 * of cards. A short accent tick gives it a tiny bit more visual weight
 * than plain caption text without turning it into another headline.
 */
@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Row(modifier = modifier.padding(top = 4.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .width(3.dp)
                .height(12.dp)
                .background(Accent, RoundedCornerShape(2.dp)),
        )
        Spacer(Modifier.width(8.dp))
        Text(text.uppercase(), style = MaterialTheme.typography.labelMedium, color = TextSecondary)
    }
}

/**
 * Honest placeholder for a screen whose backend endpoint/table doesn't
 * exist yet (see docs/PROGRESS_LEDGER.md). Explains what real data will
 * show up here and why it doesn't yet, instead of fabricating numbers or
 * lorem-ipsum content. [statusLabel] is deliberately not fixed to one
 * wording -- an internal/dev build can say exactly what's missing
 * ("Not wired to real data yet"), while the normal operator-facing build
 * says something calmer ("Coming later") without exposing schema/table
 * names or implementation status.
 */
@Composable
fun ComingSoonScreen(
    title: String,
    subtitle: String,
    icon: ImageVector,
    blockedOn: String,
    modifier: Modifier = Modifier,
    statusLabel: String = "Not wired to real data yet",
) {
    Column(modifier = modifier.fillMaxSize()) {
        ScreenHeader(title, subtitle)
        // weight(1f) + Center: on a Coming-later screen there's nothing else on the
        // page, so anchoring the one card to the top leaves the rest of the phone
        // screen as dead black space below it -- centering it in the remaining
        // height reads as an intentional single-message screen instead.
        Box(
            modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 20.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Surface, RoundedCornerShape(24.dp))
                    .border(1.dp, Border, RoundedCornerShape(24.dp))
                    .padding(28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(
                    modifier = Modifier.size(60.dp).background(Background, CircleShape).border(1.dp, Border, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(icon, contentDescription = null, tint = TextTertiary, modifier = Modifier.size(28.dp))
                }
                Spacer(Modifier.height(16.dp))
                Text(
                    statusLabel,
                    style = MaterialTheme.typography.titleMedium,
                    color = TextSecondary,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    blockedOn,
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextTertiary,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}
