package com.fillbook.growthos.ui.adaptive

import android.app.Activity
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Border
import com.fillbook.growthos.ui.theme.Surface
import com.fillbook.growthos.ui.theme.TextPrimary
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary

/** The live window classification. Defaults to COMPACT so previews and tests behave like a phone. */
val LocalWindowLayout = compositionLocalOf { WindowLayout.Compact }

/**
 * Feeds [LocalWindowLayout] from the real window. The width comes from [LocalConfiguration], which Compose refreshes on
 * fold/unfold and on split-screen resizes (the activity handles those config changes itself, see the manifest), so
 * everything below recomposes in place without losing state. A vertical hinge that separates the window (a flat
 * Z Fold's crease does not; a half-opened one does) comes from androidx.window's FoldingFeature.
 */
@Composable
fun AdaptiveLayout(content: @Composable () -> Unit) {
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current
    val context = LocalContext.current
    var hinge by remember { mutableStateOf<Hinge?>(null) }

    val activity = context as? Activity
    if (activity != null) {
        LaunchedEffect(activity) {
            try {
                WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { info ->
                    val fold = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull {
                        it.orientation == FoldingFeature.Orientation.VERTICAL && it.isSeparating
                    }
                    hinge = fold?.let {
                        with(density) { Hinge(it.bounds.left.toDp().value, it.bounds.right.toDp().value) }
                    }
                }
            } catch (e: Exception) {
                // No window-layout support on this device: panes just use the fixed ratio.
                hinge = null
            }
        }
    }
    val layout = WindowLayout(widthDp = configuration.screenWidthDp, hinge = hinge)
    CompositionLocalProvider(LocalWindowLayout provides layout, content = content)
}

/** List pane on the left, detail pane on the right, split by [computePaneSplit] (hinge-aligned when there is a hinge). */
@Composable
fun TwoPane(
    modifier: Modifier = Modifier,
    list: @Composable () -> Unit,
    detail: @Composable () -> Unit,
) {
    val layout = LocalWindowLayout.current
    val density = LocalDensity.current
    var containerLeftDp by remember { mutableFloatStateOf(RAIL_WIDTH_DP.toFloat()) }
    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            .onGloballyPositioned { containerLeftDp = with(density) { it.positionInWindow().x.toDp().value } },
    ) {
        val split = computePaneSplit(containerLeftDp, maxWidth.value, layout.hinge)
        Row(modifier = Modifier.fillMaxSize()) {
            Box(modifier = Modifier.width(split.listDp.dp).fillMaxHeight()) { list() }
            if (split.gapDp > 0f) {
                Spacer(Modifier.width(split.gapDp.dp))
            } else {
                Box(modifier = Modifier.width(1.dp).fillMaxHeight().background(Border))
            }
            Box(modifier = Modifier.weight(1f).fillMaxHeight()) { detail() }
        }
    }
}

/** What the detail pane says when no item is selected. */
@Composable
fun DetailPlaceholder(title: String, hint: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = TextSecondary, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(hint, style = MaterialTheme.typography.bodyMedium, color = TextTertiary, textAlign = TextAlign.Center)
    }
}

/** One compact, selectable row in a list pane (the full card shows in the detail pane). */
@Composable
fun SelectableRow(
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(16.dp)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(shape)
            .background(if (selected) Accent.copy(alpha = 0.14f) else Surface)
            .clickable(onClick = onClick)
            .semantics { role = Role.Tab; this.selected = selected }
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) { content() }
}

/** Title with an optional accent value on the right, then an optional two-line subtitle: the body of a [SelectableRow]. */
@Composable
fun RowTitleSubtitle(title: String, subtitle: String?, trailing: String? = null) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = TextPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (trailing != null) {
            Spacer(Modifier.width(8.dp))
            Text(trailing, style = MaterialTheme.typography.labelMedium, color = Accent, maxLines = 1)
        }
    }
    if (!subtitle.isNullOrBlank()) {
        Text(subtitle, style = MaterialTheme.typography.bodySmall, color = TextSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Caps content width on a wide window (centered), for screens that stay single-column. A no-op on COMPACT so the
 * cover screen is exactly as before.
 */
@Composable
fun ConstrainedContent(maxWidthDp: Int = CONTENT_MAX_WIDTH_DP, content: @Composable () -> Unit) {
    val layout = LocalWindowLayout.current
    if (!layout.twoPane) {
        content()
    } else {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            Box(modifier = Modifier.widthIn(max = maxWidthDp.dp).fillMaxHeight()) { content() }
        }
    }
}
