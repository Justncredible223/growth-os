package com.fillbook.growthos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 2026-10-09: Prospecting's "Open on X" used to land on the post; the X Android app began sending the stored
 * x.com/i/web/status/<id> link to the home feed. The button now opens the canonical post URL instead.
 */
class ProspectingPostLinkTest {
    @Test
    fun `stored i-web-status link becomes the canonical handle URL`() {
        assertEquals(
            "https://x.com/AleeManga/status/501",
            ProspectingPostLink.buildOpenUrl("x", "https://x.com/i/web/status/501", "AleeManga"),
        )
    }

    @Test
    fun `leading at sign on the handle is dropped`() {
        assertEquals(
            "https://x.com/AleeManga/status/501",
            ProspectingPostLink.buildOpenUrl("x", "https://x.com/i/web/status/501", "@AleeManga"),
        )
    }

    @Test
    fun `no handle falls back to the i-status form`() {
        assertEquals("https://x.com/i/status/501", ProspectingPostLink.buildOpenUrl("x", "https://x.com/i/web/status/501", null))
    }

    @Test
    fun `a handle that is not a real handle is not put in the URL`() {
        assertEquals("https://x.com/i/status/501", ProspectingPostLink.buildOpenUrl("x", "https://x.com/i/web/status/501", "Not A Handle"))
    }

    @Test
    fun `query params on the stored link are dropped`() {
        assertEquals("https://x.com/a_b/status/501", ProspectingPostLink.buildOpenUrl("x", "https://x.com/i/web/status/501?s=20", "a_b"))
    }

    @Test
    fun `non-X platforms and unrecognised shapes are returned unchanged`() {
        assertEquals("https://example.com/p/1", ProspectingPostLink.buildOpenUrl("instagram", "https://example.com/p/1", "x"))
        assertEquals("https://x.com/i/web/status/fake-searched-3", ProspectingPostLink.buildOpenUrl("x", "https://x.com/i/web/status/fake-searched-3", "a"))
        assertEquals("https://x.com/someone", ProspectingPostLink.buildOpenUrl("x", "https://x.com/someone", "someone"))
    }

    @Test
    fun `X says where to tap once copied and opened`() {
        assertEquals("Copied. Tap the reply icon on the top post, then paste.", ProspectingPostLink.copyAndOpenMessage("x", copied = true, opened = true))
    }

    @Test
    fun `failures and other platforms keep the standard wording`() {
        assertEquals("Copied, but no app could open X", ProspectingPostLink.copyAndOpenMessage("x", copied = true, opened = false))
        assertEquals("No app could open X", ProspectingPostLink.copyAndOpenMessage("x", copied = false, opened = false))
        assertEquals("Opened in X", ProspectingPostLink.copyAndOpenMessage("x", copied = false, opened = true))
        assertEquals("Copied — paste in YouTube", ProspectingPostLink.copyAndOpenMessage("youtube", copied = true, opened = true))
    }
}
