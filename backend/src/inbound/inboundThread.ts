import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboundEngagement } from "./types.js";

/**
 * Rebuilds the conversation behind an inbound reply (2026-10-17).
 *
 * Why: when someone replied to our reply, Inbound stored only their one message ("how so"), with the parent text left empty
 * ("needs a second API call"). So the draft for a back-and-forth was written blind and said "I don't have context for what
 * you're asking about". The thread is already stored, in pieces, so no extra X call is needed:
 *   - what WE posted: x_own_posts (tweet text, and which tweet it replied to);
 *   - what THEY said earlier: inbound_engagements (same conversation id), plus our response to each (the posted reply, else the
 *     owner's final wording, else the draft the owner marked responded);
 *   - the post we first replied to: the Prospecting candidate that reply came from (post_text, author_handle).
 * Nothing here calls X or any write endpoint.
 */
export interface ThreadTurn {
  /** "original" is the post we first replied to; "us" is @FillbookHQ; "them" is the person (or anyone else in the thread). */
  who: "original" | "us" | "them";
  handle: string | null;
  text: string;
  /** ISO time, used only to order turns; null sorts first (the original post). */
  at: string | null;
}

/** How many turns reach the drafter (the newest), and how long each may be. */
export const MAX_THREAD_TURNS = 8;
export const MAX_TURN_CHARS = 400;
/** Parent hops followed when walking up from the message. */
const MAX_HOPS = 8;

const clip = (t: string): string => {
  const flat = t.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TURN_CHARS ? `${flat.slice(0, MAX_TURN_CHARS - 1)}…` : flat;
};

const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

interface OwnPost {
  tweet_id: string;
  text: string;
  created_at: string;
  in_reply_to_tweet_id: string | null;
  prospecting_candidate_id: string | null;
}

async function ownPostsById(client: SupabaseClient, ids: string[]): Promise<Map<string, OwnPost>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await client.from("x_own_posts").select("tweet_id, text, created_at, in_reply_to_tweet_id, prospecting_candidate_id").in("tweet_id", ids);
  if (error) return new Map(); // best effort: a missing table or read error just means less context, never a failed draft
  return new Map(((data ?? []) as OwnPost[]).map((p) => [p.tweet_id, p]));
}

async function ownRepliesTo(client: SupabaseClient, parentIds: string[]): Promise<Map<string, OwnPost>> {
  if (parentIds.length === 0) return new Map();
  const { data, error } = await client.from("x_own_posts").select("tweet_id, text, created_at, in_reply_to_tweet_id, prospecting_candidate_id").in("in_reply_to_tweet_id", parentIds);
  if (error) return new Map();
  return new Map(((data ?? []) as OwnPost[]).filter((p) => p.in_reply_to_tweet_id).map((p) => [p.in_reply_to_tweet_id as string, p]));
}

interface InboundRow {
  id: string;
  external_id: string;
  author_handle: string | null;
  body: string;
  in_reply_to_external_id: string | null;
  observed_at: string;
  status: string;
  draft_response: string | null;
  final_response: string | null;
}

const INBOUND_COLUMNS = "id, external_id, author_handle, body, in_reply_to_external_id, observed_at, status, draft_response, final_response";

/**
 * The turns before `row`, oldest first. Empty when nothing earlier is known (a first message, or a thread that began before
 * these tables did).
 */
export async function buildInboundThread(client: SupabaseClient, row: InboundEngagement): Promise<ThreadTurn[]> {
  if (row.platform !== "x") return [];
  const turns = new Map<string, ThreadTurn>(); // keyed by tweet id (or "row:<id>") so the two routes never double up
  let candidateId: string | null = null;

  // 1. Walk up the reply chain from the message.
  const seen = new Set<string>([row.externalId]);
  let parent = row.inReplyToExternalId;
  for (let hop = 0; hop < MAX_HOPS && parent && !seen.has(parent); hop++) {
    seen.add(parent);
    const own = (await ownPostsById(client, [parent])).get(parent);
    if (own) {
      turns.set(parent, { who: "us", handle: "FillbookHQ", text: clip(own.text), at: own.created_at });
      candidateId = own.prospecting_candidate_id ?? candidateId;
      parent = own.in_reply_to_tweet_id;
      continue;
    }
    const { data } = await client.from("inbound_engagements").select(INBOUND_COLUMNS).eq("platform", "x").eq("external_id", parent).maybeSingle();
    const earlier = data as InboundRow | null;
    if (earlier) {
      turns.set(parent, { who: "them", handle: earlier.author_handle, text: clip(earlier.body), at: earlier.observed_at });
      parent = earlier.in_reply_to_external_id;
      continue;
    }
    break;
  }

  // 2. Earlier messages in the same conversation, with what we answered each one (covers an answer x_own_posts has not read back yet).
  if (row.conversationId) {
    const { data } = await client.from("inbound_engagements").select(INBOUND_COLUMNS).eq("conversation_id", row.conversationId).lt("observed_at", row.observedAt).order("observed_at", { ascending: true }).limit(20);
    const earlier = ((data ?? []) as InboundRow[]).filter((r) => r.external_id !== row.externalId);
    const answers = await ownRepliesTo(client, earlier.map((r) => r.external_id));
    for (const r of earlier) {
      if (!turns.has(r.external_id)) turns.set(r.external_id, { who: "them", handle: r.author_handle, text: clip(r.body), at: r.observed_at });
      const posted = answers.get(r.external_id);
      if (posted) {
        if (!turns.has(posted.tweet_id)) turns.set(posted.tweet_id, { who: "us", handle: "FillbookHQ", text: clip(posted.text), at: posted.created_at });
        candidateId = posted.prospecting_candidate_id ?? candidateId;
      } else if (r.status === "responded" || r.status === "follow_up") {
        const said = (r.final_response ?? r.draft_response)?.trim();
        // A just-posted reply has no tweet id yet; place it right after the message it answered.
        if (said) turns.set(`row:${r.id}`, { who: "us", handle: "FillbookHQ", text: clip(said), at: new Date(Date.parse(r.observed_at) + 1000).toISOString() });
      }
    }
  }

  // 3. The post we first replied to, from Prospecting.
  const ordered = [...turns.values()].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  if (candidateId) {
    const { data } = await client.from("prospecting_candidates").select("author_handle, post_text").eq("id", candidateId).maybeSingle();
    const c = data as { author_handle: string | null; post_text: string } | null;
    if (c?.post_text) ordered.unshift({ who: "original", handle: c.author_handle, text: clip(c.post_text), at: null });
  }

  // Drop an exact repeat (the same words twice in a row, e.g. a draft and the tweet it became), then keep the newest turns.
  const out: ThreadTurn[] = [];
  for (const t of ordered) {
    const prev = out[out.length - 1];
    if (prev && prev.who === t.who && norm(prev.text) === norm(t.text)) continue;
    out.push(t);
  }
  const original = out[0]?.who === "original" ? out[0] : null;
  const rest = original ? out.slice(1) : out;
  const kept = rest.slice(-(MAX_THREAD_TURNS - (original ? 1 : 0)));
  return original ? [original, ...kept] : kept;
}

/** The thread as plain lines for the drafter and for the card, oldest first. Empty string when there are no earlier turns. */
export function formatThread(turns: ThreadTurn[]): string {
  return turns
    .map((t) => {
      const who = t.who === "us" ? "Fillbook (us)" : t.who === "original" ? `${t.handle ? `@${t.handle}` : "Original post"} (the post we replied to)` : t.handle ? `@${t.handle}` : "Them";
      return `${who}: ${t.text}`;
    })
    .join("\n");
}
