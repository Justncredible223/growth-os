import type { getServiceClient } from "../lib/supabaseClient.js";
import { MANUAL_MOTION_CONCEPT_TITLE_PREFIX, manualMotionConceptTitle } from "../opportunities/manualMotionConcept.js";
import { listMotionConcepts } from "../../scripts/video-factory/motionCatalog.js";
import { dailyPosition } from "../shortform/motionPlans.js";
import { startOfDay } from "./dailyLimit.js";
import { phoenixLabel, type PostingPlan } from "../posting/postingPlan.js";

type Client = ReturnType<typeof getServiceClient>;

/**
 * Where the daily video is, in one value, for the Home card (owner request, 2026-10-04: the owner had to check Approvals, Video
 * Status and the posting plan to know). One video a day, so it is the most recent motion-concept request that is still in play.
 *
 *   none            nothing requested yet (or the last one is fully posted and from an earlier day)
 *   drafting        a request is queued or running: the script is being written and reviewed
 *   needs_approval  the script is in Approvals waiting for the owner
 *   rendering       approved; the render is queued or running
 *   ready           rendered, not yet posted anywhere
 *   posted          posted on at least one platform (platformsPosted says which)
 *   failed          the render failed
 */
export type TodaysVideoState = "none" | "drafting" | "needs_approval" | "rendering" | "ready" | "posted" | "failed";

export const POSTING_PLATFORM_COUNT = 3;

export interface TodaysVideo {
  state: TodaysVideoState;
  /** The concept's own title, without the request prefix. */
  title: string | null;
  /** Its day in the fixed daily order (1 = the first concept of the offered pool). */
  day: number | null;
  headline: string;
  detail: string;
  /** Platforms the owner has saved a post link for ("tiktok", "youtube_shorts", "instagram"). */
  platformsPosted: string[];
}

export interface TodaysVideoInput {
  /** Titles of concept requests still queued or running. */
  pendingTitles: string[];
  /** The most recent motion-concept campaign that is waiting in Approvals or approved, if any. */
  latest: { thesis: string; status: string; createdAt: string } | null;
  /** The latest render of that campaign's video asset, if any. */
  render: { status: string; error: string | null } | null;
  platformsPosted: string[];
  /** The newest draft request that failed or was expired as stuck since the start of today (Home P1 2026-11-15), if any. */
  failedDraft?: { title: string; error: string | null; at: string } | null;
  /** The start of today (Arizona, the one-a-day zone) as an ISO instant. */
  startOfToday: string;
}

const PLATFORM_NAMES: Record<string, string> = { tiktok: "TikTok", youtube_shorts: "YouTube", instagram: "Instagram" };

const stripPrefix = (t: string): string => (t.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX) ? t.slice(MANUAL_MOTION_CONCEPT_TITLE_PREFIX.length) : t);

/** The concept's day in the daily order, found by its title (the thesis a request stores). */
export function dayForTitle(thesis: string): number | null {
  const concept = listMotionConcepts().find((c) => manualMotionConceptTitle(c) === thesis);
  if (!concept) return null;
  const position = dailyPosition(concept.id);
  return position >= 0 ? position + 1 : null;
}

