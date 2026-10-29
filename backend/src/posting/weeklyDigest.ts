import type { SupabaseClient } from "@supabase/supabase-js";
import { arizonaDayKey } from "../engagement/policy.js";
import { FOLLOWER_TABLE, isMissingFollowerTable, type FollowerSnapshotRow } from "./followerSnapshots.js";
import { SupabaseNotificationRepository } from "../notifications/supabaseNotificationRepository.js";
import { FOLLOWER_PLATFORMS, PLATFORM_FOLLOWER_TABLE, isMissingPlatformFollowerTable, type FollowerPlatform } from "./platformFollowers.js";

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
  likes?: number | null;
  /** x_own_posts.prospecting_candidate_id: the Prospecting candidate this reply answers, when matched. */
  prospectingCandidateId?: string | null;
}

/** Reply-style experiment: candidate id -> the style tag recorded when the owner marked it replied (sharp / helpful / edited / legacy). */
export type PostedStyleByCandidate = Map<string, string>;

/** A style needs at least this many replies read back before its median is shown. */
export const STYLE_MIN_SAMPLE = 3;
const STYLE_ORDER = ["sharp", "helpful", "fillbook", "edited", "legacy"] as const;

/**
 * "Reply style results" (reply-style experiment, 2026-10-16): median views and likes per posted-style tag for replies that
 * can be tied to a Prospecting candidate. Returns null until at least one experiment style (sharp or helpful) has
 * STYLE_MIN_SAMPLE replies with views read back. Reports sizes and says small samples are noise; it never claims a cause.
 */
export function replyStyleSection(posts: OwnPostRow[], styles: PostedStyleByCandidate): string[] | null {
  const groups = new Map<string, OwnPostRow[]>();
  for (const p of posts) {
    if (p.kind !== "reply" || p.impressions === null || !p.prospectingCandidateId) continue;
    const tag = styles.get(p.prospectingCandidateId) ?? "legacy";
    groups.set(tag, [...(groups.get(tag) ?? []), p]);
  }
  const enough = (tag: string) => (groups.get(tag)?.length ?? 0) >= STYLE_MIN_SAMPLE;
  if (!enough("sharp") && !enough("helpful") && !enough("fillbook")) return null;
  const lines = ["Reply style results (replies tied to a Prospecting post):"];
  for (const tag of STYLE_ORDER) {
    const rows = groups.get(tag);
    if (!rows || rows.length === 0) continue;
    if (rows.length < STYLE_MIN_SAMPLE) {
      lines.push(`  ${tag}: ${rows.length} repl${rows.length === 1 ? "y" : "ies"}, too few for a median.`);
      continue;
    }
    const views = median(rows.map((r) => r.impressions as number));
    const likes = median(rows.map((r) => r.likes ?? 0));
    lines.push(`  ${tag}: ${rows.length} replies, median ${views} views, median ${likes} likes.`);
  }
  lines.push("  Samples this small are mostly noise; read it as a hint to keep testing, not as proof that one style works.");
  return lines;
}

/** What the digest needs to know about the post a reply sits under, from its Prospecting candidate. */
export interface ReplyTarget {
  authorFollowers: number | null;
  postCreatedAt: string | null;
  /** The suggested angle kind stored with the candidate (prospectingInteraction.ts): answer, loss, math, detail or like. */
  angleKind?: string | null;
  /** The suggested action stored with the candidate: reply, quote or engage. */
  suggestedAction?: string | null;
}
export type ReplyTargetByCandidate = Map<string, ReplyTarget>;

const SIZE_BUCKETS: Array<{ label: string; test: (n: number) => boolean }> = [
  { label: "authors under 1k followers", test: (n) => n < 1_000 },
  { label: "authors 1k to 30k", test: (n) => n >= 1_000 && n <= 30_000 },
  { label: "authors over 30k", test: (n) => n > 30_000 },
];
const AGE_BUCKETS: Array<{ label: string; test: (hours: number) => boolean }> = [
  { label: "posts under 1h old when replied", test: (h) => h < 1 },
  { label: "posts 1h to 4h old", test: (h) => h >= 1 && h < 4 },
  { label: "posts over 4h old", test: (h) => h >= 4 },
];

