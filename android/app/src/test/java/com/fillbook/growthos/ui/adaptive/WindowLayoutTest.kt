package com.fillbook.growthos.ui.adaptive

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WindowLayoutTest {
    @Test
    fun widthClassThresholds() {
        assertEquals(WidthClass.COMPACT, widthClassFor(359))
        assertEquals(WidthClass.COMPACT, widthClassFor(360))
        assertEquals(WidthClass.COMPACT, widthClassFor(599))
        assertEquals(WidthClass.MEDIUM, widthClassFor(600))
        assertEquals(WidthClass.MEDIUM, widthClassFor(839))
        assertEquals(WidthClass.EXPANDED, widthClassFor(840))
        assertEquals(WidthClass.EXPANDED, widthClassFor(1280))
    }

    @Test
    fun twoPaneStartsAt600() {
        assertFalse(isTwoPane(599))
        assertTrue(isTwoPane(600))
        assertFalse(WindowLayout(360).twoPane)
        assertFalse(WindowLayout(360).useRail)
        assertTrue(WindowLayout(760).useRail)
    }

    @Test
    fun coverScreenIsCompact() {
        // 1080 x 2520 px at 480 dpi
        val widthDp = pxToDp(1080, 480)
        assertEquals(360f, widthDp, 0.01f)
        assertEquals(WidthClass.COMPACT, widthClassFor(widthDp.toInt()))
        assertFalse(isTwoPane(widthDp.toInt()))
    }

    @Test
    fun innerScreenAtPlausibleDensities() {
        // 2256 px wide inner display at the densities that give the measured 750-860 dp range.
        val at480 = pxToDp(2256, 480).toInt()
        val at440 = pxToDp(2256, 440).toInt()
        val at420 = pxToDp(2256, 420).toInt()
        assertEquals(752, at480)
        assertEquals(WidthClass.MEDIUM, widthClassFor(at480))
        assertEquals(820, at440)
        assertEquals(WidthClass.MEDIUM, widthClassFor(at440))
        assertEquals(859, at420)
        assertEquals(WidthClass.EXPANDED, widthClassFor(at420))
        assertTrue(isTwoPane(at480) && isTwoPane(at440) && isTwoPane(at420))
    }

    @Test
    fun listPaneIsFortyPercentClampedTo300To420() {
        assertEquals(280f, listPaneWidthDp(600f), 0.01f)   // 240 -> min 300, but detail keeps its 320 dp floor
        assertEquals(300f, listPaneWidthDp(700f), 0.01f)   // 280 -> 300
        assertEquals(320f, listPaneWidthDp(800f), 0.01f)   // 40%
        assertEquals(400f, listPaneWidthDp(1000f), 0.01f)
        assertEquals(420f, listPaneWidthDp(1200f), 0.01f)  // 480 -> max 420
        assertEquals(420f, listPaneWidthDp(2000f), 0.01f)
    }

    @Test
    fun listPaneNeverStarvesTheDetailPane() {
        // 520 dp content (a 600 dp window less the rail): list gives way so detail keeps its 320 dp floor.
        val list = listPaneWidthDp(520f)
        assertEquals(200f, list, 0.01f)
        assertTrue(520f - list >= DETAIL_PANE_MIN_DP)
        // A degenerate container never returns a negative width.
        assertTrue(listPaneWidthDp(100f) >= 0f)
    }

    @Test
    fun innerScreenPaneWidths() {
        // 752 dp window less the 88 dp rail
        val container = 752f - RAIL_WIDTH_DP
        assertEquals(300f, listPaneWidthDp(container), 0.01f)
        assertEquals(364f, container - listPaneWidthDp(container), 0.01f)
        // 859 dp window less the rail
        val wide = 859f - RAIL_WIDTH_DP
        assertEquals(308.4f, listPaneWidthDp(wide), 0.05f)
    }

    @Test
    fun noHingeUsesFixedRatio() {
        val split = computePaneSplit(containerLeftDp = 88f, containerWidthDp = 770f, hinge = null)
        assertFalse(split.alignedToHinge)
        assertEquals(0f, split.gapDp, 0.001f)
        assertEquals(listPaneWidthDp(770f), split.listDp, 0.001f)
    }

    @Test
    fun hingeAlignsPanesToHalves() {
        // Window 860 dp wide, rail 88 dp, vertical hinge 420-440 dp
        val split = computePaneSplit(containerLeftDp = 88f, containerWidthDp = 772f, hinge = Hinge(420f, 440f))
        assertTrue(split.alignedToHinge)
        assertEquals(332f, split.listDp, 0.001f)  // 420 - 88
        assertEquals(20f, split.gapDp, 0.001f)
        // The detail pane then starts at the hinge's right edge: 88 + 332 + 20 = 440
        assertEquals(440f, 88f + split.listDp + split.gapDp, 0.001f)
    }

    @Test
    fun hingeTooCloseToAnEdgeIsIgnored() {
        val nearRail = computePaneSplit(88f, 772f, Hinge(200f, 210f)) // list half would be 112 dp
        assertFalse(nearRail.alignedToHinge)
        val nearRight = computePaneSplit(88f, 772f, Hinge(780f, 790f)) // detail half would be 70 dp
        assertFalse(nearRight.alignedToHinge)
    }

    @Test
    fun selectionOnlySurvivesWhileTheItemIsInTheList() {
        val ids = listOf("a", "b", "c")
        assertEquals("b", resolveSelection("b", ids))
        assertNull(resolveSelection("z", ids))
        assertNull(resolveSelection(null, ids))
        assertNull(resolveSelection("a", emptyList()))
    }

    @Test
    fun detailPaneStates() {
        val ids = listOf("a", "b")
        assertEquals(DetailState.Item, detailState("a", ids))
        assertEquals(DetailState.PickHint, detailState(null, ids))
        assertEquals(DetailState.PickHint, detailState("gone", ids))
        assertEquals(DetailState.NothingToPick, detailState("a", emptyList()))
    }
}
