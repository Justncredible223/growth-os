import type { getServiceClient } from "../lib/supabaseClient.js";
import { MANUAL_MOTION_CONCEPT_TITLE_PREFIX, manualMotionConceptTitle } from "../opportunities/manualMotionConcept.js";
import { MOTION_SCENE_PLANS } from "../shortform/motionPlans.js";
import { buildVideoScriptFromScenePlan, formatVideoScriptAsText } from "../content/videoScriptWriter.js";
import { listMotionConcepts } from "../../scripts/video-factory/motionCatalog.js";
import { startOfDay } from "./dailyLimit.js";

type Client = ReturnType<typeof getServiceClient>;

/**
 * Concepts the automatic refill must not request again, because the mechanical gate or the AI review already blocked this
 * exact script (2026-11-26: one concept was re-requested at every pulse, nine paid review runs, and everything behind it
 * waited).
 *
 * One automatic attempt per concept per script version. The state is read from the drafts, verdicts and run records already
 * stored, so it survives restarts and needs no new table. Only a real judgement counts: a run that broke (model error,
 * timeout, dead job) stores neither a failing verdict nor a finished 'draft' result, and the concept stays free to try
 * again, within the day's attempt cap (refillAttempts.ts). The app's own Motion render button does not use this, so a
 * request by hand behaves exactly as before.
 */

/** One concept draft the mechanical gate or the AI review blocked. */
export interface RejectedDraft {
  /** The concept's opportunity title, which is the campaign's thesis. */
  title: string;
  /** The draft text that was judged. */
  body: string;
  createdAt: string;
}

export interface ReviewHolds {
  /** Titles whose CURRENT script already failed review. */
  heldTitles: Set<string>;
  /** A concept whose draft was blocked today (Arizona), so today's automatic request is used up; null otherwise. */
  rejectedToday: string | null;
}

/**
 * The part of a draft that makes it a different script: the hook, the spoken narration and the on-screen shot list.
 * Titles, descriptions, captions and hashtags come from shared templates, so changing them (or punctuation, letter case
 * or spacing) does not buy another paid review of the same video. Text without those sections is compared whole.
 */
export function scriptVersion(draftText: string): string {
  const text = draftText.replace(/\r/g, "").toLowerCase();
  const sections = /^hook:([\s\S]*?)\n+script:\n([\s\S]*?)\n+shot list:\n([\s\S]*?)\n+youtube title:/.exec(text);
  const judged = sections ? sections.slice(1).join(" ") : text;
  return judged.replace(/[^\p{L}\p{N}%$]+/gu, " ").trim();
}

/** The draft text each concept would produce today, keyed by its opportunity title. */
export function currentScriptsByTitle(): Map<string, string> {
  const plans = new Map(MOTION_SCENE_PLANS.map((p) => [p.planId, p] as const));
  const scripts = new Map<string, string>();
  for (const concept of listMotionConcepts()) {
    const plan = plans.get(concept.id);
    if (plan) scripts.set(manualMotionConceptTitle(concept), formatVideoScriptAsText(buildVideoScriptFromScenePlan(plan)));
  }
  return scripts;
}

export function reviewHolds(drafts: readonly RejectedDraft[], currentScripts: ReadonlyMap<string, string>, now: Date): ReviewHolds {
  const dayStart = startOfDay(now).getTime();
  const heldTitles = new Set<string>();
  let rejectedToday: string | null = null;
  // Matched on the words, not the title, so renaming a concept does not release it.
  const rejected = new Set(drafts.map((d) => scriptVersion(d.body)));
  for (const [title, current] of currentScripts) {
    if (rejected.has(scriptVersion(current))) heldTitles.add(title);
  }
  for (const draft of drafts) {
    if (Date.parse(draft.createdAt) >= dayStart) rejectedToday ??= draft.title;
  }
  return { heldTitles, rejectedToday };
}

