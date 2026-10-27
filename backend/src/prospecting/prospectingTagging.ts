import { createHash } from "node:crypto";

/**
 * Occasional @-tagging in Prospecting replies (owner request 2026-10-27). A reply thread seen by a tagged big account can travel far
 * (a ~30-follower thread that tagged a large account gave a reply 10k views), but a reply that pulls in random accounts reads as spam.
 * So tagging is allowed only for an account the post ITSELF already names, only one per reply, only on about one draft in
 * TAG_ONE_IN, and the reply must say something to or about what that account is doing. The owner still reviews every draft.
 */
export const TAG_ONE_IN = 5;
const OWN_HANDLES = new Set(["fillbookhq"]);
const HANDLE_IN_TEXT = /(?<![\w@])@([A-Za-z0-9_]{1,15})\b/g;

/** Handles the post itself @-mentions, without the post's author and without our own account, in order of first appearance. */
export function taggableHandles(postText: string, authorHandle: string | null): string[] {
  const author = (authorHandle ?? "").replace(/^@/, "").toLowerCase();
  const out: string[] = [];
  for (const m of postText.matchAll(HANDLE_IN_TEXT)) {
    const handle = m[1]!;
    const key = handle.toLowerCase();
    if (key === author || OWN_HANDLES.has(key) || out.some((h) => h.toLowerCase() === key)) continue;
    out.push(handle);
  }
  return out;
}

/** Stable per candidate (a retry or a second tap makes the same call): true for about one candidate in TAG_ONE_IN. */
export function tagGateOpen(candidateId: string): boolean {
  const n = createHash("sha256").update(candidateId).digest().readUInt32BE(0);
  return n % TAG_ONE_IN === 0;
}

/** The draft's user-message note when tagging is allowed for this post. */
export function tagNote(allowed: readonly string[]): string {
  const list = allowed.map((h) => `@${h}`).join(", ");
  return [
    `Tagging is ALLOWED for this post, but only if it truly fits: you may put ONE of these accounts in the reply, because the post already names them: ${list}.`,
    "Tag one only when your reply speaks directly to what that account said or is doing in this post (it answers them, adds to their point, or their situation is the point of your reply).",
    "If it does not clearly pertain to them, do not tag anyone. Never tag any other account. The tag must read naturally inside a real sentence, never as a list or a lead-in.",
  ].join("\n");
}

/**
 * A mechanical safety net behind the prompt. Returns the reason a reply's @-tags are not acceptable, or null.
 * With tagging closed (allowed is empty) any @handle is a problem; with it open, at most one tag, from the allowed list, and the
 * words around the tag must still carry the reply.
 */
export function replyTagProblem(reply: string, allowed: readonly string[]): string | null {
  const tags = [...reply.matchAll(HANDLE_IN_TEXT)].map((m) => m[1]!);
  if (tags.length === 0) return null;
  if (allowed.length === 0) return "tags an account (@handle) but tagging is not allowed for this post -- remove every @handle";
  if (tags.length > 1) return "tags more than one account -- tag at most one, or none";
  const ok = allowed.some((h) => h.toLowerCase() === tags[0]!.toLowerCase());
  if (!ok) return `tags @${tags[0]} who is not named in the post -- only tag an account the post itself mentions`;
  const withoutTag = reply.replace(HANDLE_IN_TEXT, "").replace(/\s+/g, " ").trim();
  if (withoutTag.length < 40) return "is mostly a tag -- the reply must stand on its own words";
  return null;
}
