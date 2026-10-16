import type { SupabaseClient } from "@supabase/supabase-js";
import { arizonaDayKey } from "../engagement/policy.js";
import { FOLLOWER_TABLE, isMissingFollowerTable, type FollowerSnapshotRow } from "./followerSnapshots.js";
import { SupabaseNotificationRepository } from "../notifications/supabaseNotificationRepository.js";

/**
 * The weekly "what worked / what to stop" note for the X account (2026-10-15 growth audit). Until now every measured number was
 * only displayed and nothing was ever pushed to the owner. Once a week (Monday, Arizona) this lines the daily follower counts
 * (x_follower_snapshots) up against what was actually posted and replied each day (x_own_posts) and writes ONE notification
 * in plain language.
 *
 * It is deliberately honest about size: the account has tens of followers and replies get a handful of views, so a change of a
 * few is noise and the note says so. It names things to look at; it does not claim a cause.
 */
export interface OwnPostRow {
  tweetId: string;
  kind: "reply" | "post";
  text: string;
  createdAt: string; // ISO
  impressions: number | null;
}

export interface DigestResult {
  title: string;
  body: string;
  relatedId: string;
}

const DAY_MS = 86_400_000;
const FILLBOOK = /\bfillbook/i;
/** A reply seen by fewer than this many people is "not reaching anyone". */
export const LOW_VIEWS = 5;
/** A net change this small, on an account this size, is not a trend. */
export const NOISE_BAND = 3;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Monday of the Arizona week containing `day` (YYYY-MM-DD). */
export function weekStartDay(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat
  return addDays(day, -((dow + 6) % 7));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const clip = (t: string, n = 70) => (t.replace(/\s+/g, " ").trim().length > n ? `${t.replace(/\s+/g, " ").trim().slice(0, n - 1)}…` : t.replace(/\s+/g, " ").trim());

/** Arizona has no daylight saving: UTC-7 all year. */
function azDay(iso: string): string {
  return arizonaDayKey(new Date(iso));
}

export function buildWeeklyDigest(todayDay: string, snapshots: FollowerSnapshotRow[], posts: OwnPostRow[]): DigestResult {
  const start = addDays(todayDay, -7);
  const inWindow = (d: string) => d >= start && d < todayDay;
  const snaps = [...snapshots].sort((a, b) => a.day.localeCompare(b.day));
  const windowPosts = posts.filter((p) => inWindow(azDay(p.createdAt)));
  const replies = windowPosts.filter((p) => p.kind === "reply");
  const lines: string[] = [];

  // 1. Followers
  const first = snaps.find((s) => s.day >= start && s.day < todayDay) ?? snaps.find((s) => s.day <= start);
  const last = [...snaps].reverse().find((s) => s.day <= todayDay);
  let net: number | null = null;
  if (first && last && last.day > first.day) {
    net = last.followers - first.followers;
    const verdict = Math.abs(net) <= NOISE_BAND ? " That is within noise for an account this size, not a trend." : "";
    lines.push(`Followers: ${first.followers} -> ${last.followers} (${signed(net)}) from ${first.day} to ${last.day}.${verdict}`);
  } else {
    lines.push("Followers: not enough daily readings yet to compare (the snapshot needs at least two days).");
  }

  // 2. The days that moved most, lined up with what was posted
  const byDay = new Map<string, { replies: number; posts: number; named: number }>();
  for (const p of windowPosts) {
    const d = azDay(p.createdAt);
    const row = byDay.get(d) ?? { replies: 0, posts: 0, named: 0 };
    if (p.kind === "reply") row.replies += 1;
    else row.posts += 1;
    if (FILLBOOK.test(p.text)) row.named += 1;
    byDay.set(d, row);
  }
  const deltas: Array<{ day: string; delta: number }> = [];
  for (let i = 1; i < snaps.length; i++) {
    const cur = snaps[i]!;
    const prev = snaps[i - 1]!;
    if (cur.day >= start && cur.day <= todayDay && cur.day > prev.day) deltas.push({ day: cur.day, delta: cur.followers - prev.followers });
  }
  const drops = deltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 2);
  for (const d of drops) {
    const act = byDay.get(addDays(d.day, -1)) ?? { replies: 0, posts: 0, named: 0 };
    lines.push(`Fell ${d.delta} on ${d.day}; the day before had ${act.replies} repl${act.replies === 1 ? "y" : "ies"} and ${act.posts} post${act.posts === 1 ? "" : "s"}${act.named ? `, ${act.named} naming Fillbook` : ""}.`);
  }
  const gains = deltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 1);
  for (const g of gains) {
    const act = byDay.get(addDays(g.day, -1)) ?? { replies: 0, posts: 0, named: 0 };
    lines.push(`Best day: ${signed(g.delta)} on ${g.day}; the day before had ${act.replies} repl${act.replies === 1 ? "y" : "ies"} and ${act.posts} post${act.posts === 1 ? "" : "s"}.`);
  }

  // 3. Replies: what reached anyone, and whether naming Fillbook changed it
  const seen = replies.filter((r) => r.impressions !== null);
  if (replies.length === 0) {
    lines.push("Replies: none read back this week.");
  } else {
    const low = seen.filter((r) => (r.impressions ?? 0) < LOW_VIEWS).length;
    const named = seen.filter((r) => FILLBOOK.test(r.text));
    const plain = seen.filter((r) => !FILLBOOK.test(r.text));
    const medNamed = median(named.map((r) => r.impressions as number));
    const medPlain = median(plain.map((r) => r.impressions as number));
    let l = `Replies: ${replies.length} posted, ${low} of ${seen.length} read back reached under ${LOW_VIEWS} people.`;
    if (medNamed !== null && medPlain !== null && named.length >= 3 && plain.length >= 3) {
      l += ` Median views: ${medPlain} without Fillbook, ${medNamed} naming it.`;
    } else if (seen.length > 0) {
      l += ` ${named.length} named Fillbook.`;
    }
    lines.push(l);
    const worst = [...seen].sort((a, b) => (a.impressions ?? 0) - (b.impressions ?? 0)).slice(0, 2);
    if (worst.length > 0 && (worst[0]!.impressions ?? 0) < LOW_VIEWS) {
      lines.push(`Stop list: replies like "${clip(worst[0]!.text, 60)}"${worst[1] ? ` and "${clip(worst[1]!.text, 60)}"` : ""} reached almost nobody; look at where they were posted (thread size, post age).`);
    }
  }

  // 4. What did reach people
  const top = [...windowPosts].filter((p) => p.impressions !== null).sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))[0];
  if (top && (top.impressions ?? 0) > 0) lines.push(`Most seen: ${top.impressions} views, "${clip(top.text, 80)}" (${top.kind}).`);

  const week = weekStartDay(addDays(todayDay, -1));
  return {
    title: net === null ? "X weekly review" : `X weekly review: followers ${signed(net)}`,
    body: lines.join("\n"),
    relatedId: `x-weekly-digest-${week}`,
  };
}

