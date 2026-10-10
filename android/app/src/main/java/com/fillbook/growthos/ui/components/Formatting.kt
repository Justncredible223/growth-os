package com.fillbook.growthos.ui.components

import androidx.compose.ui.graphics.Color
import com.fillbook.growthos.ui.theme.Success
import com.fillbook.growthos.ui.theme.TextTertiary
import com.fillbook.growthos.ui.theme.Warning

/**
 * Presentation-layer humanizers for the operator-facing mobile pass. These
 * never change what the backend computes or stores -- every function here
 * takes a real value the API already returns and maps it to a label a
 * non-engineer can read, or parses an existing text field into a friendlier
 * shape. Nothing here calls an LLM or invents a fact that isn't already in
 * the input.
 */

// ---------------------------------------------------------------------
// Opportunity score bands (Radar) -- purely a display grouping over the
// same 0-100 score the backend already computes (scoreOpportunity() in
// backend/src/opportunities/scoring.ts). The numeric score is never
// altered; this only decides which word and color represent it.
// ---------------------------------------------------------------------

enum class ScoreBand(val label: String) {
    EXCEPTIONAL("Exceptional"),
    STRONG("Strong"),
    WORTH_REVIEWING("Worth reviewing"),
    LOW_PRIORITY("Low priority"),
}

fun scoreBand(score: Int): ScoreBand = when {
    score >= 80 -> ScoreBand.EXCEPTIONAL
    score >= 60 -> ScoreBand.STRONG
    score >= 45 -> ScoreBand.WORTH_REVIEWING
    else -> ScoreBand.LOW_PRIORITY
}

// Score bands are an outcome ("how good is this"), not an action -- Success
// green for the high bands, matching the same semantic ScoreBadge/Radar use
// elsewhere, not the brand-cyan Accent color reserved for interactive UI.
fun scoreBandColor(band: ScoreBand): Color = when (band) {
    ScoreBand.EXCEPTIONAL -> Success
    ScoreBand.STRONG -> Success
    ScoreBand.WORTH_REVIEWING -> Warning
    ScoreBand.LOW_PRIORITY -> TextTertiary
}

// ---------------------------------------------------------------------
// Opportunity rationale -- the backend's scoreOpportunity() (backend/src/
// opportunities/scoring.ts) returns a single semicolon-joined debug string
// like "audience relevance 60% -> +18.0; Fillbook relevance 50% -> +15.0;
// evidence confidence 40% -> +8.0; velocity 2 signals/24h -> +8.0". That's
// exactly the internal scoring-debug text this UX pass needs to stop
// showing as the primary read. Rather than adding a new API field (a
// backend change out of scope for a presentation pass) or asking an LLM
// to invent an explanation, this parses the existing, stable "<label> ->
// <+/-><value>" segment format the scorer already emits -- every word
// here is grounded in a real reason the score generator itself produced.
// ---------------------------------------------------------------------

private data class ScoreReason(val label: String, val positive: Boolean, val points: Double, val raw: String)

private val REASON_PATTERN = Regex("""^(.*?)\s*->\s*([+-])(\d+(?:\.\d+)?)$""")

private fun parseReasons(rationale: String): List<ScoreReason> =
    rationale.split(";").mapNotNull { segment ->
        val trimmed = segment.trim()
        val match = REASON_PATTERN.find(trimmed) ?: return@mapNotNull null
        val (label, sign, value) = match.destructured
        ScoreReason(label.trim(), sign == "+", value.toDoubleOrNull() ?: 0.0, trimmed)
    }

/** One human sentence for a positive contributor, grounded in its own label text -- never invents a reason the scorer didn't already produce. */
private fun phraseFor(reason: ScoreReason): String? {
    val label = reason.label.lowercase()
    return when {
        label.startsWith("audience relevance") -> "strong fit with your audience"
        label.startsWith("fillbook relevance") -> "clear connection to Fillbook's product"
        label.startsWith("evidence confidence") -> "well-evidenced signal"
        label.startsWith("velocity") -> "trending across multiple signals right now"
        else -> null
    }
}

private fun caveatFor(reason: ScoreReason): String? {
    val label = reason.label.lowercase()
    return when {
        label.startsWith("weak evidence") -> "evidence behind it is thin"
        label.startsWith("topic fatigue") -> "a similar angle was covered recently"
        label.contains("duplicate open opportunit") -> "a similar opportunity is already open"
        else -> null
    }
}

data class OpportunityExplanation(
    /** One or two plain-language reasons this surfaced, grounded in the real score inputs. Empty if the rationale text doesn't match the expected format (falls back to showing the raw text). */
    val summary: String,
    /** The exact reason segments the scorer produced, for "View score breakdown". */
    val breakdown: List<String>,
)

fun explainOpportunity(rationale: String): OpportunityExplanation {
    val reasons = parseReasons(rationale)
    if (reasons.isEmpty()) {
        // Unrecognized format (e.g. a future scorer change) -- show the raw text rather than a fabricated summary.
        return OpportunityExplanation(summary = rationale, breakdown = emptyList())
    }

    val positives = reasons.filter { it.positive }.sortedByDescending { it.points }
    val topPhrases = positives.mapNotNull(::phraseFor).take(2)
    val caveat = reasons.filter { !it.positive }.sortedByDescending { it.points }.firstNotNullOfOrNull(::caveatFor)

    val summary = buildString {
        if (topPhrases.isEmpty()) {
            append("Surfaced from the Signal Graph's current scoring pass.")
        } else {
            append(topPhrases.joinToString(" and ").replaceFirstChar { it.uppercase() })
            append(".")
        }
        if (caveat != null) {
            append(" Worth noting: ")
            append(caveat)
            append(".")
        }
    }

    return OpportunityExplanation(summary = summary, breakdown = reasons.map { it.raw })
}

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

fun campaignStatusDisplayName(status: String): String = when (status) {
    "in_review" -> "In review"
    "approved" -> "Approved"
    "retired" -> "Rejected"
    else -> status.replace('_', ' ').replaceFirstChar { it.uppercase() }
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

// ---------------------------------------------------------------------
// Creator relationship stage -- a plain-language read of the existing
// 0-10 readinessScore. Purely a label over the real score; the
// score itself, and the rule for how it advances, are untouched.
// ---------------------------------------------------------------------

fun relationshipStageLabel(readinessScore: Int?): String = when {
    readinessScore == null -> "Not yet scored"
    readinessScore >= 7 -> "Warm relationship"
    readinessScore >= 3 -> "Warming up"
    else -> "Early stage"
}

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
