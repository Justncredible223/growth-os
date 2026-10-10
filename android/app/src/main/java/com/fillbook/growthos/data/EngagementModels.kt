package com.fillbook.growthos.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * The engagement assistant: a review queue of OTHER creators' YouTube Shorts and TikTok videos, each with a few
 * drafted comments. The app never posts anything: the owner opens the video, copies a draft, and posts it
 * natively, then taps Done. These mirror GET /api/approvals?resource=engagement
 * (backend/src/engagement/engagementHandlers.ts, getEngagementStatus).
 */
data class EngagementDraft(val id: String, val text: String)

data class EngagementItem(
    val id: String,
    /** "youtube" or "tiktok". */
    val platform: String,
    val url: String,
    val title: String,
    val creatorName: String,
    val thumbnailUrl: String?,
    val topComments: List<String>,
    val drafts: List<EngagementDraft>,
    /** "new" or "drafted". */
    val status: String,
    /** Why drafting/copying is refused right now (creator cooldown or daily cap), or null. */
    val blockMessage: String?,
)

data class EngagementPlatformCount(val done: Int, val cap: Int)

data class EngagementStatus(
    /** False until the server-side migration (0050) has been applied. */
    val configured: Boolean,
    val message: String?,
    /** False until YOUTUBE_API_KEY is set on the server; TikTok pasting works either way. */
    val youtubeConfigured: Boolean,
    val minSpacingSeconds: Int,
    val nextActionInSeconds: Int,
    val youtubeToday: EngagementPlatformCount,
    val tiktokToday: EngagementPlatformCount,
    val quotaUsed: Int,
    val quotaBudget: Int,
    val queue: List<EngagementItem>,
    val watchlistCount: Int,
)

data class EngagementCopyResult(val text: String, val warnings: List<String>)

data class EngagementDiscoverResult(val added: Int, val stoppedReason: String?, val errors: List<String>)

/** A refusal or validation message from the server that the owner should read as-is (a cap, a cooldown, a guardrail). */
class EngagementActionException(val reason: String) : Exception(reason)

private fun JSONObject.stringOrNull(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).mapNotNull { optString(it).takeIf { s -> s.isNotEmpty() } }

internal fun parseEngagementItem(json: JSONObject): EngagementItem {
    val drafts = json.optJSONArray("drafts")?.let { arr ->
        (0 until arr.length()).mapNotNull { i ->
            val d = arr.optJSONObject(i) ?: return@mapNotNull null
            val text = d.optString("text")
            if (text.isEmpty()) null else EngagementDraft(d.optString("id"), text)
        }
    } ?: emptyList()
    return EngagementItem(
        id = json.getString("id"),
        platform = json.optString("platform"),
        url = json.optString("url"),
        title = json.optString("title"),
        creatorName = json.optString("creatorName"),
        thumbnailUrl = json.stringOrNull("thumbnailUrl"),
        topComments = json.optJSONArray("topComments").strings(),
        drafts = drafts,
        status = json.optString("status", "new"),
        blockMessage = json.optJSONObject("block")?.stringOrNull("message"),
    )
}

/** Parses the status payload. Pure, so it is unit-testable without a network. */
internal fun parseEngagementStatus(json: JSONObject): EngagementStatus {
    val configured = json.optBoolean("configured", false)
    val limits = json.optJSONObject("limits")
    val today = json.optJSONObject("today")
    val quota = json.optJSONObject("quota")
    fun count(key: String): EngagementPlatformCount {
        val o = today?.optJSONObject(key)
        return EngagementPlatformCount(done = o?.optInt("done", 0) ?: 0, cap = o?.optInt("cap", 0) ?: 0)
    }
    val queue = json.optJSONArray("queue")?.let { arr -> (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let(::parseEngagementItem) } } ?: emptyList()
    return EngagementStatus(
        configured = configured,
        message = json.stringOrNull("message"),
        youtubeConfigured = json.optBoolean("youtubeConfigured", false),
        minSpacingSeconds = limits?.optInt("minSpacingSeconds", 90) ?: 90,
        nextActionInSeconds = json.optInt("nextActionInSeconds", 0),
        youtubeToday = count("youtube"),
        tiktokToday = count("tiktok"),
        quotaUsed = quota?.optInt("used", 0) ?: 0,
        quotaBudget = quota?.optInt("budget", 0) ?: 0,
        queue = queue,
        watchlistCount = json.optJSONArray("watchlist")?.length() ?: 0,
    )
}

/** "YouTube 3 of 25 today, TikTok 0 of 25". */
fun engagementTodayLine(status: EngagementStatus): String =
    "YouTube ${status.youtubeToday.done} of ${status.youtubeToday.cap} today, TikTok ${status.tiktokToday.done} of ${status.tiktokToday.cap}"

/** The spacing hint under the header: only shown while the owner is inside the minimum gap between actions. */
fun engagementSpacingLine(status: EngagementStatus): String? =
    if (status.nextActionInSeconds > 0) "Next action available in ${status.nextActionInSeconds}s" else null

/** Pasted text is a channel when it is an @handle or a channel id; anything else is a search query. */
fun engagementWatchKind(value: String): String {
    val v = value.trim()
    return if (v.startsWith("@") || Regex("^UC[A-Za-z0-9_-]{20,24}$").matches(v)) "channel" else "query"
}
