package com.fillbook.growthos.ui.components


/**
 * Presentation-layer humanizers for the operator-facing mobile pass. These
 * never change what the backend computes or stores -- every function here
 * takes a real value the API already returns and maps it to a label a
 * non-engineer can read, or parses an existing text field into a friendlier
 * shape. Nothing here calls an LLM or invents a fact that isn't already in
 * the input.
 */

// ---------------------------------------------------------------------
// Review-agent language -- "8/9 agents" reads as internal implementation
// language (the "agents" are Claude review-agent calls, an implementation
// detail). The number itself is real and unchanged; only the label
// changes.
// ---------------------------------------------------------------------

fun reviewSummaryLabel(passCount: Int, totalCount: Int): String =
    if (totalCount <= 0) "" else "$passCount/$totalCount reviews passed"

// ---------------------------------------------------------------------
// Campaign-asset stage -- the real CampaignFactory stage string
// (backend/src/content/campaignPipeline.ts), humanized for operator
// reading. Falls back to a generic underscore->space, title-case
// transform for any stage this map doesn't recognize, so an unmapped
// future stage still reads reasonably instead of disappearing.
// ---------------------------------------------------------------------

fun assetStageDisplayName(stage: String): String = when (stage) {
    "draft" -> "Drafting"
    "final_draft" -> "In review"
    "ready_for_owner" -> "Ready for you"
    "handed_off" -> "Handed off"
    else -> stage.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

fun opportunityStatusDisplayName(status: String): String = when (status) {
    "open" -> "Open"
    "actioned" -> "Actioned"
    else -> status.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

/** Signal-source values are the DB's real `signals.source` check-constraint values (x_mention, youtube_video, search_console_query, tiktok_video). */
fun signalSourceDisplayName(source: String): String = when (source) {
    "x_mention" -> "X Mention"
    "youtube_video" -> "YouTube Video"
    "tiktok_video" -> "TikTok Video"
    "search_console_query" -> "Search Console Query"
    else -> source.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

// ---------------------------------------------------------------------
// Auto-draft skip reason -- backend/src/opportunities/autoDraftStep.ts /
// autoDraftEligibility.ts emit real, stable reason codes (some already
// carrying a human-readable parenthetical, some bare enum-style strings
// like "no_qualifying_opportunity"). This maps every known code to one
// clean sentence; anything unrecognized falls back to the same
// underscore->space transform rather than disappearing.
// ---------------------------------------------------------------------

fun autoDraftSkipReasonLabel(reason: String?): String {
    if (reason == null) return "No run recorded yet"
    val code = reason.substringBefore('(').trim()
    val detail = reason.substringAfter('(', "").removeSuffix(")").trim()
    return when (code) {
        "system_paused" -> "System was paused"
        "no_qualifying_opportunity" -> "No opportunity met today's auto-draft threshold"
        "backlog_cap_reached" -> if (detail.isNotEmpty()) "Draft backlog is full ($detail)" else "Draft backlog is full"
        "monthly_budget_reached" -> if (detail.isNotEmpty()) "Monthly auto-draft budget reached ($detail)" else "Monthly auto-draft budget reached"
        "in_progress" -> "A run was already in progress"
        else -> reason.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }
}
