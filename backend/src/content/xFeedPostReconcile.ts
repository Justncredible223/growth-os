import type { SupabaseClient } from "@supabase/supabase-js";
import type { XFeedPostRun } from "./dailyXFeedPost.js";

/**
 * Knowing a post went out without relying on the owner's "Mark posted" tap (team decision 2026-11-08: ChatGPT, Gemini and App agreed).
 *
 * Only 2 of the last 14 days were marked posted, so the history and the originality check (which compares a new draft with what was
 * REALLY posted) could not be trusted. The app already reads the account's own recent tweets three times a day into x_own_posts
 * (src/posting/ownPostsRefresh.ts), so this adds no X call and no cost: it matches each unposted draft against those saved tweets and,
 * when one is clearly the same text, records it as posted (with the tweet's real time and text). It never marks anything as posted on a
 * weak match, never un-posts, and the manual Mark posted stays as a correction.
 */

/** A tweet counts as the draft when at least this share of the words match (after normalising). */
export const RECONCILE_MIN_SIMILARITY = 0.8;
/** Look back this many operating days for drafts still unmarked. */
export const RECONCILE_LOOKBACK_DAYS = 5;

export interface OwnTweetRow {
  tweet_id: string;
  text: string;
  created_at: string;
  in_reply_to_tweet_id: string | null;
}

/** Lower case, links removed, everything but letters and digits turned to single spaces. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9$%.,]+/g, " ")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Share of the words of the shorter text that appear in the other (0 to 1). Order-insensitive, so a small edit does not break the match. */
export function wordOverlap(a: string, b: string): number {
  const wa = normalizeForMatch(a).split(" ").filter(Boolean);
  const wb = normalizeForMatch(b).split(" ").filter(Boolean);
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

/** The tweet that is clearly this draft, or null. A reply never matches (the daily post is a top-level post). */
export function matchDraftToTweet(draftText: string, tweets: OwnTweetRow[]): OwnTweetRow | null {
  let best: { tweet: OwnTweetRow; score: number } | null = null;
  for (const t of tweets) {
    if (t.in_reply_to_tweet_id) continue;
    const score = wordOverlap(draftText, t.text);
    if (score >= RECONCILE_MIN_SIMILARITY && (!best || score > best.score)) best = { tweet: t, score };
  }
  return best?.tweet ?? null;
}

export interface ReconcileDeps {
  listRecentRuns(sinceOperatingDate: string): Promise<XFeedPostRun[]>;
  markPosted(operatingDate: string, postedAt: string, postedText: string): Promise<void>;
  /** The latest saved draft text for a campaign asset, or null. */
  draftTextFor(campaignAssetId: string): Promise<string | null>;
  /** Saved own tweets created at or after this ISO time. */
  ownTweetsSince(sinceIso: string): Promise<OwnTweetRow[]>;
}

export interface ReconcileResult {
  checked: number;
  matched: number;
  /** Operating dates marked posted this time. */
  markedDates: string[];
}

export async function reconcilePostedDrafts(deps: ReconcileDeps, now: Date = new Date()): Promise<ReconcileResult> {
  const sinceDate = new Date(now.getTime() - RECONCILE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const runs = (await deps.listRecentRuns(sinceDate)).filter((r) => r.status === "ready" && !r.postedAt && r.campaignAssetId && !r.dismissed);
  const result: ReconcileResult = { checked: runs.length, matched: 0, markedDates: [] };
  if (runs.length === 0) return result;
  // A draft can be posted the day before its operating date ends or the day after, so read tweets from two days before the oldest run.
  const oldest = runs.reduce((a, r) => (r.operatingDate < a ? r.operatingDate : a), runs[0]!.operatingDate);
  const tweets = await deps.ownTweetsSince(new Date(new Date(`${oldest}T00:00:00Z`).getTime() - 2 * 24 * 60 * 60 * 1000).toISOString());
  const taken = new Set<string>();
  for (const run of runs.sort((a, b) => (a.operatingDate < b.operatingDate ? -1 : 1))) {
    const draft = await deps.draftTextFor(run.campaignAssetId as string);
    if (!draft) continue;
    const match = matchDraftToTweet(draft, tweets.filter((t) => !taken.has(t.tweet_id)));
    if (!match) continue;
    taken.add(match.tweet_id);
    await deps.markPosted(run.operatingDate, match.created_at, match.text);
    result.matched++;
    result.markedDates.push(run.operatingDate);
  }
  return result;
}

/** The real dependencies: Supabase for the saved draft text and the saved own tweets. */
export function supabaseReconcileDeps(
  client: SupabaseClient,
  runRepo: { listRecentRuns(since: string): Promise<XFeedPostRun[]>; markPosted(d: string, at: string, text: string): Promise<void> },
): ReconcileDeps {
  return {
    listRecentRuns: (since) => runRepo.listRecentRuns(since),
    markPosted: (d, at, text) => runRepo.markPosted(d, at, text),
    draftTextFor: async (assetId) => {
      const { data, error } = await client.from("content_versions").select("body").eq("campaign_asset_id", assetId).order("version", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`draft lookup failed: ${error.message}`);
      return (data as { body: string } | null)?.body ?? null;
    },
    ownTweetsSince: async (sinceIso) => {
      const { data, error } = await client.from("x_own_posts").select("tweet_id, text, created_at, in_reply_to_tweet_id").gte("created_at", sinceIso).limit(500);
      if (error) throw new Error(`own tweets lookup failed: ${error.message}`);
      return (data ?? []) as OwnTweetRow[];
    },
  };
}
