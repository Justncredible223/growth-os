/**
 * Text a writer model leaves for itself that must never be posted (P0 2026-11-15: an HQ draft ended with "(Character count: about 215,
 * with the URL counted as 23.)" and reached Approvals). A match blocks the draft at HQ intake and puts a warning on any card already
 * waiting; the text is never silently trimmed.
 */
const DRAFTING_NOTE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:character|char|word|letter)s?\s+count\b/i, "a character or word count note"],
  [/\(\s*\d+\s*(?:characters|chars|words)\b/i, "a length note in brackets"],
  [/\[\s*(?:insert|add|link|url|placeholder|todo|tbd|image)[^\]]*\]/i, "a placeholder in square brackets"],
  [/^\s*(?:note|notes|draft note|editor'?s note|writer'?s note)\s*:/im, "a note line"],
  [/\bhere(?:'s| is) (?:a|the|your|an?) (?:draft|post|tweet|version|reply)\b/i, "an introduction to the draft"],
  [/\bas an ai\b|\blanguage model\b/i, "AI self-reference"],
  [/\b(?:url|link) counted as\b/i, "a link-length note"],
];

/** The first drafting note found in [text], as a short reason, or null when the text reads like a finished post. */
export function findDraftingNote(text: string): string | null {
  for (const [pattern, reason] of DRAFTING_NOTE_PATTERNS) if (pattern.test(text)) return reason;
  return null;
}
