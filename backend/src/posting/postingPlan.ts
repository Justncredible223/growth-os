/**
 * The daily posting plan and the X reply-visibility check (owner request 2026-09-25). Pure functions: no I/O, so the
 * slot assignment and the alert threshold are fully testable. Data loading lives in postingRepository.ts.
 *
 * The owner posts one rendered video a day (2026-10-04, matching the one-new-video-a-day limit in dailyLimit.ts) to TikTok,
 * YouTube Shorts and Instagram Reels, at one fixed Arizona time. It was 3 a day at 6:30am, 12pm and 5:30pm until then.
 */

export const POSTING_PLATFORMS = ["tiktok", "youtube_shorts", "instagram"] as const;
export type PostingPlatform = (typeof POSTING_PLATFORMS)[number];

/** Slot times, America/Phoenix (no daylight saving, so a fixed UTC-7 offset is exact all year). */
export const POSTING_SLOT_TIMES = ["12:00"] as const;
const PHOENIX_OFFSET_MS = -7 * 60 * 60 * 1000;

export interface PlanPost {
  platform: PostingPlatform;
  url: string;
  postedAt: string;
}

export interface PlanVideo {
  campaignAssetId: string;
  videoRenderId: string | null;
  title: string;
  readyAt: string;
  posts: PlanPost[];
}

export type SlotStatus = "done" | "due" | "upcoming" | "empty";

export interface PlanSlot {
  time: (typeof POSTING_SLOT_TIMES)[number];
  startsAt: string;
  status: SlotStatus;
  video: PlanVideo | null;
  /** Platforms still to post for this slot's video. */
  remaining: PostingPlatform[];
}

export interface PostingPlan {
  /** Today's date in Arizona, YYYY-MM-DD. */
  date: string;
  slots: PlanSlot[];
  /** Ready videos not posted anywhere yet, beyond today's slots. */
  backlog: number;
}

/** YYYY-MM-DD for an instant, in Arizona. */
export function phoenixDate(at: Date): string {
  return new Date(at.getTime() + PHOENIX_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant of an Arizona wall-clock time on an Arizona date. */
export function phoenixInstant(date: string, time: string): Date {
  return new Date(new Date(`${date}T${time}:00Z`).getTime() - PHOENIX_OFFSET_MS);
}

function remainingPlatforms(video: PlanVideo): PostingPlatform[] {
  const done = new Set(video.posts.map((p) => p.platform));
  return POSTING_PLATFORMS.filter((p) => !done.has(p));
}

/**
 * Fills today's slot(s) (one a day now). Videos first posted today keep the slots, in the order they went out; the rest go to
 * ready videos that aren't fully posted yet, oldest first. A video posted before today never returns to the plan.
 */
export function buildPostingPlan(videos: PlanVideo[], now: Date = new Date()): PostingPlan {
  const date = phoenixDate(now);
  const firstPostDate = (v: PlanVideo) => (v.posts.length ? phoenixDate(new Date(v.posts.map((p) => p.postedAt).sort()[0]!)) : null);

  const startedToday = videos
    .filter((v) => firstPostDate(v) === date)
    .sort((a, b) => a.posts.map((p) => p.postedAt).sort()[0]!.localeCompare(b.posts.map((p) => p.postedAt).sort()[0]!));
  const waiting = videos.filter((v) => v.posts.length === 0).sort((a, b) => a.readyAt.localeCompare(b.readyAt));
  const queue = [...startedToday, ...waiting];

  const slots: PlanSlot[] = POSTING_SLOT_TIMES.map((time, i) => {
    const startsAt = phoenixInstant(date, time);
    const video = queue[i] ?? null;
    const remaining = video ? remainingPlatforms(video) : [];
    const status: SlotStatus = !video ? "empty" : remaining.length === 0 ? "done" : now >= startsAt ? "due" : "upcoming";
    return { time, startsAt: startsAt.toISOString(), status, video, remaining };
  });

  return { date, slots, backlog: Math.max(0, waiting.length - Math.max(0, POSTING_SLOT_TIMES.length - startedToday.length)) };
}

export interface ReplyViewSample {
  createdAt: Date;
  impressions: number | null;
}

export interface ReplyVisibility {
  status: "ok" | "dropped" | "not_enough_data";
  /** Median views of replies 12h-3d old: long enough to have settled, recent enough to show a change. */
  recentMedian: number | null;
  recentCount: number;
  /** Median views of replies 3-21 days old, the account's own normal. */
  baselineMedian: number | null;
  baselineCount: number;
}

const HOUR_MS = 60 * 60 * 1000;
/** Recent replies at or below this share of the normal median count as a drop. */
export const VISIBILITY_DROP_RATIO = 0.4;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Flags a reply-visibility drop: X hiding the account's replies shows up as views collapsing against the account's
 * own normal (2026-09-24: replies went from 3-23 views to 1-4). Needs 3 recent and 5 baseline replies to judge.
 */
export function assessReplyVisibility(replies: ReplyViewSample[], now: Date = new Date()): ReplyVisibility {
  const ageHours = (r: ReplyViewSample) => (now.getTime() - r.createdAt.getTime()) / HOUR_MS;
  const withViews = replies.filter((r) => r.impressions !== null);
  const recent = withViews.filter((r) => ageHours(r) >= 12 && ageHours(r) < 72).map((r) => r.impressions!);
  const baseline = withViews.filter((r) => ageHours(r) >= 72 && ageHours(r) < 21 * 24).map((r) => r.impressions!);
  const recentMedian = median(recent);
  const baselineMedian = median(baseline);
  const enough = recent.length >= 3 && baseline.length >= 5 && baselineMedian !== null && baselineMedian > 0;
  return {
    status: !enough ? "not_enough_data" : recentMedian! <= baselineMedian! * VISIBILITY_DROP_RATIO ? "dropped" : "ok",
    recentMedian,
    recentCount: recent.length,
    baselineMedian,
    baselineCount: baseline.length,
  };
}
