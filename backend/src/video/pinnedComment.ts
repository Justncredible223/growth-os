/**
 * The comment the owner posts and pins under each video, pointing viewers to the free sample through the bio link (owner
 * decision 2026-10-04: TikTok does not make links in comments tappable, and a comment with a link was also tagged "Promotional
 * content", so the comment says "link in bio" and carries no URL). It is shown on Video Status with a Copy button; posting and
 * pinning stay the owner's manual step, because neither TikTok's nor YouTube's API can pin a comment (and nothing in this
 * system posts to a platform without the owner).
 *
 * Plain text with no markup. Every line says the data is sample data, never says "live" or "real-time" about tracking,
 * promises no result, and gives no trading advice. The per-video tagged link (2026-10-04, PR 117) was dropped with the URL:
 * a bio link cannot carry a different tag per video.
 */
export const PINNED_COMMENT_PHRASE = "link in bio";

/** One wording for every video: the invitation first (TikTok's bubble preview cuts a comment off near 70 characters), then the plain statement that this is a sample account. */
export const PINNED_COMMENT = `Open this same screen with the demo data yourself: ${PINNED_COMMENT_PHRASE}. Sample account, not a real trader's data.`;

/** The comment to pin under a video. Kept as a function of the hook so callers need not change if wordings ever vary again. */
export function buildPinnedComment(_hook: string, _campaignAssetId?: string): string {
  return PINNED_COMMENT;
}
