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

/**
 * The wording for a chart-illustration video (a strategy or concept drawn on a made-up chart, not a screen of the app).
 * "Open this same screen" would promise something the video never showed, so it says what the video is instead (owner
 * team decision 2026-11-03; Marketing's YouTube pin for Day 18 uses the same statement). No URL, for the same reason as above.
 */
export const PINNED_COMMENT_ILLUSTRATION = `Illustration only, not a recommendation or financial advice. Fillbook is a trading journal for futures traders: ${PINNED_COMMENT_PHRASE}.`;

/** True when the video's own description says its charts are drawn illustrations (the strategy-chart videos). */
export function isIllustrationVideo(description: string | null | undefined): boolean {
  return typeof description === "string" && /drawn illustration/i.test(description);
}

/** The comment to pin under a video: the illustration wording for drawn-chart videos, otherwise the sample-account invitation. */
export function buildPinnedComment(_hook: string, _campaignAssetId?: string, description?: string | null): string {
  return isIllustrationVideo(description) ? PINNED_COMMENT_ILLUSTRATION : PINNED_COMMENT;
}
