package com.fillbook.growthos.data

import org.json.JSONObject

/**
 * The Live Host: the AI character ("Tilt") that hosts the owner's own live stream. Growth OS holds the switch
 * and the record of everything heard and said; a worker on the owner's PC does the streaming. These mirror
 * GET /api/approvals?resource=live-host (backend/src/liveHost/liveHostHandlers.ts, LiveHostStatus).
 */
data class LiveHostSettings(
    val switchedOn: Boolean,
    val youtubeVideoId: String?,
    /** The owner's choice to read TikTok LIVE chat through an unofficial reader on the PC worker. Off by default. */
    val tiktokChatEnabled: Boolean,
    val tiktokUsername: String?,
    val idleSeconds: Int,
    val dailyBudgetUsd: Double,
)

data class LiveHostSession(
    val id: String,
    val startedAt: String,
    val lastHeartbeatAt: String,
    val workerOnline: Boolean,
    val messagesSeen: Int,
    val messagesAnswered: Int,
    val messagesPending: Int,
    val messagesBlocked: Int,
    val linesSpoken: Int,
    val fillbookMentions: Int,
)

data class LiveHostLastSession(val startedAt: String, val endedAt: String?, val endedReason: String?)

/** One row of the interaction feed: something a viewer typed, or something the host said. */
data class LiveHostFeedItem(
    val id: String,
    val isHostLine: Boolean,
    val at: String,
    val platform: String?,
    val authorName: String?,
    val text: String,
    val status: String,
    val statusReason: String?,
    val segment: String?,
    val mentionsFillbook: Boolean,
)

data class LiveHostStatus(
    /** False until the server-side migration (0049) has been applied. */
    val configured: Boolean,
    val hostName: String,
    val settings: LiveHostSettings?,
    val systemPaused: Boolean,
    val session: LiveHostSession?,
    val lastSession: LiveHostLastSession?,
    val todaySpendUsd: Double,
    val budgetReached: Boolean,
    val feed: List<LiveHostFeedItem>,
)

private fun JSONObject.stringOrNull(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

/** Parses the status payload. Pure, so the parsing is unit-testable without a network. */
internal fun parseLiveHostStatus(json: JSONObject): LiveHostStatus {
    val settings = json.optJSONObject("settings")?.let { s ->
        LiveHostSettings(
            switchedOn = s.optString("desiredState") == "on",
            youtubeVideoId = s.stringOrNull("youtubeVideoId"),
            tiktokChatEnabled = s.optBoolean("tiktokChatEnabled", false),
            tiktokUsername = s.stringOrNull("tiktokUsername"),
            idleSeconds = s.optInt("idleSeconds", 45),
            dailyBudgetUsd = s.optDouble("dailyBudgetUsd", 0.0),
        )
    }
    val session = json.optJSONObject("session")?.let { s ->
        LiveHostSession(
            id = s.optString("id"),
            startedAt = s.optString("startedAt"),
            lastHeartbeatAt = s.optString("lastHeartbeatAt"),
            workerOnline = s.optBoolean("workerOnline", false),
            messagesSeen = s.optInt("messagesSeen"),
            messagesAnswered = s.optInt("messagesAnswered"),
            messagesPending = s.optInt("messagesPending"),
            messagesBlocked = s.optInt("messagesBlocked"),
            linesSpoken = s.optInt("linesSpoken"),
            fillbookMentions = s.optInt("fillbookMentions"),
        )
    }
    val lastSession = json.optJSONObject("lastSession")?.let { s ->
        LiveHostLastSession(startedAt = s.optString("startedAt"), endedAt = s.stringOrNull("endedAt"), endedReason = s.stringOrNull("endedReason"))
    }
    val feedJson = json.optJSONArray("feed")
    val feed = (0 until (feedJson?.length() ?: 0)).mapNotNull { index ->
        val item = feedJson?.optJSONObject(index) ?: return@mapNotNull null
        LiveHostFeedItem(
            id = item.optString("id"),
            isHostLine = item.optString("type") == "utterance",
            at = item.optString("at"),
            platform = item.stringOrNull("platform"),
            authorName = item.stringOrNull("authorName"),
            text = item.optString("text"),
            status = item.optString("status"),
            statusReason = item.stringOrNull("statusReason"),
            segment = item.stringOrNull("segment"),
            mentionsFillbook = item.optBoolean("mentionsFillbook", false),
        )
    }
    return LiveHostStatus(
        configured = json.optBoolean("configured", false),
        hostName = json.optString("hostName", "Tilt"),
        settings = settings,
        systemPaused = json.optBoolean("systemPaused", false),
        session = session,
        lastSession = lastSession,
        todaySpendUsd = json.optDouble("todaySpendUsd", 0.0),
        budgetReached = json.optBoolean("budgetReached", false),
        feed = feed,
    )
}
