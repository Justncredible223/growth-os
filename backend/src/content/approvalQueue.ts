import { REPEAT_OVERLAP, wordOverlap } from "./xPostReceipt.js";

/**
 * Approvals queue helpers (P1, ChatGPT 2026-11-15): where a draft came from, a readable title, and how many other waiting drafts say
 * nearly the same thing. Pure, unit-tested.
 */
export type ApprovalSource = "hq" | "auto" | "video" | "manual";

export function approvalSource(input: { assetType: string; isAutoDraft: boolean; metadataSource?: unknown }): ApprovalSource {
  if (input.metadataSource === "hq_handoff") return "hq";
  if (input.assetType === "video_script") return "video";
  if (input.isAutoDraft) return "auto";
  return "manual";
}

/** The first line or sentence of the post (an HQ campaign title such as "HQ X draft hq-140" tells the owner nothing). At most 90 characters, cut at a word. */
export function readableTitle(text: string, fallback: string): string {
  const first = (text.split(/\n/).find((l) => l.trim().length > 0) ?? "").trim();
  const sentence = (first.split(/(?<=[.!?])\s/)[0] ?? first).trim();
  if (!sentence) return fallback;
  if (sentence.length <= 90) return sentence;
  const cut = sentence.slice(0, 87);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd()}...`;
}

/** For each draft, how many OTHER waiting drafts overlap it at the repeat bar (same bar as Today's X Post receipt). */
export function similarCounts(texts: string[]): number[] {
  return texts.map((t, i) => texts.filter((u, j) => j !== i && t.trim() && u.trim() && wordOverlap(t, u) >= REPEAT_OVERLAP).length);
}
