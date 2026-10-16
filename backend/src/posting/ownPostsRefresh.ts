import type { SupabaseClient } from "@supabase/supabase-js";
import type { XOwnTweet } from "../signals/adapters/xAdapter.js";

/**
 * Cost control for the Results own-tweets read (x_own_posts step of api/growth-pulse.ts, `users/tweets`, Owned Reads,
 * $0.001 per tweet returned).
 *
 * Before: every pulse slot (3 a day) re-read the newest 60 tweets, $0.18/day. What the data is used for: the reply-visibility
 * alert (postingPlan.ts assessReplyVisibility) compares replies 12h-3d old against replies 3-21d old, and per-reply results.
 * A tweet's views are final after about 3 days, so only the last ~3 days of tweets ever need their numbers refreshed, and a
 * once-a-day refresh still sees every reply at the 12h+ age the alert judges it at.
 */

/**
 * Minimum gap between own-tweet reads. 0 (every pulse slot, 3 a day) since 2026-10-16: the once-a-day gate (20h) was in place from
 * 2026-10-14 and recovery mode (2 replies a day) switched on while it was; a fresher read keeps the 12h-3d reply bucket's views
 * current, which the reply-visibility alert compares against older replies, so the gate may have biased the alert toward "dropped".
 * Raise it again (20 * 60 * 60 * 1000 = once a day, about $0.12/day saved) once recovery behaviour is understood.
 */
export const OWN_POSTS_MIN_INTERVAL_MS = 0;
/** Tweets this old or older have settled views and are never re-read. */
export const OWN_POSTS_REFRESH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** Room for tweets posted since the last read (reply cap is 15/day, plus own posts). */
export const OWN_POSTS_NEW_TWEET_MARGIN = 20;
export const OWN_POSTS_MIN_READ = 60;
export const OWN_POSTS_MAX_READ = 60;
export const OWN_POSTS_COST_PER_TWEET_USD = 0.001;

export interface OwnPostsSyncState {
  /** Newest metrics_updated_at across x_own_posts, or null when the table is empty. */
  lastSyncedAt: Date | null;
  /** Rows created inside the refresh window. */
  recentCount: number;
}

export type OwnPostsReadPlan = { skip: true; reason: string } | { skip: false; maxResults: number };

/** Pure: whether this pulse slot should read own tweets at all, and how many. */
export interface OwnPostsReadConfig {
  minIntervalMs: number;
  minRead: number;
}
export const DEFAULT_OWN_POSTS_CONFIG: OwnPostsReadConfig = { minIntervalMs: OWN_POSTS_MIN_INTERVAL_MS, minRead: OWN_POSTS_MIN_READ };

export function planOwnPostsRead(state: OwnPostsSyncState, now: Date, force = false, config: OwnPostsReadConfig = DEFAULT_OWN_POSTS_CONFIG): OwnPostsReadPlan {
  if (!force && state.lastSyncedAt && config.minIntervalMs > 0) {
    const ageMs = now.getTime() - state.lastSyncedAt.getTime();
    if (ageMs < config.minIntervalMs) {
      return { skip: true, reason: `skipped -- own tweets refreshed ${(ageMs / 3600000).toFixed(1)}h ago (once a day)` };
    }
  }
  const wanted = state.recentCount + OWN_POSTS_NEW_TWEET_MARGIN;
  return { skip: false, maxResults: Math.min(OWN_POSTS_MAX_READ, Math.max(config.minRead, wanted)) };
}

export async function loadOwnPostsSyncState(client: SupabaseClient, now: Date): Promise<OwnPostsSyncState> {
  const { data: last, error: lastError } = await client.from("x_own_posts").select("metrics_updated_at").order("metrics_updated_at", { ascending: false }).limit(1);
  if (lastError) throw new Error(`x_own_posts: last-sync lookup failed: ${lastError.message}`);
  const raw = (last as Array<{ metrics_updated_at: string | null }> | null)?.[0]?.metrics_updated_at ?? null;
  const since = new Date(now.getTime() - OWN_POSTS_REFRESH_WINDOW_MS).toISOString();
  const { count, error: countError } = await client.from("x_own_posts").select("tweet_id", { count: "exact", head: true }).gte("created_at", since);
  if (countError) throw new Error(`x_own_posts: recent count failed: ${countError.message}`);
  return { lastSyncedAt: raw ? new Date(raw) : null, recentCount: count ?? 0 };
}

export interface OwnPostsStepDeps {
  state: OwnPostsSyncState;
  now: Date;
  force?: boolean;
  config?: OwnPostsReadConfig;
  fetchOwnTweets: (maxResults: number) => Promise<XOwnTweet[]>;
  recordCost: (tweetsRead: number) => Promise<number>;
  save: (tweets: XOwnTweet[]) => Promise<{ saved: number; replies: number; matched: number }>;
}

/** The step body, with its collaborators injected so the cadence and sizing are unit-testable. Returns the step summary line. */
export async function runOwnPostsStep(deps: OwnPostsStepDeps): Promise<string> {
  const plan = planOwnPostsRead(deps.state, deps.now, deps.force, deps.config);
  if (plan.skip) return `${plan.reason}; X reads: 0 tweets $0.000; LLM: 0 calls $0.0000`;
  const tweets = await deps.fetchOwnTweets(plan.maxResults);
  const cost = await deps.recordCost(tweets.length);
  const saved = await deps.save(tweets);
  return `${saved.saved} own tweets (${saved.replies} replies, ${saved.matched} matched to Prospecting); X reads: ${tweets.length} tweets $${cost.toFixed(3)} (asked for ${plan.maxResults}); LLM: 0 calls $0.0000`;
}
