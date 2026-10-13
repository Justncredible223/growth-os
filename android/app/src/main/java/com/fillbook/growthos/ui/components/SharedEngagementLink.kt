package com.fillbook.growthos.ui.components

/**
 * Pulls the video link out of text shared to Fillbook from the TikTok or YouTube share sheet (ACTION_SEND text/plain), so
 * the Engage tab can add it without the owner copying, switching apps and pasting. TikTok shares read like
 * "Check out @name's video! https://vm.tiktok.com/ZMabc123/", so the first matching URL is taken and trailing
 * punctuation is dropped. Anything that is not a TikTok or YouTube video link returns null and is ignored: the share
 * target never posts or sends anything, it only offers a link to the same add-a-link call the paste box uses.
 * Pure, no Android imports, same testability convention as InboundReplyLink.kt.
 */
object SharedEngagementLink {
    private val URL_PATTERN = Regex("""https?://[^\s<>"']+""", RegexOption.IGNORE_CASE)
    private val HOST_PATTERN = Regex("""^https?://(?:[a-z0-9-]+\.)*(?:tiktok\.com|youtube\.com|youtu\.be)(?:[:/?#]|$)""", RegexOption.IGNORE_CASE)

    fun extract(text: String?): String? {
        if (text.isNullOrBlank()) return null
        return URL_PATTERN.findAll(text)
            .map { it.value.trimEnd('.', ',', ')', '!', '?', ';', ':') }
            .firstOrNull { HOST_PATTERN.containsMatchIn(it) }
    }
}
