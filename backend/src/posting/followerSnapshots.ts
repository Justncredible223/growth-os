import type { SupabaseClient } from "@supabase/supabase-js";
import { arizonaDayKey } from "../engagement/policy.js";

/**
 * Daily follower count for @FillbookHQ (2026-10-15). Nothing recorded follower numbers over time, so a drop could not be
 * tied to anything: not to a day, a reply, a giveaway or a post. One row per Arizona day is enough to answer "when did we
 * lose them" and to line a drop up against x_own_posts (what was posted that day) and the reply log.
 *
 * Cost: the numbers come back on the GET /users/me call that other steps already make in the same run
 * (RunScopedXReads.resolveOwnProfile), so a normal run adds no read. A run where nothing else asked pays that one
 * /users/me read, at most once a day because today's row, once written, ends the step.
 *
 * It cannot say WHO unfollowed: X's followers list is a paid read per follower page, so that is deliberately not built.
 */
export const FOLLOWER_TABLE = "x_follower_snapshots";

export interface FollowerSnapshotRow {
  day: string;
  followers: number;
}

export interface OwnProfileNumbers {
  followers: number | null;
  following: number | null;
  tweetCount: number | null;
}

/** True for the error a not-yet-applied migration produces (Postgres 42P01 or PostgREST's schema-cache miss). */
export function isMissingFollowerTable(message: string): boolean {
  return /x_follower_snapshots/.test(message) && /(does not exist|schema cache|PGRST205|42P01)/i.test(message);
}

/** "812 followers (+3 vs yesterday, -9 over 7 days)". Uses only days that exist: a gap is said, never filled in. */
export function summarizeFollowerChange(todayDay: string, followers: number, history: FollowerSnapshotRow[]): string {
  const before = history.filter((r) => r.day < todayDay).sort((a, b) => b.day.localeCompare(a.day));
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  const parts: string[] = [];
  const prev = before[0];
  if (prev) {
    const gap = Math.round((Date.parse(`${todayDay}T00:00:00Z`) - Date.parse(`${prev.day}T00:00:00Z`)) / 86_400_000);
    parts.push(`${signed(followers - prev.followers)} ${gap === 1 ? "vs yesterday" : `vs ${prev.day}`}`);
  }
  const weekAgo = before.find((r) => Date.parse(`${todayDay}T00:00:00Z`) - Date.parse(`${r.day}T00:00:00Z`) >= 7 * 86_400_000);
  if (weekAgo) parts.push(`${signed(followers - weekAgo.followers)} over 7 days`);
  return parts.length ? `${followers} followers (${parts.join(", ")})` : `${followers} followers (first reading, nothing to compare yet)`;
}

export interface FollowerStepDeps {
  client: SupabaseClient;
  now: Date;
  /** Lazy: a skipped run makes no X call at all. */
  fetchProfile: () => Promise<OwnProfileNumbers>;
}

/** The pulse step. Returns the one-line report shown in the step list. */
export async function runFollowerSnapshotStep({ client, now, fetchProfile }: FollowerStepDeps): Promise<string> {
  const day = arizonaDayKey(now);
  const since = new Date(now.getTime() - 14 * 86_400_000);
  const { data, error } = await client
    .from(FOLLOWER_TABLE)
    .select("day, followers")
    .gte("day", arizonaDayKey(since))
    .order("day", { ascending: false });
  if (error) {
    if (isMissingFollowerTable(`${error.message} ${error.code ?? ""}`)) return "skipped -- migration 0053 not applied yet";
    throw new Error(`${FOLLOWER_TABLE}: read failed: ${error.message}`);
  }
  const history = (data ?? []).map((r) => ({ day: String(r.day), followers: Number(r.followers) }));
  const todays = history.find((r) => r.day === day);
  if (todays) return `already recorded today: ${summarizeFollowerChange(day, todays.followers, history)}`;

  const profile = await fetchProfile();
  if (profile.followers === null) return "profile read returned no follower count -- nothing recorded";
  const { error: writeError } = await client
    .from(FOLLOWER_TABLE)
    .upsert({ day, followers: profile.followers, following: profile.following, tweet_count: profile.tweetCount, captured_at: now.toISOString() }, { onConflict: "day" });
  if (writeError) throw new Error(`${FOLLOWER_TABLE}: write failed: ${writeError.message}`);
  return summarizeFollowerChange(day, profile.followers, history);
}
