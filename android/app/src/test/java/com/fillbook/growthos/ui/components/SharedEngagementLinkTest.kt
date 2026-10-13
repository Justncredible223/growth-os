package com.fillbook.growthos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SharedEngagementLinkTest {
    @Test
    fun `takes the TikTok short link out of the share text`() {
        assertEquals(
            "https://vm.tiktok.com/ZMabc123/",
            SharedEngagementLink.extract("Check out @someone's video! https://vm.tiktok.com/ZMabc123/ #futures"),
        )
    }

    @Test
    fun `takes a full TikTok video link and a YouTube Shorts link`() {
        assertEquals("https://www.tiktok.com/@a/video/7400000000000000000", SharedEngagementLink.extract("https://www.tiktok.com/@a/video/7400000000000000000?_r=1".substringBefore("?")))
        assertEquals("https://youtube.com/shorts/AbC123xyz", SharedEngagementLink.extract("Watch this https://youtube.com/shorts/AbC123xyz."))
        assertEquals("https://youtu.be/AbC123xyz", SharedEngagementLink.extract("https://youtu.be/AbC123xyz"))
    }

    @Test
    fun `ignores other sites and look-alike hosts`() {
        assertNull(SharedEngagementLink.extract("https://example.com/watch"))
        assertNull(SharedEngagementLink.extract("https://nottiktok.com/video/1"))
        assertNull(SharedEngagementLink.extract("https://tiktok.com.evil.example/video/1"))
        assertNull(SharedEngagementLink.extract("no link here"))
        assertNull(SharedEngagementLink.extract(null))
    }

    @Test
    fun `skips a non-video link that comes first`() {
        assertEquals("https://vt.tiktok.com/ZSxyz/", SharedEngagementLink.extract("see https://example.com then https://vt.tiktok.com/ZSxyz/"))
    }
}