const CHUNK = 100;
const PAGE = 1000;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** Reads every row of a query, past the database's per-request row limit. */
async function allRows<T>(label: string, page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Review-held concept lookup failed (${label}): ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

/**
 * Concept drafts that were blocked: campaigns still in 'draft' whose video script either
 * - stayed at 'final_draft' with a failing verdict from a reviewer other than the copy editor (a copy-editor-only failure
 *   goes to Approvals, so a draft with only that stopped for some other reason), or
 * - stayed at 'draft' while its run finished normally with that result, which only the mechanical gate does (a crashed or
 *   timed-out run is recorded as 'failed').
 * Any query error throws, so the refill requests nothing rather than guessing.
 */
export async function loadReviewRejectedDrafts(client: Client): Promise<RejectedDraft[]> {
  const campaigns = await allRows<{ id: string; thesis: string; created_at: string }>("campaigns", (from, to) =>
    client.from("campaigns").select("id, thesis, created_at").like("thesis", `${MANUAL_MOTION_CONCEPT_TITLE_PREFIX}%`).eq("status", "draft").order("id").range(from, to),
  );
  const campaignById = new Map(campaigns.map((c) => [c.id, c] as const));

  const assets: Array<{ id: string; campaign_id: string; stage: string }> = [];
  for (const ids of chunks([...campaignById.keys()])) {
    assets.push(
      ...(await allRows<{ id: string; campaign_id: string; stage: string }>("assets", (from, to) =>
        client.from("campaign_assets").select("id, campaign_id, stage").in("campaign_id", ids).eq("asset_type", "video_script").in("stage", ["draft", "final_draft"]).order("id").range(from, to),
      )),
    );
  }
  const campaignByAsset = new Map(assets.map((a) => [a.id, a.campaign_id] as const));

  const versions: Array<{ id: string; campaign_asset_id: string; body: string }> = [];
  for (const ids of chunks([...campaignByAsset.keys()])) {
    versions.push(
      ...(await allRows<{ id: string; campaign_asset_id: string; body: string }>("versions", (from, to) =>
        client.from("content_versions").select("id, campaign_asset_id, body").in("campaign_asset_id", ids).order("id").range(from, to),
      )),
    );
  }

  const reviewedAssets = new Set(assets.filter((a) => a.stage === "final_draft").map((a) => a.id));
  const failedVersionIds = new Set<string>();
  for (const ids of chunks(versions.filter((v) => reviewedAssets.has(v.campaign_asset_id)).map((v) => v.id))) {
    const rows = await allRows<{ content_version_id: string }>("verdicts", (from, to) =>
      client.from("content_scores").select("content_version_id").in("content_version_id", ids).eq("verdict", "fail").neq("evaluator", "copy_editor").order("id").range(from, to),
    );
    for (const row of rows) failedVersionIds.add(row.content_version_id);
  }

  const gateBlockedAssets = new Set<string>();
  for (const ids of chunks(assets.filter((a) => a.stage === "draft").map((a) => a.id))) {
    const rows = await allRows<{ campaign_asset_id: string }>("runs", (from, to) =>
      client.from("campaign_run_requests").select("campaign_asset_id").in("campaign_asset_id", ids).eq("status", "ready").eq("final_stage", "draft").order("id").range(from, to),
    );
    for (const row of rows) gateBlockedAssets.add(row.campaign_asset_id);
  }

  return versions
    .filter((v) => failedVersionIds.has(v.id) || gateBlockedAssets.has(v.campaign_asset_id))
    .map((v) => {
      const campaign = campaignById.get(campaignByAsset.get(v.campaign_asset_id)!)!;
      return { title: campaign.thesis, body: v.body, createdAt: campaign.created_at };
    });
}

export async function loadReviewHolds(client: Client, now: Date = new Date()): Promise<ReviewHolds> {
  return reviewHolds(await loadReviewRejectedDrafts(client), currentScriptsByTitle(), now);
}