/**
 * "Where replies reached people" (2026-10-24): median views of replies grouped by how big the post's author is and how old the post
 * was when we replied, for replies tied to a Prospecting candidate. A group needs STYLE_MIN_SAMPLE replies to show a median. Returns
 * null until at least one group has that many. This is how the next weeks answer "which targets earn reach" instead of guessing.
 */
export function replyReachSection(posts: OwnPostRow[], targets: ReplyTargetByCandidate): string[] | null {
  const rows = posts
    .filter((p) => p.kind === "reply" && p.impressions !== null && p.prospectingCandidateId && targets.has(p.prospectingCandidateId))
    .map((p) => ({ views: p.impressions as number, target: targets.get(p.prospectingCandidateId as string)!, repliedAt: p.createdAt }));
  const lines: string[] = [];
  const addGroup = (label: string, views: number[]) => {
    if (views.length < STYLE_MIN_SAMPLE) return;
    lines.push(`  ${label}: ${views.length} replies, median ${median(views)} views.`);
  };
  for (const b of SIZE_BUCKETS) addGroup(b.label, rows.filter((r) => r.target.authorFollowers !== null && b.test(r.target.authorFollowers)).map((r) => r.views));
  for (const b of AGE_BUCKETS) {
    addGroup(
      b.label,
      rows
        .filter((r) => r.target.postCreatedAt !== null && b.test((Date.parse(r.repliedAt) - Date.parse(r.target.postCreatedAt as string)) / 3_600_000))
        .map((r) => r.views),
    );
  }
  const ANGLE_LABELS: Record<string, string> = {
    answer: "replies that answered a question",
    loss: "replies to a loss or breach post",
    math: "replies that checked the math",
    detail: "replies that added a detail",
    like: "replies where the card suggested only a like",
  };
  for (const [kind, label] of Object.entries(ANGLE_LABELS)) addGroup(label, rows.filter((r) => r.target.angleKind === kind).map((r) => r.views));
  addGroup("replies where the card suggested a quote", rows.filter((r) => r.target.suggestedAction === "quote").map((r) => r.views));
  if (lines.length === 0) return null;
  return ["Where replies reached people (median views):", ...lines, "  Small groups are mostly noise; use it to pick which posts to answer first, not as proof."];
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

const PLATFORM_LABEL: Record<FollowerPlatform, string> = { youtube: "YouTube subscribers", tiktok: "TikTok followers", instagram: "Instagram followers" };

/** One line per platform that has two or more readings in the window; a platform with fewer is left out, never guessed. */
export function otherPlatformLines(todayDay: string, others: Partial<Record<FollowerPlatform, FollowerSnapshotRow[]>>): string[] {
  const start = addDays(todayDay, -7);
  const lines: string[] = [];
  for (const platform of FOLLOWER_PLATFORMS) {
    const snaps = [...(others[platform] ?? [])].sort((a, b) => a.day.localeCompare(b.day));
    const first = snaps.find((s) => s.day >= start && s.day < todayDay) ?? snaps.find((s) => s.day <= start);
    const last = [...snaps].reverse().find((s) => s.day <= todayDay);
    if (!first || !last || last.day <= first.day) continue;
    lines.push(`${PLATFORM_LABEL[platform]}: ${first.followers} -> ${last.followers} (${signed(last.followers - first.followers)}) from ${first.day} to ${last.day}.`);
  }
  return lines;
}

export function buildWeeklyDigest(
  todayDay: string,
  snapshots: FollowerSnapshotRow[],
  posts: OwnPostRow[],
  others: Partial<Record<FollowerPlatform, FollowerSnapshotRow[]>> = {},
  styleByCandidate: PostedStyleByCandidate = new Map(),
  targetByCandidate: ReplyTargetByCandidate = new Map(),
): DigestResult {
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

  lines.push(...otherPlatformLines(todayDay, others));

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

  // 3b. Reply style experiment (only once a style has enough replies)
  const styleLines = replyStyleSection(posts, styleByCandidate);
  if (styleLines) lines.push(...styleLines);
  const reachLines = replyReachSection(posts, targetByCandidate);
  if (reachLines) lines.push(...reachLines);

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
    .select("tweet_id, kind, text, created_at, impressions, likes, prospecting_candidate_id")
    .gte("created_at", new Date(now.getTime() - 30 * DAY_MS).toISOString())
    .order("created_at", { ascending: false });
  if (postRes.error) throw new Error(`weekly review: own-post read failed: ${postRes.error.message}`);
  const posts: OwnPostRow[] = (postRes.data ?? []).map((r) => ({
    tweetId: String(r.tweet_id),
    kind: r.kind === "reply" ? "reply" : "post",
    text: String(r.text ?? ""),
    createdAt: String(r.created_at),
    impressions: r.impressions === null || r.impressions === undefined ? null : Number(r.impressions),
    likes: r.likes === null || r.likes === undefined ? null : Number(r.likes),
    prospectingCandidateId: r.prospecting_candidate_id ? String(r.prospecting_candidate_id) : null,
  }));

  // Reply-style tags recorded by Prospecting (score_breakdown.posted_style). Optional: any failure only drops the section.
  const styleByCandidate: PostedStyleByCandidate = new Map();
  const targetByCandidate: ReplyTargetByCandidate = new Map();
  try {
    const candRes = await client
      .from("prospecting_candidates")
      .select("id, score_breakdown, author_follower_count, post_created_at")
      .eq("status", "replied")
      .gte("replied_at", new Date(now.getTime() - 30 * DAY_MS).toISOString())
      .order("replied_at", { ascending: false });
    for (const r of candRes?.data ?? []) {
      const breakdown = r.score_breakdown as Record<string, unknown> | null;
      const tag = breakdown?.posted_style;
      if (typeof tag === "string") styleByCandidate.set(String(r.id), tag);
      const followers = (r as Record<string, unknown>).author_follower_count;
      const postedAt = (r as Record<string, unknown>).post_created_at;
      targetByCandidate.set(String(r.id), {
        authorFollowers: typeof followers === "number" ? followers : null,
        postCreatedAt: typeof postedAt === "string" ? postedAt : null,
        angleKind: typeof breakdown?.angleKind === "string" ? breakdown.angleKind : null,
        suggestedAction: typeof breakdown?.suggestedAction === "string" ? breakdown.suggestedAction : null,
      });
    }
  } catch {
    // no style section this week
  }

  // Other platforms: optional. A missing table (migration 0054) or a failed read only drops these lines.
  const others: Partial<Record<FollowerPlatform, FollowerSnapshotRow[]>> = {};
  const otherRes = await client.from(PLATFORM_FOLLOWER_TABLE).select("platform, day, followers").gte("day", since).order("day", { ascending: true });
  if (otherRes.error) {
    if (!isMissingPlatformFollowerTable(`${otherRes.error.message} ${otherRes.error.code ?? ""}`)) {
      throw new Error(`weekly review: platform follower read failed: ${otherRes.error.message}`);
    }
  } else {
    for (const r of otherRes.data ?? []) {
      const p = r.platform as FollowerPlatform;
      if (!FOLLOWER_PLATFORMS.includes(p)) continue;
      (others[p] ??= []).push({ day: String(r.day), followers: Number(r.followers) });
    }
  }

  const digest = buildWeeklyDigest(today, snapshots, posts, others, styleByCandidate, targetByCandidate);
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
