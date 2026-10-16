package com.fillbook.growthos.ui.screens

import com.fillbook.growthos.data.DraftOption
import com.fillbook.growthos.data.ProspectingCandidate

/**
 * Reply-style experiment (2026-10-16): a Prospecting draft can carry two options, "sharp" and "helpful". These pure helpers
 * decide which text the owner is working with so the card, the copy buttons and "Replied" all agree. The backend matches the
 * posted text back to an option (or "edited"), so the app only has to send the text that was actually posted.
 */

/** Edit-map key for one option of one candidate. A candidate with a single draft keeps using its bare id. */
internal fun optionEditKey(candidateId: String, style: String): String = "$candidateId:$style"

/** Two-option drafts only: a single option (or none) renders as the original single draft box. */
internal fun hasTwoOptions(candidate: ProspectingCandidate): Boolean = candidate.draftOptions.size >= 2

internal fun styleLabel(style: String): String = when (style) {
    "sharp" -> "Sharp"
    "helpful" -> "Helpful"
    else -> style.replaceFirstChar { it.uppercase() }
}

/** The option the owner is on: the last one they copied or edited, else the first (which is also draftReply). */
internal fun activeStyle(candidate: ProspectingCandidate, chosen: String?): String? =
    candidate.draftOptions.firstOrNull { it.style == chosen }?.style ?: candidate.draftOptions.firstOrNull()?.style

/** The text currently shown for one option: the owner's edit if any, else the drafted text. */
internal fun optionText(candidate: ProspectingCandidate, style: String, edits: Map<String, String>): String? {
    val option: DraftOption = candidate.draftOptions.firstOrNull { it.style == style } ?: return null
    return edits[optionEditKey(candidate.id, style)] ?: option.text
}

/** The text that would be copied or posted right now. Falls back to the single-draft behavior when there are no options. */
internal fun currentReplyText(candidate: ProspectingCandidate, edits: Map<String, String>, chosen: String?): String? {
    if (candidate.draftOptions.isEmpty()) return edits[candidate.id] ?: candidate.draftReply
    val style = activeStyle(candidate, chosen) ?: return candidate.draftReply
    return optionText(candidate, style, edits)
}

/** What "Replied" sends as finalReply: the posted text, or null when it is exactly the stored draftReply (the backend then treats it as the first option). */
internal fun finalReplyToSend(candidate: ProspectingCandidate, edits: Map<String, String>, chosen: String?): String? =
    currentReplyText(candidate, edits, chosen)?.takeIf { it != candidate.draftReply }
