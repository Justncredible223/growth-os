import type { SupabaseClient } from "@supabase/supabase-js";
import { arizonaDayKey } from "../engagement/policy.js";
import { summarizeFollowerChange } from "./followerSnapshots.js";

/**
 * Daily follower counts for YouTube, TikTok and Instagram (2026-10-15), the sibling of x_follower_snapshots.
 *
 * YouTube: one channels.list (part=statistics, 1 quota unit) a day from the daily pipeline, using the existing read-only
 * API key. The public count is what the channel page shows; it is hidden when the channel hides subscribers.
 * TikTok / Instagram: no read access for this, so the owner types the number in and it is stored the same way.
 */
export const PLATFORM_FOLLOWER_TABLE = "platform_follower_snapshots";
export const FOLLOWER_PLATFORMS = ["youtube", "tiktok", "instagram"] as const;
export type FollowerPlatform = (typeof FOLLOWER_PLATFORMS)[number];
export const isFollowerPlatform = (v: unknown): v is FollowerPlatform => FOLLOWER_PLATFORMS.includes(v as FollowerPlatform);

/** The channel id (UC...) or @handle to read when YOUTUBE_CHANNEL is not set. */
export const DEFAULT_YOUTUBE_CHANNEL = "@FillbookHQ";

export function isMissingPlatformFollowerTable(message: string): boolean {
  return /platform_follower_snapshots/.test(message) && /(does not exist|schema cache|PGRST205|42P01)/i.test(message);
}

export class FollowerInputError extends Error {}

/** A follower count typed by the owner: a whole number from 0 up. Anything else is refused, never rounded. */
export function parseFollowerCount(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value.replace(/[,\s]/g, "")) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 1_000_000_000) {
    throw new FollowerInputError("followers must be a whole number, 0 or more");
  }
  return n;
}

interface HistoryRow {
  day: string;
  followers: number;
}

/** Last 14 days for one platform, or null when migration 0054 is not applied yet. */
async function recentHistory(client: SupabaseClient, platform: FollowerPlatform, now: Date): Promise<HistoryRow[] | null> {
  const since = arizonaDayKey(new Date(now.getTime() - 14 * 86_400_000));
  const { data, error } = await client
    .from(PLATFORM_FOLLOWER_TABLE)
    .select("day, followers")
    .eq("platform", platform)
    .gte("day", since)
    .order("day", { ascending: false });
  if (error) {
    if (isMissingPlatformFollowerTable(`${error.message} ${error.code ?? ""}`)) return null;
    throw new Error(`${PLATFORM_FOLLOWER_TABLE}: read failed: ${error.message}`);
  }
  return (data ?? []).map((r) => ({ day: String(r.day), followers: Number(r.followers) }));
}

/** Saves one reading for today (Arizona day), replacing an earlier one the same day. Returns the change line. */
export async function recordPlatformFollowers(
  client: SupabaseClient,
  platform: FollowerPlatform,
  followers: number,
  now: Date,
  source: "api" | "manual",
): Promise<string> {
  const day = arizonaDayKey(now);
  const history = await recentHistory(client, platform, now);
  if (history === null) return "skipped -- migration 0054 not applied yet";
  const { error } = await client
    .from(PLATFORM_FOLLOWER_TABLE)
    .upsert({ platform, day, followers, source, captured_at: now.toISOString() }, { onConflict: "platform,day" });
  if (error) throw new Error(`${PLATFORM_FOLLOWER_TABLE}: write failed: ${error.message}`);
  return summarizeFollowerChange(day, followers, history);
}

/** Subscriber count from channels.list, or null when the channel is not found or hides its count. */
export async function fetchYoutubeSubscribers(channel: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const params = new URLSearchParams({ part: "statistics" });
  if (channel.startsWith("@")) params.set("forHandle", channel);
  else params.set("id", channel);
  const res = await fetchImpl(`https://www.googleapis.com/youtube/v3/channels?${params.toString()}`, {
    headers: { "x-goog-api-key": apiKey, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`YouTube channels.list failed: HTTP ${res.status} -- ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { items?: Array<{ statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }> };
  const stats = json.items?.[0]?.statistics;
  if (!stats || stats.hiddenSubscriberCount) return null;
  const n = Number(stats.subscriberCount);
  return Number.isFinite(n) ? n : null;
}

export interface YoutubeFollowerDeps {
  client: SupabaseClient;
  now: Date;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

const asSubscribers = (line: string) => line.replace("followers", "subscribers");

/** The daily pipeline step. At most one read a day: a row already written today ends it. */
export async function runYoutubeFollowerStep({ client, now, env = process.env, fetchImpl }: YoutubeFollowerDeps): Promise<string> {
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) return "skipped -- YOUTUBE_API_KEY not configured";
  const history = await recentHistory(client, "youtube", now);
  if (history === null) return "skipped -- migration 0054 not applied yet";
  const day = arizonaDayKey(now);
  const todays = history.find((r) => r.day === day);
  if (todays) return `already recorded today: ${asSubscribers(summarizeFollowerChange(day, todays.followers, history))}`;
  const channel = env.YOUTUBE_CHANNEL?.trim() || DEFAULT_YOUTUBE_CHANNEL;
  const count = await fetchYoutubeSubscribers(channel, apiKey, fetchImpl);
  if (count === null) return `channel ${channel} not found or its subscriber count is hidden -- nothing recorded (set YOUTUBE_CHANNEL to the channel id)`;
  return asSubscribers(await recordPlatformFollowers(client, "youtube", count, now, "api"));
}
