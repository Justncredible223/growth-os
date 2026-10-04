import type { SupabaseClient } from "@supabase/supabase-js";
import { MANUAL_MOTION_CONCEPT_TITLE_PREFIX } from "../opportunities/manualMotionConcept.js";
import { extractYoutubeVideoId } from "../video/youtubeUrl.js";
import { recordOwnerPublication } from "../attribution/contentPublications.js";
import type { XOwnTweet } from "../signals/adapters/xAdapter.js";
import { dayForTitle } from "../video/todaysVideo.js";
import { POSTING_PLATFORMS, assessReplyVisibility, buildPostingPlan, type PlanVideo, type PostingPlan, type PostingPlatform, type ReplyVisibility } from "./postingPlan.js";

/** How far back results are listed and YouTube stats refreshed. */
const RESULTS_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export class PostingActionError extends Error {}

/** True for the error Supabase returns before migration 0043 is applied (the tables don't exist yet). */
export function isMissingPostingTables(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /(video_posts|video_post_metrics|x_own_posts)/.test(message) && /(does not exist|schema cache|PGRST205|42P01)/i.test(message);
}

export function isPostingPlatform(value: unknown): value is PostingPlatform {
  return typeof value === "string" && (POSTING_PLATFORMS as readonly string[]).includes(value);
}

/** Campaign titles for the given assets: the motion concept's own title where there is one. */
async function titlesForAssets(client: SupabaseClient, assetIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (assetIds.length === 0) return titles;
  const { data, error } = await client.from("campaign_assets").select("id, campaigns(thesis)").in("id", assetIds);
  if (error) throw new Error(`Title lookup failed: ${error.message}`);
  for (const row of (data ?? []) as unknown as Array<{ id: string; campaigns: { thesis: string } | null }>) {
    const thesis = row.campaigns?.thesis ?? "Fillbook video";
    titles.set(row.id, thesis.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX) ? thesis.slice(MANUAL_MOTION_CONCEPT_TITLE_PREFIX.length) : thesis);
  }
  return titles;
}