/** Pure: the Home card's state and words from what the database says. */
export function describeTodaysVideo(input: TodaysVideoInput): TodaysVideo {
  const base = (state: TodaysVideoState, thesis: string | null, headline: string, detail: string, platformsPosted: string[] = []): TodaysVideo => ({
    state,
    title: thesis === null ? null : stripPrefix(thesis),
    day: thesis === null ? null : dayForTitle(thesis),
    headline,
    detail,
    platformsPosted,
  });

  const pending = input.pendingTitles[0];
  if (pending) return base("drafting", pending, "Drafting today's video", "The script is being written and reviewed. It lands in Approvals when it is done.");

  const latest = input.latest;
  // A draft that failed or got stuck used to leave the card at "No video yet today"; say so, unless a newer script exists.
  const failedDraft = input.failedDraft;
  if (failedDraft && (!latest || latest.createdAt < failedDraft.at)) {
    return base("failed", failedDraft.title, "Draft failed", `${failedDraft.error ? failedDraft.error.slice(0, 140) : "The script was not written."} Request it again in Video Status.`);
  }
  if (!latest) return base("none", null, "No video yet today", "Request today's video in Video Status.");

  if (latest.status === "in_review") {
    return base("needs_approval", latest.thesis, "Waiting for your approval", "Read the script in Approvals. Approving it starts the render.");
  }

  const render = input.render;
  // P1 2026-11-15: an approved video with no render row (a render limit refused it, or it was dismissed) used to read "Rendering" forever.
  if (!render) return base("none", latest.thesis, "No render yet", "The render was not queued (a render limit, or it was dismissed). Open Video Status to request it again.");
  if (render.status === "queued" || render.status === "rendering") {
    return base("rendering", latest.thesis, "Rendering", render?.status === "rendering" ? "The video is rendering. You get a push when it is ready." : "The render is queued. You get a push when it is ready.");
  }
  if (render.status === "failed") {
    return base("failed", latest.thesis, "Render failed", `${render.error ? render.error.slice(0, 140) : "The render did not finish."} Open Video Status.`);
  }
  if (render.status === "ready") {
    // P1 2026-11-15: "Posted" only once every platform has a link; one platform posted is still a video to finish.
    if (input.platformsPosted.length > 0 && input.platformsPosted.length < POSTING_PLATFORM_COUNT) {
      const names = input.platformsPosted.map((p) => PLATFORM_NAMES[p] ?? p).join(", ");
      return base("ready", latest.thesis, "Partly posted", `Posted on ${names}. Post it to the other ${POSTING_PLATFORM_COUNT - input.platformsPosted.length} and paste the links in Video Status.`, input.platformsPosted);
    }
    if (input.platformsPosted.length > 0) {
      // A fully posted video from an earlier day is not today's video.
      if (latest.createdAt < input.startOfToday) return base("none", null, "No video yet today", `Last video: ${stripPrefix(latest.thesis)}. Request today's in Video Status.`);
      const names = input.platformsPosted.map((p) => PLATFORM_NAMES[p] ?? p).join(", ");
      return base("posted", latest.thesis, "Posted", `Posted on ${input.platformsPosted.length} of ${POSTING_PLATFORM_COUNT}: ${names}.`, input.platformsPosted);
    }
    return base("ready", latest.thesis, "Ready to post", "Download it in Video Status, post it, then paste the links.");
  }
  // canceled or unknown: not in play
  return base("none", null, "No video yet today", "Request today's video in Video Status.");
}

