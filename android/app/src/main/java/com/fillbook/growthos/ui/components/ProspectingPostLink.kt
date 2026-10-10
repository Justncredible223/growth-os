package com.fillbook.growthos.ui.components

/**
 * The link Prospecting's "Open on X" opens for one candidate.
 *
 * The backend stores every X post as https://x.com/i/web/status/<id> (prospectingSearch.ts). On 2026-10-09 the X Android
 * app stopped resolving that form and dropped the owner on the home feed instead of the post, so the reply box was one
 * search away. The canonical https://x.com/<handle>/status/<id> form (the one Inbound already opens) is what X's own
 * share links use, so it is built from the author's handle when we have one, and https://x.com/i/status/<id> otherwise.
 *
 * Anything that is not an X status link with a numeric id is returned unchanged, so a non-X platform or an unexpected
 * shape never gets rewritten into a wrong URL. Pure, no Android imports, same convention as InboundReplyLink.kt.
 */
object ProspectingPostLink {
    private val STATUS_ID_PATTERN = Regex("""^https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/(?:i/web|i)/status/(\d+)""")
    private val HANDLE_PATTERN = Regex("""^[A-Za-z0-9_]{1,15}$""")

    fun buildOpenUrl(platform: String, postUrl: String, authorHandle: String?): String {
        if (platform.lowercase() != "x") return postUrl
        val id = STATUS_ID_PATTERN.find(postUrl)?.groupValues?.get(1) ?: return postUrl
        val handle = authorHandle?.trim()?.removePrefix("@")
        return if (handle != null && HANDLE_PATTERN.matches(handle)) "https://x.com/$handle/status/$id" else "https://x.com/i/status/$id"
    }
}