/** Today's plan: every ready render, with whatever has been posted for it. */
export async function loadPostingPlan(client: SupabaseClient, now: Date = new Date()): Promise<PostingPlan> {
  const { data: renders, error } = await client
    .from("video_renders")
    .select("id, campaign_asset_id, updated_at, created_at")
    .eq("status", "ready")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Posting plan: render lookup failed: ${error.message}`);
  const rows = (renders ?? []) as Array<{ id: string; campaign_asset_id: string; created_at: string }>;
  const assetIds = [...new Set(rows.map((r) => r.campaign_asset_id))];
  const titles = await titlesForAssets(client, assetIds);
  const posts = new Map<string, PlanVideo["posts"]>();
  if (assetIds.length > 0) {
    const { data: postRows, error: postError } = await client.from("video_posts").select("campaign_asset_id, platform, url, posted_at").in("campaign_asset_id", assetIds);
    if (postError) throw new Error(`Posting plan: post lookup failed: ${postError.message}`);
    for (const p of (postRows ?? []) as Array<{ campaign_asset_id: string; platform: PostingPlatform; url: string; posted_at: string }>) {
      const list = posts.get(p.campaign_asset_id) ?? [];
      list.push({ platform: p.platform, url: p.url, postedAt: p.posted_at });
      posts.set(p.campaign_asset_id, list);
    }
  }
  const videos: PlanVideo[] = rows.map((r) => ({
    campaignAssetId: r.campaign_asset_id,
    videoRenderId: r.id,
    title: titles.get(r.campaign_asset_id) ?? "Fillbook video",
    readyAt: r.created_at,
    posts: posts.get(r.campaign_asset_id) ?? [],
  }));
  return buildPostingPlan(videos, now);
}

/** Records (or corrects) where a video was posted on one platform. */
export async function recordVideoPost(
  client: SupabaseClient,
  input: { campaignAssetId: string; videoRenderId?: string | null; platform: PostingPlatform; url: string },
  now: Date = new Date(),
): Promise<void> {
  if (!/^https?:\/\//i.test(input.url)) throw new PostingActionError("The link must start with http:// or https://");
  const titles = await titlesForAssets(client, [input.campaignAssetId]);
  const title = titles.get(input.campaignAssetId);
  if (!title) throw new PostingActionError(`No video with asset id ${input.campaignAssetId}`);
  const { error } = await client.from("video_posts").upsert(
    {
      campaign_asset_id: input.campaignAssetId,
      video_render_id: input.videoRenderId ?? null,
      concept_title: title,
      platform: input.platform,
      url: input.url.trim(),
      external_id: input.platform === "youtube_shorts" ? extractYoutubeVideoId(input.url) : null,
      posted_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: "campaign_asset_id,platform" },
  );
  if (error) throw new Error(`Recording the post failed: ${error.message}`);

  // These three per-platform links replaced the Video Status screen's single "I posted this" field (2026-09-26), so
  // they also feed what that field fed: content_publications (the growth-loop analytics and weekly summary) and, for
  // YouTube, video_renders.published_url (growth pulse's YouTube stats and comment monitoring). Best-effort, like
  // setPublishedUrl: the video_posts row above is what the posting plan depends on.
  const url = input.url.trim();
  try {
    await recordOwnerPublication(client, { campaignAssetId: input.campaignAssetId, channel: PUBLICATION_CHANNEL[input.platform], actualUrl: url });
  } catch (err) {
    console.warn(`recordVideoPost: content_publications sync failed for ${input.campaignAssetId}/${input.platform}`, err);
  }
  if (input.platform === "youtube_shorts") {
    const update = client.from("video_renders").update({ published_url: url, updated_at: now.toISOString() }).eq("status", "ready");
    const { error: renderError } = await (input.videoRenderId ? update.eq("id", input.videoRenderId) : update.eq("campaign_asset_id", input.campaignAssetId));
    if (renderError) console.warn(`recordVideoPost: video_renders.published_url sync failed for ${input.campaignAssetId}`, renderError);
  }
}

/** content_publications.channel for each posting platform -- the same names setPublishedUrl's URL detection writes. */
const PUBLICATION_CHANNEL: Record<PostingPlatform, string> = { tiktok: "tiktok", youtube_shorts: "youtube", instagram: "instagram" };

/** Records numbers the owner typed in (TikTok and Instagram can't be read automatically). */
export async function recordManualStats(
  client: SupabaseClient,
  input: { videoPostId: string; views: number | null; likes: number | null; comments: number | null; shares: number | null },
): Promise<void> {
  const values = [input.views, input.likes, input.comments, input.shares];
  if (values.every((v) => v === null)) throw new PostingActionError("Enter at least one number.");
  if (values.some((v) => v !== null && (!Number.isInteger(v) || v < 0))) throw new PostingActionError("Stats must be whole numbers, 0 or more.");
  const { error } = await client
    .from("video_post_metrics")
    .insert({ video_post_id: input.videoPostId, source: "manual", views: input.views, likes: input.likes, comments: input.comments, shares: input.shares });
  if (error) throw new Error(`Saving the stats failed: ${error.message}`);
}

/**
 * True when a typed-in (TikTok/Instagram) post is a week old but its numbers were taken before day 6, so the owner is asked
 * for the day-7 numbers. Views keep growing for days; a day-2 number alone makes an old video look worse than it did.
 */
export function needsDay7Stats(platform: PostingPlatform, postedAt: string, latest: { source: "api" | "manual"; capturedAt: string } | null, now: Date): boolean {
  if (platform === "youtube_shorts" || !latest || latest.source !== "manual") return false;
  const posted = new Date(postedAt).getTime();
  const ageDays = (now.getTime() - posted) / DAY_MS;
  const takenAtDays = (new Date(latest.capturedAt).getTime() - posted) / DAY_MS;
  return ageDays >= 7 && takenAtDays < 6;
}

export interface PostResult {
  id: string;
  platform: PostingPlatform;
  url: string;
  postedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  statsSource: "api" | "manual" | null;
  statsAt: string | null;
  /** TikTok/Instagram posts at least 2 days old with no numbers yet: the app asks for them. */
  needsManualStats: boolean;
  /** TikTok/Instagram posts at least 7 days old whose typed numbers were taken in the first days: the app asks for the day-7 numbers. */
  needsDay7Stats: boolean;
}

export interface VideoResult {
  campaignAssetId: string;
  title: string;
  /** The concept's day in the fixed daily order (1-30), when the title matches one. */
  day: number | null;
  firstPostedAt: string;
  totalViews: number | null;
  posts: PostResult[];
}

export interface XReplyResult {
  tweetId: string;
  text: string;
  createdAt: string;
  impressions: number | null;
  likes: number | null;
  replies: number | null;
}

export interface ResultsReport {
  videos: VideoResult[];
  xReplies: XReplyResult[];
  replyVisibility: ReplyVisibility;
}

/** Everything posted in the last 30 days with its latest numbers, plus the X reply trend. */
export async function loadResults(client: SupabaseClient, now: Date = new Date()): Promise<ResultsReport> {
  const since = new Date(now.getTime() - RESULTS_WINDOW_DAYS * DAY_MS).toISOString();
  const { data: postRows, error } = await client
    .from("video_posts")
    .select("id, campaign_asset_id, concept_title, platform, url, posted_at")
    .gte("posted_at", since)
    .order("posted_at", { ascending: false });
  if (error) throw new Error(`Results: post lookup failed: ${error.message}`);
  const posts = (postRows ?? []) as Array<{ id: string; campaign_asset_id: string; concept_title: string; platform: PostingPlatform; url: string; posted_at: string }>;

  const latest = new Map<string, { views: number | null; likes: number | null; comments: number | null; shares: number | null; source: "api" | "manual"; captured_at: string }>();
  if (posts.length > 0) {
    const { data: metricRows, error: metricError } = await client
      .from("video_post_metrics")
      .select("video_post_id, views, likes, comments, shares, source, captured_at")
      .in("video_post_id", posts.map((p) => p.id))
      .order("captured_at", { ascending: false });
    if (metricError) throw new Error(`Results: stats lookup failed: ${metricError.message}`);
    for (const m of (metricRows ?? []) as Array<{ video_post_id: string; views: number | null; likes: number | null; comments: number | null; shares: number | null; source: "api" | "manual"; captured_at: string }>) {
      if (!latest.has(m.video_post_id)) latest.set(m.video_post_id, m);
    }
  }

  const byVideo = new Map<string, VideoResult>();
  for (const p of posts) {
    const m = latest.get(p.id);
    const ageDays = (now.getTime() - new Date(p.posted_at).getTime()) / DAY_MS;
    const result: PostResult = {
      id: p.id,
      platform: p.platform,
      url: p.url,
      postedAt: p.posted_at,
      views: m?.views ?? null,
      likes: m?.likes ?? null,
      comments: m?.comments ?? null,
      shares: m?.shares ?? null,
      statsSource: m?.source ?? null,
      statsAt: m?.captured_at ?? null,
      needsManualStats: p.platform !== "youtube_shorts" && !m && ageDays >= 2,
      needsDay7Stats: needsDay7Stats(p.platform, p.posted_at, m ? { source: m.source, capturedAt: m.captured_at } : null, now),
    };
    const video = byVideo.get(p.campaign_asset_id) ?? { campaignAssetId: p.campaign_asset_id, title: p.concept_title, day: dayForTitle(p.concept_title), firstPostedAt: p.posted_at, totalViews: null, posts: [] };
    video.posts.push(result);
    if (p.posted_at < video.firstPostedAt) video.firstPostedAt = p.posted_at;
    if (result.views !== null) video.totalViews = (video.totalViews ?? 0) + result.views;
    byVideo.set(p.campaign_asset_id, video);
  }

  const { data: tweetRows, error: tweetError } = await client
    .from("x_own_posts")
    .select("tweet_id, text, created_at, impressions, likes, replies")
    .eq("kind", "reply")
    .gte("created_at", new Date(now.getTime() - 21 * DAY_MS).toISOString())
    .order("created_at", { ascending: false });
  if (tweetError) throw new Error(`Results: X reply lookup failed: ${tweetError.message}`);
  const tweets = (tweetRows ?? []) as Array<{ tweet_id: string; text: string; created_at: string; impressions: number | null; likes: number | null; replies: number | null }>;

  return {
    videos: [...byVideo.values()].sort((a, b) => b.firstPostedAt.localeCompare(a.firstPostedAt)),
    xReplies: tweets.slice(0, 20).map((t) => ({ tweetId: t.tweet_id, text: t.text, createdAt: t.created_at, impressions: t.impressions, likes: t.likes, replies: t.replies })),
    replyVisibility: assessReplyVisibility(tweets.map((t) => ({ createdAt: new Date(t.created_at), impressions: t.impressions })), now),
  };
}

/** Upserts the account's own latest tweets and their metrics, linking replies to the Prospecting candidate they answer. */
export async function saveOwnTweets(client: SupabaseClient, tweets: XOwnTweet[], now: Date = new Date()): Promise<{ saved: number; replies: number; matched: number }> {
  if (tweets.length === 0) return { saved: 0, replies: 0, matched: 0 };
  const parentIds = [...new Set(tweets.map((t) => t.inReplyToTweetId).filter((id): id is string => id !== null))];
  const candidateByPost = new Map<string, string>();
  if (parentIds.length > 0) {
    const { data, error } = await client.from("prospecting_candidates").select("id, external_id").eq("platform", "x").in("external_id", parentIds);
    if (error) throw new Error(`Own-tweet candidate match failed: ${error.message}`);
    for (const c of (data ?? []) as Array<{ id: string; external_id: string }>) candidateByPost.set(c.external_id, c.id);
  }
  const rows = tweets.map((t) => ({
    tweet_id: t.id,
    kind: t.inReplyToTweetId ? "reply" : "post",
    text: t.text,
    created_at: t.createdAt.toISOString(),
    in_reply_to_tweet_id: t.inReplyToTweetId,
    prospecting_candidate_id: t.inReplyToTweetId ? (candidateByPost.get(t.inReplyToTweetId) ?? null) : null,
    impressions: t.impressions,
    likes: t.likes,
    replies: t.replies,
    reposts: t.reposts,
    metrics_updated_at: now.toISOString(),
  }));
  const { error } = await client.from("x_own_posts").upsert(rows, { onConflict: "tweet_id" });
  if (error) throw new Error(`Saving own tweets failed: ${error.message}`);
  return { saved: rows.length, replies: rows.filter((r) => r.kind === "reply").length, matched: rows.filter((r) => r.prospecting_candidate_id).length };
}

/** YouTube posts from the last 30 days whose API numbers are older than 20 hours (the pulse runs 3 times a day). */
export async function youtubePostsDueForStats(client: SupabaseClient, now: Date = new Date()): Promise<Array<{ id: string; externalId: string }>> {
  const { data, error } = await client
    .from("video_posts")
    .select("id, external_id")
    .eq("platform", "youtube_shorts")
    .not("external_id", "is", null)
    .gte("posted_at", new Date(now.getTime() - RESULTS_WINDOW_DAYS * DAY_MS).toISOString());
  if (error) throw new Error(`YouTube stats: post lookup failed: ${error.message}`);
  const posts = (data ?? []) as Array<{ id: string; external_id: string }>;
  if (posts.length === 0) return [];
  const { data: recent, error: recentError } = await client
    .from("video_post_metrics")
    .select("video_post_id")
    .eq("source", "api")
    .in("video_post_id", posts.map((p) => p.id))
    .gte("captured_at", new Date(now.getTime() - 20 * 60 * 60 * 1000).toISOString());
  if (recentError) throw new Error(`YouTube stats: freshness lookup failed: ${recentError.message}`);
  const fresh = new Set(((recent ?? []) as Array<{ video_post_id: string }>).map((r) => r.video_post_id));
  return posts.filter((p) => !fresh.has(p.id)).map((p) => ({ id: p.id, externalId: p.external_id }));
}

/** Reads public statistics for YouTube videos with the API key (free quota) and stores one snapshot per post. */
export async function syncYoutubeStats(client: SupabaseClient, apiKey: string, fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<string> {
  const due = await youtubePostsDueForStats(client, now);
  if (due.length === 0) return "0 YouTube posts due";
  let saved = 0;
  for (let i = 0; i < due.length; i += 50) {
    const batch = due.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${batch.map((b) => encodeURIComponent(b.externalId)).join(",")}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`YouTube videos.list failed: HTTP ${res.status}`);
    const json = (await res.json()) as { items?: Array<{ id: string; statistics?: Record<string, string> }> };
    const stats = new Map((json.items ?? []).map((item) => [item.id, item.statistics ?? {}]));
    const rows = batch
      .filter((b) => stats.has(b.externalId))
      .map((b) => {
        const s = stats.get(b.externalId)!;
        const num = (v: string | undefined) => (v === undefined ? null : Number(v));
        return { video_post_id: b.id, source: "api", views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount), shares: null, captured_at: now.toISOString() };
      });
    if (rows.length > 0) {
      const { error } = await client.from("video_post_metrics").insert(rows);
      if (error) throw new Error(`YouTube stats insert failed: ${error.message}`);
      saved += rows.length;
    }
  }
  return `${saved} of ${due.length} YouTube posts updated`;
}
