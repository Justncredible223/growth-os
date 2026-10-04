import { BrandConstitution, type VocabularyViolation } from "../knowledge/brandConstitution.js";
import { checkAntiSlop, type SlopFinding } from "./antiSlopEngine.js";
import { OriginalityEngine } from "./originalityEngine.js";

export interface QualityGateResult {
  passed: boolean;
  vocabularyViolations: VocabularyViolation[];
  slopFindings: SlopFinding[];
  maxSimilarity: number;
  blockReasons: string[];
}

const ORIGINALITY_THRESHOLD = 0.6;

/**
 * The spoken narration of a video-script draft (formatVideoScriptAsText's SCRIPT section), or the text unchanged when
 * it has none. Video drafts share a lot of fixed template copy (headings, description, hashtags), which made two
 * different motion concepts look ~60% identical; originality is judged on what is actually said.
 */
export function spokenScriptOf(text: string): string {
  const match = /(?:^|\n)SCRIPT:\n([\s\S]*?)\n\nSHOT LIST:/.exec(text);
  return match ? match[1]! : text;
}

/** Posts longer than this need a blank line between parts; a short one-liner does not. */
export const PARAGRAPH_MIN_CHARS = 200;

/** True when the text is short enough not to need paragraphs, or already has a blank line in it. */
export function hasParagraphBreaks(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= PARAGRAPH_MIN_CHARS || /\n\s*\n/.test(trimmed);
}

/**
 * Combines the mechanical checks (brand vocabulary, anti-slop, originality)
 * into a single pass/fail gate that content must clear before advancing
 * past 'anti_slop_review'/'originality_review' stages in the Campaign
 * Factory pipeline. This does NOT replace the LLM review agents (trader,
 * hook_specialist, brand_guardian, etc. — Phase 6 deep review, gated on an
 * AI provider key) — it's the cheap, always-on backstop that runs first.
 */
export class ContentQualityGate {
  private originality = new OriginalityEngine();

  constructor(private brandConstitution: BrandConstitution) {}

  async check(candidateText: string, recentTextsForSameTopic: string[], options: { isVideo?: boolean; requireParagraphs?: boolean } = {}): Promise<QualityGateResult> {
    const vocabularyViolations = await this.brandConstitution.checkVocabulary(candidateText);
    const slopFindings = checkAntiSlop(candidateText, { isVideo: options.isVideo });
    const similarities = options.isVideo
      ? this.originality.compareAgainstRecent(spokenScriptOf(candidateText), recentTextsForSameTopic.map(spokenScriptOf))
      : this.originality.compareAgainstRecent(candidateText, recentTextsForSameTopic);
    const maxSimilarity = similarities[0]?.similarity ?? 0;

    const blockReasons: string[] = [];
    if (vocabularyViolations.length > 0) {
      blockReasons.push(`${vocabularyViolations.length} brand vocabulary/claim violation(s)`);
    }
    if (slopFindings.length > 0) {
      const details = slopFindings.map((f) => `${f.rule}: ${f.detail}`).join("; ");
      console.error(`[quality-gate] anti-slop findings: ${details}`);
      blockReasons.push(`${slopFindings.length} anti-slop finding(s): ${details}`);
    }
    if (maxSimilarity >= ORIGINALITY_THRESHOLD) {
      blockReasons.push(`too similar to recent content (${(maxSimilarity * 100).toFixed(0)}% overlap)`);
    }

    if (options.requireParagraphs && !hasParagraphBreaks(candidateText)) {
      blockReasons.push("x post is one block of text: put the hook, the point and the Fillbook line on separate paragraphs with a blank line between");
    }

    return {
      passed: blockReasons.length === 0,
      vocabularyViolations,
      slopFindings,
      maxSimilarity,
      blockReasons,
    };
  }
}
