package com.fillbook.growthos.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * The daily posting plan and results (backend/src/posting, 2026-09-25). The owner posts one video a day (from 2026-10-04) at
 * 12pm Arizona time, to TikTok, YouTube Shorts and Instagram Reels. YouTube stats and X reply views
 * are pulled by the server; TikTok and Instagram numbers are typed in, since neither can be read automatically.
 */
enum class PostingPlatform(val apiName: String, val label: String) {
    TIKTOK("tiktok", "TikTok"),
    YOUTUBE_SHORTS("youtube_shorts", "YouTube"),
    INSTAGRAM("instagram", "Instagram");

    companion object {
        fun fromApi(name: String): PostingPlatform? = entries.firstOrNull { it.apiName == name }
    }
}

data class PlanPost(val platform: PostingPlatform, val url: String, val postedAt: String)

data class PlanVideo(
    val campaignAssetId: String,
    val videoRenderId: String?,
    val title: String,
    val posts: List<PlanPost>,
)

data class PlanSlot(
    /** "06:30", "12:00" or "17:30", Arizona time. */
    val time: String,
    /** "done", "due", "upcoming" or "empty". */
    val status: String,
    val video: PlanVideo?,
    val remaining: List<PostingPlatform>,
)

data class PostingPlan(val date: String, val slots: List<PlanSlot>, val backlog: Int)

data class PostResult(
    val id: String,
    val platform: PostingPlatform,
    val url: String,
    val postedAt: String,
    val views: Int?,
    val likes: Int?,
    val comments: Int?,
    val shares: Int?,
    /** "api" (read automatically), "manual" (typed in), or null (no numbers yet). */
    val statsSource: String?,
    val needsManualStats: Boolean,
    /** A week old, but the typed numbers were taken in the first days: ask for the day-7 numbers. */
    val needsDay7Stats: Boolean = false,
)

data class VideoResult(val campaignAssetId: String, val title: String, val firstPostedAt: String, val totalViews: Int?, val posts: List<PostResult>, val day: Int? = null)

data class XReplyResult(val tweetId: String, val text: String, val createdAt: String, val impressions: Int?, val likes: Int?, val replies: Int?)

data class ReplyVisibility(
    /** "ok", "dropped" or "not_enough_data". */
    val status: String,
    val recentMedian: Double?,
    val recentCount: Int,
    val baselineMedian: Double?,
    val baselineCount: Int,
)

data class PostingResults(val videos: List<VideoResult>, val xReplies: List<XReplyResult>, val replyVisibility: ReplyVisibility)

data class PostingOverview(val plan: PostingPlan, val results: PostingResults)

private fun <T> JSONArray.mapObjects(transform: (JSONObject) -> T): List<T> = (0 until length()).map { transform(getJSONObject(it)) }
private fun JSONObject.intOrNull(key: String): Int? = if (!has(key) || isNull(key)) null else getInt(key)
private fun JSONObject.doubleOrNull(key: String): Double? = if (!has(key) || isNull(key)) null else getDouble(key)
private fun JSONObject.stringOrNull(key: String): String? = if (!has(key) || isNull(key)) null else getString(key)

internal fun JSONObject.toPostingOverview(): PostingOverview {
    val plan = getJSONObject("plan")
    val results = getJSONObject("results")
    val visibility = results.getJSONObject("replyVisibility")
    return PostingOverview(
        plan = PostingPlan(
            date = plan.getString("date"),
            backlog = plan.getInt("backlog"),
            slots = plan.getJSONArray("slots").mapObjects { s ->
                PlanSlot(
                    time = s.getString("time"),
                    status = s.getString("status"),
                    video = s.optJSONObject("video")?.let { v ->
                        PlanVideo(
                            campaignAssetId = v.getString("campaignAssetId"),
                            videoRenderId = v.stringOrNull("videoRenderId"),
                            title = v.getString("title"),
                            posts = v.getJSONArray("posts").mapObjects { p ->
                                PostingPlatform.fromApi(p.getString("platform"))?.let { PlanPost(it, p.getString("url"), p.getString("postedAt")) }
                            }.filterNotNull(),
                        )
                    },
                    remaining = (0 until s.getJSONArray("remaining").length()).mapNotNull { PostingPlatform.fromApi(s.getJSONArray("remaining").getString(it)) },
                )
            },
        ),
        results = PostingResults(
            videos = results.getJSONArray("videos").mapObjects { v ->
                VideoResult(
                    campaignAssetId = v.getString("campaignAssetId"),
                    title = v.getString("title"),
                    firstPostedAt = v.getString("firstPostedAt"),
                    totalViews = v.intOrNull("totalViews"),
                    day = v.intOrNull("day"),
                    posts = v.getJSONArray("posts").mapObjects { p ->
                        PostingPlatform.fromApi(p.getString("platform"))?.let { platform ->
                            PostResult(
                                id = p.getString("id"),
                                platform = platform,
                                url = p.getString("url"),
                                postedAt = p.getString("postedAt"),
                                views = p.intOrNull("views"),
                                likes = p.intOrNull("likes"),
                                comments = p.intOrNull("comments"),
                                shares = p.intOrNull("shares"),
                                statsSource = p.stringOrNull("statsSource"),
                                needsManualStats = p.optBoolean("needsManualStats"),
                                needsDay7Stats = p.optBoolean("needsDay7Stats"),
                            )
                        }
                    }.filterNotNull(),
                )
            },
            xReplies = results.getJSONArray("xReplies").mapObjects { t ->
                XReplyResult(t.getString("tweetId"), t.getString("text"), t.getString("createdAt"), t.intOrNull("impressions"), t.intOrNull("likes"), t.intOrNull("replies"))
            },
            replyVisibility = ReplyVisibility(
                status = visibility.getString("status"),
                recentMedian = visibility.doubleOrNull("recentMedian"),
                recentCount = visibility.getInt("recentCount"),
                baselineMedian = visibility.doubleOrNull("baselineMedian"),
                baselineCount = visibility.getInt("baselineCount"),
            ),
        ),
    )
}
