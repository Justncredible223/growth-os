import { containsBannedGenericPhrase, containsFalseGiveawayClaim, containsLink, containsUnverifiedClaim, dashProblem } from "./xReplyGuardrails.js";
import { cardNumbersTraceToPost, type XPostImageCard } from "./xPostImageCard.js";

/**
 * The receipt shown under Today's X Post (team decision 2026-11-08: ChatGPT, Gemini and App agreed the owner could not see WHY a draft was
 * trustworthy). Every line is computed from the saved draft right now, never claimed: the reviewer count is read from the saved verdicts,
 * the rest is the same mechanical checks our own guards run. A failing line says so; nothing is shown green that was not checked.
 */
export interface ReceiptItem {
  label: string;
  ok: boolean;
}

/** Share of the words of the shorter text found in the other (0 to 1), ignoring case, links and punctuation. */
export function wordOverlap(a: string, b: string): number {
  const norm = (t: string) => t.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9$%]+/g, " ").trim().split(" ").filter(Boolean);
  const wa = norm(a);
  const wb = norm(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const pool = new Map<string, number>();
  for (const w of long) pool.set(w, (pool.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of short) {
    const n = pool.get(w) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(w, n - 1);
    }
  }
  return hit / short.length;
}

/** A new draft this similar (word overlap) to a recently posted one is flagged as a repeat. */
export const REPEAT_OVERLAP = 0.6;

export interface ReceiptInput {
  text: string;
  /** Saved verdicts for this exact draft version: how many reviewers passed out of how many ran. total 0 = no record found. */
  reviewersPassed: number;
  reviewersTotal: number;
  /** What was really posted in the last couple of weeks (the posted text, else the draft). */
  recentPostedTexts: string[];
  imageCard: XPostImageCard | null;
}

export function buildPostReceipt(input: ReceiptInput): ReceiptItem[] {
  const { text } = input;
  const items: ReceiptItem[] = [];
  if (input.reviewersTotal > 0) {
    items.push({ label: `${input.reviewersPassed} of ${input.reviewersTotal} reviewers passed this exact draft`, ok: input.reviewersPassed === input.reviewersTotal });
  } else {
    items.push({ label: "No review record found for this draft", ok: false });
  }
  items.push({ label: containsLink(text) ? "Contains a link" : "No links", ok: !containsLink(text) });
  const wording = containsBannedGenericPhrase(text) ?? containsUnverifiedClaim(text) ?? containsFalseGiveawayClaim(text) ?? dashProblem(text);
  items.push({ label: wording ? `Wording: ${wording.reason}` : "No dashes, no banned wording, no unverified claims", ok: wording === null });
  const card = input.imageCard;
  if (card && card.numbers.length > 0) {
    const traced = cardNumbersTraceToPost(card, text);
    items.push({ label: traced ? "Every figure in the picture is in the post" : "A figure in the picture is not in the post", ok: traced });
    items.push({ label: "Picture is labelled sample data", ok: card.sampleData });
  }
  const worst = input.recentPostedTexts.reduce((m, t) => Math.max(m, wordOverlap(text, t)), 0);
  items.push({ label: worst >= REPEAT_OVERLAP ? "Close to a recent post" : "Different from your recent posts", ok: worst < REPEAT_OVERLAP });
  return items;
}
