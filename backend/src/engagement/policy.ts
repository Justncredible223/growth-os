import type { EngagementPlatform } from "./types.js";

/**
 * Guardrails for the engagement assistant (docs/ENGAGEMENT_ASSISTANT.md). Everything here is pure so each
 * limit is unit-tested without a database. The app never posts anything; these limits cap how much the OWNER is
 * handed to post by hand, because YouTube's spam policy and TikTok's rules punish high-volume, repetitive
 * commenting no matter who types it.
 */
export interface EngagementLimits {
  /** Mark-done actions allowed per platform per (Arizona) day. */
  dailyCapPerPlatform: number;
  /** Minimum seconds between two actions (any platform; there is one human). */
  minSpacingSeconds: number;
  /** Days before the same creator can be engaged with again. */
  creatorCooldownDays: number;
  /** YouTube Data API units this feature may spend per Pacific day. Default quota is 10,000; stay well under it. */
  youtubeDailyQuotaBudget: number;
  /** How many recent drafted/posted comments the near-duplicate check compares against. */
  recentCommentWindow: number;
  /** Unactioned items allowed in the queue; discovery stops topping up beyond this. */
  maxPendingItems: number;
}

export const DEFAULT_ENGAGEMENT_LIMITS: EngagementLimits = {
  dailyCapPerPlatform: 25,
  minSpacingSeconds: 90,
  creatorCooldownDays: 3,
  youtubeDailyQuotaBudget: 3000,
  recentCommentWindow: 200,
  maxPendingItems: 40,
};

export function resolveLimits(overrides: Partial<EngagementLimits> = {}): EngagementLimits {
  return { ...DEFAULT_ENGAGEMENT_LIMITS, ...overrides };
}

/** YouTube Data API v3 quota units per call. search.list is the expensive one. */
export const YOUTUBE_UNIT_COSTS = {
  videosList: 1,
  channelsList: 1,
  playlistItemsList: 1,
  commentThreadsList: 1,
  searchList: 100,
} as const;

