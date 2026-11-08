import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SupabaseCampaignRepository } from "../content/supabaseCampaignRepository.js";
import { X_FEED_POST_ASSET_TYPE } from "../content/dailyXFeedPost.js";
import { containsFalseGiveawayClaim, containsLink, containsUnverifiedClaim, dashProblem } from "../content/xReplyGuardrails.js";
import { errorMessage } from "../lib/errorMessage.js";

/**
 * POST /api/hq-handoff (served from api/approvals.ts through a vercel.json rewrite, because the Hobby plan is capped at 12
 * functions). Fillbook HQ's social agent writes at most one X draft a day and sends it here so it appears in the app's Approvals
 * list, where the owner posts it by hand exactly like Today's X Post. Rules, all enforced here and tested:
 *  - OFF unless HQ_HANDOFF_TOKEN is set (and at least 32 characters) and HQ_HANDOFF is not "off". When off the route answers 404,
 *    which HQ's client treats as "stop and retry later".
 *  - The token is compared in constant time. Nothing is ever posted, followed, liked or sent: the draft only lands in Approvals.
 *  - HQ's own verdict and desk decision are stored as information for the owner, never as authorization.
 *  - Text with a link, an unverified claim, a false giveaway claim or an em dash is refused (the same guards our own drafts use).
 *  - A repeat of the same hqDraftId with the same text is a no-op (200, same assetId); the same id with different text is a 409.
 *  - At most HQ_HANDOFF_MAX_PER_WINDOW drafts are accepted per 10 minutes (429 beyond that).
 */
export const HQ_HANDOFF_MIN_TOKEN_LENGTH = 32;
export const HQ_HANDOFF_MIN_TEXT = 20;
export const HQ_HANDOFF_MAX_TEXT = 2000;
export const HQ_HANDOFF_MAX_PER_WINDOW = 10;
export const HQ_HANDOFF_WINDOW_MS = 10 * 60 * 1000;
export const HQ_HANDOFF_SOURCE = "hq_handoff";

export interface HqHandoffDraft {
  hqDraftId: string;
  text: string;
  verdict: string;
  revisionCount: number;
  deskReason: string;
  imageBrief: string | null;
}

export type HqHandoffValidation = { ok: true; draft: HqHandoffDraft } | { ok: false; status: number; error: string };

export function hqHandoffEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const token = env.HQ_HANDOFF_TOKEN ?? "";
  return token.length >= HQ_HANDOFF_MIN_TOKEN_LENGTH && env.HQ_HANDOFF !== "off";
}