/** Reads the database and returns the Home card. */
export async function loadTodaysVideo(client: Client, now: Date = new Date()): Promise<TodaysVideo> {
  const { data: pendingRows, error: pendingError } = await client.from("campaign_run_requests").select("opportunity_id").in("status", ["queued", "running"]);
  if (pendingError) throw new Error(`today's video lookup failed (requests): ${pendingError.message}`);
  const ids = [...new Set(((pendingRows ?? []) as Array<{ opportunity_id: string }>).map((r) => r.opportunity_id))];
  let pendingTitles: string[] = [];
  if (ids.length > 0) {
    const { data: opps, error } = await client.from("opportunities").select("title").in("id", ids);
    if (error) throw new Error(`today's video lookup failed (opportunities): ${error.message}`);
    pendingTitles = ((opps ?? []) as Array<{ title: string }>).map((o) => o.title).filter((t) => t.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX));
  }

  // Newest failed or expired draft request today (campaign_run_requests.status "failed"; the sweep marks stuck ones this way).
  let failedDraft: TodaysVideoInput["failedDraft"] = null;
  const { data: failedRows } = await client
    .from("campaign_run_requests")
    .select("opportunity_id, error, updated_at")
    .eq("status", "failed")
    .gte("updated_at", startOfDay(now).toISOString())
    .order("updated_at", { ascending: false })
    .limit(5);
  const failedList = (failedRows ?? []) as Array<{ opportunity_id: string; error: string | null; updated_at: string }>;
  if (failedList.length > 0) {
    const { data: failedOpps } = await client.from("opportunities").select("id, title").in("id", failedList.map((f) => f.opportunity_id));
    const titleById = new Map(((failedOpps ?? []) as Array<{ id: string; title: string }>).map((o) => [o.id, o.title]));
    const hit = failedList.find((f) => (titleById.get(f.opportunity_id) ?? "").startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX));
    if (hit) failedDraft = { title: titleById.get(hit.opportunity_id)!, error: hit.error, at: hit.updated_at };
  }

  const { data: campaigns, error: campaignError } = await client
    .from("campaigns")
    .select("id, thesis, status, created_at")
    .like("thesis", `${MANUAL_MOTION_CONCEPT_TITLE_PREFIX}%`)
    .in("status", ["in_review", "approved"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (campaignError) throw new Error(`today's video lookup failed (campaigns): ${campaignError.message}`);
  const campaign = ((campaigns ?? []) as Array<{ id: string; thesis: string; status: string; created_at: string }>)[0];

  let render: TodaysVideoInput["render"] = null;
  let platformsPosted: string[] = [];
  if (campaign && campaign.status === "approved") {
    const { data: assets, error: assetError } = await client.from("campaign_assets").select("id").eq("campaign_id", campaign.id).eq("asset_type", "video_script").limit(1);
    if (assetError) throw new Error(`today's video lookup failed (assets): ${assetError.message}`);
    const assetId = ((assets ?? []) as Array<{ id: string }>)[0]?.id;
    if (assetId) {
      const { data: renders, error: renderError } = await client.from("video_renders").select("status, error").eq("campaign_asset_id", assetId).order("created_at", { ascending: false }).limit(1);
      if (renderError) throw new Error(`today's video lookup failed (renders): ${renderError.message}`);
      render = ((renders ?? []) as Array<{ status: string; error: string | null }>)[0] ?? null;
      // video_posts exists once migration 0043 is applied; before that the card simply shows no posts.
      const { data: posts, error: postError } = await client.from("video_posts").select("platform").eq("campaign_asset_id", assetId);
      if (!postError) platformsPosted = ((posts ?? []) as Array<{ platform: string }>).map((p) => p.platform);
    }
  }

  return describeTodaysVideo({
    pendingTitles,
    latest: campaign ? { thesis: campaign.thesis, status: campaign.status, createdAt: campaign.created_at } : null,
    render,
    platformsPosted,
    failedDraft,
    startOfToday: startOfDay(now).toISOString(),
  });
}

/**
 * P0 2026-11-15 (ChatGPT): Home's video card follows the posting plan's pick once a video is rendered, so a partly posted video from
 * yesterday, or one waiting for YouTube's 48-hour rule, stays on Home instead of reading "No video yet today". States that need the
 * owner earlier in the pipeline (drafting, approval, rendering, a failed render) keep the card.
 */
export function applyPostingPlan(video: TodaysVideo | null, plan: PostingPlan | null): TodaysVideo | null {
  const slot = plan?.slots[0];
  if (!plan || !slot?.video) return video;
  if (video && !["none", "ready", "posted"].includes(video.state)) return video;
  const v = slot.video;
  const posted = v.posts.map((p) => p.platform as string);
  const names = (list: string[]) => list.map((p) => PLATFORM_NAMES[p] ?? p).join(", ");
  const youtubeNote = slot.blocked.includes("youtube_shorts") && plan.youtubeNextAt ? ` YouTube opens ${phoenixLabel(plan.youtubeNextAt)} (one post per 48 hours).` : "";
  const base = { title: v.title, day: dayForTitle(`${MANUAL_MOTION_CONCEPT_TITLE_PREFIX}${v.title}`), platformsPosted: posted };
  if (slot.status === "done") return { ...base, state: "posted", headline: "Posted", detail: `Posted on all ${POSTING_PLATFORM_COUNT}: ${names(posted)}.` };
  if (slot.status === "waiting") return { ...base, state: "posted", headline: "Waiting for YouTube", detail: `Posted on ${names(posted)}.${youtubeNote}` };
  if (posted.length === 0) return { ...base, state: "ready", headline: "Ready to post", detail: `Download it in Video Status, post it, then paste the links.${youtubeNote}` };
  return { ...base, state: "ready", headline: "Partly posted", detail: `Posted on ${names(posted)}. Still to post: ${names(slot.remaining)}.${youtubeNote}` };
}