/** Cached YouTube API data must be refreshed or deleted within 30 days (YouTube API Developer Policies). */
export const YOUTUBE_CACHE_MAX_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The owner's day: Arizona time, which has no DST (UTC-7). Same convention as the posting plan. */
export function arizonaDayKey(now: Date): string {
  return new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** ISO instant of the start of the Arizona day containing `now`. */
export function arizonaDayStartIso(now: Date): string {
  return new Date(`${arizonaDayKey(now)}T07:00:00.000Z`).toISOString();
}

/** YouTube's quota resets at midnight Pacific time. */
export function pacificDayKey(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A "done" action as the guardrails see it. */
export interface PriorDoneAction {
  platform: EngagementPlatform;
  creatorId: string;
  createdAt: string;
}

export type BlockCode = "daily_cap" | "min_spacing" | "creator_cooldown" | "quota_budget";

export interface Block {
  code: BlockCode;
  message: string;
  retryAfterSeconds?: number;
}

export class EngagementBlockedError extends Error {
  constructor(readonly block: Block) {
    super(block.message);
  }
}

function creatorKey(platform: EngagementPlatform, creatorId: string): string {
  return `${platform}:${creatorId.trim().toLowerCase()}`;
}

export function checkDailyCap(platform: EngagementPlatform, done: PriorDoneAction[], now: Date, limits: EngagementLimits): Block | null {
  const dayStart = arizonaDayStartIso(now);
  const count = done.filter((a) => a.platform === platform && a.createdAt >= dayStart).length;
  if (count >= limits.dailyCapPerPlatform) {
    return { code: "daily_cap", message: `Daily limit reached: ${count} of ${limits.dailyCapPerPlatform} ${platform} actions done today. Come back tomorrow.` };
  }
  return null;
}

export function checkMinSpacing(done: PriorDoneAction[], now: Date, limits: EngagementLimits): Block | null {
  if (done.length === 0) return null;
  const last = Math.max(...done.map((a) => new Date(a.createdAt).getTime()));
  const elapsed = Math.floor((now.getTime() - last) / 1000);
  if (elapsed < limits.minSpacingSeconds) {
    const wait = limits.minSpacingSeconds - elapsed;
    return { code: "min_spacing", message: `Slow down: wait ${wait}s since your last action.`, retryAfterSeconds: wait };
  }
  return null;
}

export function checkCreatorCooldown(platform: EngagementPlatform, creatorId: string, done: PriorDoneAction[], now: Date, limits: EngagementLimits): Block | null {
  const key = creatorKey(platform, creatorId);
  const windowMs = limits.creatorCooldownDays * DAY_MS;
  const recent = done.filter((a) => creatorKey(a.platform, a.creatorId) === key && now.getTime() - new Date(a.createdAt).getTime() < windowMs);
  if (recent.length === 0) return null;
  const last = Math.max(...recent.map((a) => new Date(a.createdAt).getTime()));
  const until = new Date(last + windowMs);
  return {
    code: "creator_cooldown",
    message: `You engaged with this creator recently. They are on a ${limits.creatorCooldownDays}-day cooldown until ${until.toISOString().slice(0, 10)}.`,
    retryAfterSeconds: Math.ceil((until.getTime() - now.getTime()) / 1000),
  };
}

/** Drafting is refused when the day is already full or the creator is cooling down (spacing is irrelevant to drafting). */
export function checkDraftingAllowance(platform: EngagementPlatform, creatorId: string, done: PriorDoneAction[], now: Date, limits: EngagementLimits): Block | null {
  return checkDailyCap(platform, done, now, limits) ?? checkCreatorCooldown(platform, creatorId, done, now, limits);
}

/** Opening a video: cap and cooldown, but not spacing (looking is not acting). */
export const checkOpenAllowance = checkDraftingAllowance;

/** Copying a draft or marking one done: everything, including the spacing between actions. */
export function checkActionAllowance(platform: EngagementPlatform, creatorId: string, done: PriorDoneAction[], now: Date, limits: EngagementLimits): Block | null {
  return checkDailyCap(platform, done, now, limits) ?? checkMinSpacing(done, now, limits) ?? checkCreatorCooldown(platform, creatorId, done, now, limits);
}

/** Whether `units` more quota units fit in today's budget. */
export function checkQuotaBudget(usedToday: number, units: number, limits: EngagementLimits): Block | null {
  if (usedToday + units > limits.youtubeDailyQuotaBudget) {
    return {
      code: "quota_budget",
      message: `YouTube quota budget reached for today (${usedToday} of ${limits.youtubeDailyQuotaBudget} units used, this call needs ${units}). It resets at midnight Pacific.`,
    };
  }
  return null;
}

/** Waiting items the scheduled fill tries to keep in the queue (the hard cap stays maxPendingItems). */
export const AUTOFILL_TARGET_WAITING = 10;

/**
 * UTC hours of the pulse runs the scheduled fill rides on (.github/workflows/growth-pulse.yml: 08:00, 13:00 and
 * 18:00 America/Phoenix, which has no DST).
 */
export const AUTOFILL_RUN_HOURS_UTC = [1, 15, 20] as const;

/** The next scheduled fill after `now`, with an owner-facing label in Arizona time. */
export function nextAutoFillRun(now: Date): { at: string; label: string } {
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const hour of [...AUTOFILL_RUN_HOURS_UTC].sort((a, b) => a - b)) {
      const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour, 0, 0));
      if (at.getTime() > now.getTime()) {
        const phoenixHour = (hour + 24 - 7) % 24;
        const label = `${phoenixHour % 12 === 0 ? 12 : phoenixHour % 12}:00 ${phoenixHour < 12 ? "AM" : "PM"} Arizona time`;
        return { at: at.toISOString(), label };
      }
    }
  }
  return { at: now.toISOString(), label: "soon" };
}