/** Constant-time check of the `Authorization: Bearer <token>` header against HQ_HANDOFF_TOKEN. */
export function hqHandoffTokenMatches(header: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const expected = env.HQ_HANDOFF_TOKEN ?? "";
  if (!header || !header.startsWith("Bearer ") || expected.length < HQ_HANDOFF_MIN_TOKEN_LENGTH) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(expected);
  if (given.length !== want.length) {
    // Still do one comparison so the time taken does not reveal the length match.
    timingSafeEqual(want, want);
    return false;
  }
  return timingSafeEqual(given, want);
}

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
/** Markdown bold markers, or a line that starts with a draft label ("Draft 1", "Option 2", "Version A"). */
const MARKDOWN_LABEL = /\*\*|^\s*(?:draft|option|version|variant)\s*(?:#?\d+|[a-c])\s*(?:[:.)\]-]|\(|$)/im;

export function validateHqHandoffBody(body: unknown): HqHandoffValidation {
  const bad = (error: string): HqHandoffValidation => ({ ok: false, status: 400, error });
  if (!body || typeof body !== "object") return bad("Body must be a JSON object");
  const b = body as Record<string, any>;
  // HQ numbers its drafts (#44, #46): a whole number is accepted and stored as its text.
  const hqDraftId = typeof b.hqDraftId === "number" && Number.isSafeInteger(b.hqDraftId) && b.hqDraftId >= 0 ? String(b.hqDraftId) : b.hqDraftId;
  if (typeof hqDraftId !== "string" || !ID_PATTERN.test(hqDraftId)) return bad("hqDraftId must be 1-80 letters, digits or _ . : - (a whole number is also accepted)");
  if (b.role !== "social") return bad('role must be "social"');
  if (b.platform !== "x") return bad('platform must be "x"');
  if (b.contentType !== "x_post") return bad('contentType must be "x_post"');
  if (typeof b.text !== "string") return bad("text must be a string");
  const text = b.text.trim();
  if (text.length < HQ_HANDOFF_MIN_TEXT || text.length > HQ_HANDOFF_MAX_TEXT) {
    return bad(`text must be ${HQ_HANDOFF_MIN_TEXT}-${HQ_HANDOFF_MAX_TEXT} characters`);
  }
  const compliance = b.compliance;
  if (!compliance || typeof compliance.verdict !== "string" || compliance.verdict.length === 0 || compliance.verdict.length > 40) {
    return bad("compliance.verdict must be a short string");
  }
  const revisionCount = compliance.revisionCount;
  if (!Number.isInteger(revisionCount) || revisionCount < 0 || revisionCount > 50) return bad("compliance.revisionCount must be a whole number 0-50");
  const desk = b.desk;
  if (!desk || desk.decision !== "ready") return bad('desk.decision must be "ready"');
  if (typeof desk.reason !== "string" || desk.reason.length > 300) return bad("desk.reason must be a string of at most 300 characters");
  const imageBrief = b.imageBrief ?? null;
  if (imageBrief !== null && (typeof imageBrief !== "string" || imageBrief.length > 240)) return bad("imageBrief must be null or a string of at most 240 characters");

  // The owner copies this text straight into X, so it must be ONE clean post: no markdown labels such as "**Draft 1 (X)**" and no
  // multi-part drafts (HQ's Social agent writes those; HQ now sends only the chosen post body).
  if (MARKDOWN_LABEL.test(text)) return { ok: false, status: 422, error: "text must be one clean post body: remove markdown labels such as **Draft 1 (X)** and send a single post" };
  if (containsLink(text)) return { ok: false, status: 422, error: "text must not contain a link" };
  const violation = containsUnverifiedClaim(text) ?? containsFalseGiveawayClaim(text) ?? dashProblem(text);
  if (violation) return { ok: false, status: 422, error: `text refused: ${violation.reason}` };

  return {
    ok: true,
    draft: {
      hqDraftId,
      text,
      verdict: compliance.verdict,
      revisionCount,
      deskReason: desk.reason,
      imageBrief: imageBrief === null ? null : imageBrief.trim() || null,
    },
  };
}

export type HqHandoffResult = { status: number; body: Record<string, unknown> };

/** Stores a validated draft as an x_feed_post asset at ready_for_owner. Dedupes on the HQ draft id and rate-limits. */
export async function storeHqDraft(client: SupabaseClient, draft: HqHandoffDraft, now: Date = new Date()): Promise<HqHandoffResult> {
  const { data: existing, error: existingError } = await client
    .from("content_versions")
    .select("campaign_asset_id, body")
    .filter("metadata->>hqDraftId", "eq", draft.hqDraftId)
    .limit(1)
    .maybeSingle();
  if (existingError) throw new Error(`dedupe lookup failed: ${existingError.message}`);
  if (existing) {
    const row = existing as { campaign_asset_id: string; body: string };
    if (row.body.trim() === draft.text) return { status: 200, body: { assetId: row.campaign_asset_id, id: row.campaign_asset_id, duplicate: true } };
    return { status: 409, body: { error: "hqDraftId already stored with different text", assetId: row.campaign_asset_id } };
  }

  const since = new Date(now.getTime() - HQ_HANDOFF_WINDOW_MS).toISOString();
  const { count, error: countError } = await client
    .from("content_versions")
    .select("id", { count: "exact", head: true })
    .filter("metadata->>source", "eq", HQ_HANDOFF_SOURCE)
    .gte("created_at", since);
  if (countError) throw new Error(`rate-limit lookup failed: ${countError.message}`);
  if ((count ?? 0) >= HQ_HANDOFF_MAX_PER_WINDOW) {
    return { status: 429, body: { error: "too many handoffs in the last 10 minutes; retry later" } };
  }

  const repo = new SupabaseCampaignRepository(client);
  const { data: opp, error: oppError } = await client
    .from("opportunities")
    .insert({
      title: `HQ draft: ${draft.hqDraftId}`,
      score: 0,
      urgency: "normal",
      confidence: 1,
      rationale: "Draft written by Fillbook HQ's social agent and handed over for the owner to review and post by hand.",
      recommended_channels: ["x"],
      recommended_campaign_type: "x_feed_post",
      approval_class: "EXTERNAL_DRAFT",
      signal_ids: [],
    })
    .select("id")
    .single();
  if (oppError) throw new Error(`opportunity insert failed: ${oppError.message}`);
  const opportunityId = (opp as { id: string }).id;
  await client.from("opportunities").update({ status: "actioned", updated_at: now.toISOString() }).eq("id", opportunityId);

  const campaignId = await repo.createCampaign(opportunityId, `HQ X draft ${draft.hqDraftId}`);
  try {
    const assetId = await repo.createCampaignAsset(campaignId, "x", X_FEED_POST_ASSET_TYPE);
    await repo.insertContentVersion(assetId, 1, draft.text, {
      source: HQ_HANDOFF_SOURCE,
      hqDraftId: draft.hqDraftId,
      verdict: draft.verdict,
      revisionCount: draft.revisionCount,
      deskReason: draft.deskReason,
      imageBrief: draft.imageBrief,
    });
    await repo.updateAssetStage(assetId, "ready_for_owner");
    // Approvals lists only campaigns that are in_review. AI review is not human approval: nothing is approved here.
    const { error: statusError } = await client.from("campaigns").update({ status: "in_review", updated_at: now.toISOString() }).eq("id", campaignId);
    if (statusError) throw new Error(`campaign status update failed: ${statusError.message}`);
    return { status: 201, body: { assetId, id: assetId } };
  } catch (err) {
    // Do not leave a half-built draft in front of the owner.
    await client.from("campaigns").update({ status: "retired" }).eq("id", campaignId);
    throw err;
  }
}

/** The route handler. Runs BEFORE the app-token check, with its own token. */
export async function handleHqHandoff(req: VercelRequest, res: VercelResponse, getClient: () => SupabaseClient): Promise<void> {
  if (!hqHandoffEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!hqHandoffTokenMatches(req.headers.authorization)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const validation = validateHqHandoffBody(req.body);
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }
  try {
    const result = await storeHqDraft(getClient(), validation.draft);
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}
