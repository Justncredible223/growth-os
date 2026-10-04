/**
 * Reply pacing for the Prospecting queue (2026-09-25). @FillbookHQ's replies dropped from 3-23 views to 1-4
 * after about a week of posting the whole daily queue in one burst (8 replies in ~8 minutes). X reads that
 * as automated reply spam and hides the replies. The owner still posts every reply by hand; this only tells
 * the app when the next one is sensible, so it can hold the reply actions until then.
 */

/** Minimum gap between two replies. */
export const REPLY_COOLDOWN_MS = 20 * 60 * 1000;
/**
 * At most this many replies in any rolling 24 hours. Raised from 5 to 10 on 2026-10-04: X publishes no safe daily count (its
 * hard limit for an unverified account is about 200 replies a day), and what got the account's replies hidden was the burst
 * (8 in 8 minutes), not the total. 10 spaced at least 20 minutes apart is a human pace; recovery mode (2 a day) still takes
 * over automatically if reply views drop.
 */
export const DAILY_REPLY_CAP = 10;
/**
 * Recovery mode (2026-09-26): while X is limiting the account's replies (Results' reply-visibility check reads
 * "dropped"), cold replies are held to 2 a day, only on posts under 4 hours old, and drafts never name Fillbook.
 * It turns itself off when reply views recover. See prospectingRecovery.ts.
 */
export const RECOVERY_DAILY_REPLY_CAP = 2;
export const RECOVERY_MAX_POST_AGE_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReplyPacing {
  /** Replies posted in the last 24 hours. */
  repliedLast24h: number;
  dailyCap: number;
  cooldownMinutes: number;
  lastRepliedAt: string | null;
  /** When the next reply is fine to post, or null if it already is. */
  nextReplyAt: string | null;
  /** Why the next reply has to wait, or null if it doesn't. */
  reason: "cooldown" | "daily_cap" | null;
}

/** Pure: pacing from the times replies were posted (any order; unparseable values are ignored). */
export function computeReplyPacing(repliedAts: (string | null)[], now: Date = new Date(), dailyCap: number = DAILY_REPLY_CAP): ReplyPacing {
  const nowMs = now.getTime();
  const times = repliedAts
    .map((value) => (value ? new Date(value).getTime() : NaN))
    .filter((ms) => !Number.isNaN(ms) && ms <= nowMs)
    .sort((a, b) => b - a);
  const recent = times.filter((ms) => nowMs - ms < DAY_MS);
  const lastMs = times[0];

  let nextMs = 0;
  let reason: ReplyPacing["reason"] = null;
  if (lastMs !== undefined && lastMs + REPLY_COOLDOWN_MS > nowMs) {
    nextMs = lastMs + REPLY_COOLDOWN_MS;
    reason = "cooldown";
  }
  if (recent.length >= dailyCap) {
    // The window reopens when the oldest reply that keeps it full turns 24 hours old.
    const capMs = recent[dailyCap - 1]! + DAY_MS;
    if (capMs > nextMs) {
      nextMs = capMs;
      reason = "daily_cap";
    }
  }

  return {
    repliedLast24h: recent.length,
    dailyCap,
    cooldownMinutes: REPLY_COOLDOWN_MS / 60000,
    lastRepliedAt: lastMs === undefined ? null : new Date(lastMs).toISOString(),
    nextReplyAt: reason ? new Date(nextMs).toISOString() : null,
    reason,
  };
}