/** The pulse step: Mondays only (Arizona), once per week, tolerant of a missing follower table. */
export async function runWeeklyDigestStep(client: SupabaseClient, now: Date): Promise<string> {
  const today = arizonaDayKey(now);
  if (new Date(`${today}T00:00:00Z`).getUTCDay() !== 1) return "skipped -- the weekly review runs on Mondays";

  const since = addDays(today, -14);
  const snapRes = await client.from(FOLLOWER_TABLE).select("day, followers").gte("day", since).order("day", { ascending: true });
  if (snapRes.error) {
    if (isMissingFollowerTable(`${snapRes.error.message} ${snapRes.error.code ?? ""}`)) return "skipped -- migration 0053 not applied yet";
    throw new Error(`weekly review: follower read failed: ${snapRes.error.message}`);
  }
  const snapshots = (snapRes.data ?? []).map((r) => ({ day: String(r.day), followers: Number(r.followers) }));

  const postRes = await client
    .from("x_own_posts")
    .select("tweet_id, kind, text, created_at, impressions")
    .gte("created_at", new Date(now.getTime() - 15 * DAY_MS).toISOString())
    .order("created_at", { ascending: false });
  if (postRes.error) throw new Error(`weekly review: own-post read failed: ${postRes.error.message}`);
  const posts: OwnPostRow[] = (postRes.data ?? []).map((r) => ({
    tweetId: String(r.tweet_id),
    kind: r.kind === "reply" ? "reply" : "post",
    text: String(r.text ?? ""),
    createdAt: String(r.created_at),
    impressions: r.impressions === null || r.impressions === undefined ? null : Number(r.impressions),
  }));

  const digest = buildWeeklyDigest(today, snapshots, posts);
  const existing = await client.from("notifications").select("id").eq("related_id", digest.relatedId).limit(1);
  if (existing.error) throw new Error(`weekly review: notification lookup failed: ${existing.error.message}`);
  if ((existing.data ?? []).length > 0) return `already sent (${digest.relatedId})`;

  await new SupabaseNotificationRepository(client).create({
    type: "weekly_digest",
    title: digest.title,
    body: digest.body,
    severity: "info",
    relatedId: digest.relatedId,
  });
  return `sent: ${digest.title}`;
}
