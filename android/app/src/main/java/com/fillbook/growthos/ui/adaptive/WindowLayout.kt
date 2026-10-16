package com.fillbook.growthos.ui.adaptive

import kotlin.math.max
import kotlin.math.min

/**
 * Pure window-size math for the adaptive (Galaxy Z Fold) layout. No Android or Compose types here so every threshold is
 * unit-testable on the JVM; [AdaptiveLayout] is the composable glue that feeds these functions the live window.
 *
 * Measured target (SM-F976U, Z Fold class): closed cover screen 1080x2520 px at 480 dpi = 360x840 dp (COMPACT); open
 * inner screen 2256x2504 px, roughly 750-860 dp wide depending on the inner density (MEDIUM or EXPANDED, both two-pane).
 */
enum class WidthClass { COMPACT, MEDIUM, EXPANDED }

/** Width below this is COMPACT: the closed cover screen and any ordinary phone. Same breakpoint Material uses. */
const val COMPACT_MAX_DP = 600

/** Width at or above this is EXPANDED. */
const val EXPANDED_MIN_DP = 840

/** Two panes (and the navigation rail) start at this width. */
const val TWO_PANE_MIN_DP = 600

fun widthClassFor(widthDp: Int): WidthClass = when {
    widthDp < COMPACT_MAX_DP -> WidthClass.COMPACT
    widthDp < EXPANDED_MIN_DP -> WidthClass.MEDIUM
    else -> WidthClass.EXPANDED
}

fun isTwoPane(widthDp: Int): Boolean = widthDp >= TWO_PANE_MIN_DP

/** Pixels to dp at a given density (dpi), e.g. 2256 px at 420 dpi = 859 dp. */
fun pxToDp(px: Int, densityDpi: Int): Float = px * 160f / densityDpi

/** A vertical hinge/fold that splits (or occludes) the window, in window coordinates in dp. */
data class Hinge(val leftDp: Float, val rightDp: Float) {
    val widthDp: Float get() = rightDp - leftDp
}

data class WindowLayout(val widthDp: Int, val hinge: Hinge? = null) {
    val widthClass: WidthClass get() = widthClassFor(widthDp)
    val twoPane: Boolean get() = isTwoPane(widthDp)

    /** Left navigation rail instead of the bottom bar. */
    val useRail: Boolean get() = twoPane

    companion object {
        val Compact = WindowLayout(widthDp = 360)
    }
}

/** Width of the navigation rail; also what the pane split subtracts from the window to find the content area. */
const val RAIL_WIDTH_DP = 88

const val LIST_PANE_FRACTION = 0.4f
const val LIST_PANE_MIN_DP = 300f
const val LIST_PANE_MAX_DP = 420f

/** The detail pane never gets narrower than this; the list gives way first on a tight window. */
const val DETAIL_PANE_MIN_DP = 320f

/** Smallest half a hinge split may leave; a hinge too close to an edge is ignored in favour of the fixed ratio. */
const val HINGE_HALF_MIN_DP = 240f

/** The list pane's width for a container [containerDp] wide: 40%, clamped to 300-420 dp, and never starving the detail pane. */
fun listPaneWidthDp(containerDp: Float): Float {
    val upper = min(LIST_PANE_MAX_DP, containerDp - DETAIL_PANE_MIN_DP)
    val lower = min(LIST_PANE_MIN_DP, upper)
    return (containerDp * LIST_PANE_FRACTION).coerceIn(lower, max(lower, upper)).coerceAtLeast(0f)
}

/** [listDp] is the list pane's width, [gapDp] the empty strip between the panes (the hinge width, or 0). */
data class PaneSplit(val listDp: Float, val gapDp: Float, val alignedToHinge: Boolean)

/**
 * Where to put the divider between the panes. With a vertical hinge inside the container the list pane is exactly the
 * left half and the detail pane the right half, with the hinge's own width left empty, so no control sits across it.
 * With no hinge (or one that would leave a half under [HINGE_HALF_MIN_DP]) it is the fixed 40% ratio.
 *
 * [containerLeftDp] is the container's left edge in window coordinates (the rail's width), to line it up with the hinge.
 */
fun computePaneSplit(containerLeftDp: Float, containerWidthDp: Float, hinge: Hinge?): PaneSplit {
    if (hinge != null) {
        val list = hinge.leftDp - containerLeftDp
        val detail = containerLeftDp + containerWidthDp - hinge.rightDp
        if (list >= HINGE_HALF_MIN_DP && detail >= HINGE_HALF_MIN_DP) return PaneSplit(list, hinge.widthDp, true)
    }
    return PaneSplit(listPaneWidthDp(containerWidthDp), 0f, false)
}

/** Largest width non-list screens (Settings, System, ...) take on a wide window. */
const val CONTENT_MAX_WIDTH_DP = 720

/** Home and Results use two columns, so they get a wider cap. */
const val GRID_CONTENT_MAX_WIDTH_DP = 960

/**
 * The selection that is still valid for the current list: the selected id if it is still in the list, otherwise null
 * (an item that was approved, skipped or refreshed away must not leave the detail pane showing a ghost).
 */
fun resolveSelection(selectedId: String?, ids: List<String>): String? = selectedId?.takeIf { it in ids }

/** What the detail pane shows: the selected item, an empty-state hint (nothing picked yet), or nothing to pick at all. */
enum class DetailState { Item, PickHint, NothingToPick }

fun detailState(selectedId: String?, ids: List<String>): DetailState = when {
    ids.isEmpty() -> DetailState.NothingToPick
    resolveSelection(selectedId, ids) != null -> DetailState.Item
    else -> DetailState.PickHint
}
