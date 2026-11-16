import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseVideoRenderMetadata, type VideoRenderMetadataJson } from "./videoStatusHandlers.js";
import { youtubeNextAllowedAt } from "../posting/postingPlan.js";

/**
 * The Metricool package for one finished render (team decision 2026-11-14, Claude + ChatGPT; Metricool posting policy,
 * owner's yes 2026-11-08). Growth OS never posts: it builds the exact `info` for the official Metricool connector's
 * createScheduledPost, one post per network, and the Marketing session queues them after Justin approves this exact
 * package (its id, the file's SHA256, the captions, the platforms and the date). Copying the package is not approval.
 *
 * The media URL is a signed link into the private rendered-videos bucket, valid MEDIA_URL_TTL_SECONDS. Metricool must
 * copy the file when the post is created; the session confirms that on read-back (getScheduledPosts) and stops if the
 * post still points at this link. Renders are deleted after VIDEO_RETENTION_DAYS, so a package is queued within days.
 */

export const STORAGE_BUCKET = "rendered-videos";
export const MEDIA_URL_TTL_SECONDS = 24 * 60 * 60;

/**
 * False until the first TikTok (phone notification, Justin posts it) and the first YouTube Short (supervised) are verified
 * end to end (policy 2026-11-08). Turning it on is its own PR, on Justin's yes.
 */
export const METRICOOL_AUTO_PUBLISH = false;

const YOUTUBE_TITLE_MAX = 100;
const MAX_HASHTAGS = 5;

export interface MetricoolPackage {
  /** Short id Justin approves by ("approve mp-1a2b3c4d for <date>"); it changes when the file or any caption changes. */
  packageId: string;
  videoRenderId: string;
  sha256: string;
  durationSeconds: number | null;
  mediaUrl: string;
  mediaUrlExpiresAt: string;
  /** One createScheduledPost `info` per network, without the date (the session adds publicationDate after Justin's yes). YouTube is left out
   * while the one-post-per-48-hours rule blocks it (P2 2026-11-15); Instagram is included when the video has an Instagram caption. */
  posts: { tiktok: Record<string, unknown>; youtube?: Record<string, unknown>; instagram?: Record<string, unknown> };
  /** When YouTube may be posted again (ISO), or null when it may be now. */
  youtubeBlockedUntil?: string | null;
  /** Rule checks on the package itself; any failure means it must not be queued. */
  checks: Array<{ check: string; ok: boolean }>;
}

const hashtagLine = (tags: string[]): string =>
  tags.slice(0, MAX_HASHTAGS).map((t) => `#${t.replace(/^#/, "")}`).join(" ");

/** The package for a render, from its file hash, its stored video metadata and a signed media URL. Pure. */
export function buildMetricoolPackage(input: {
  videoRenderId: string;
  sha256: string;
  durationSeconds: number | null;
  metadata: VideoRenderMetadataJson;
  mediaUrl: string;
  mediaUrlExpiresAt: string;
  /** When YouTube may be posted again (ISO), or null/absent when it may be now (one YouTube post per 48 hours). */
  youtubeBlockedUntil?: string | null;
}): MetricoolPackage {
  const { metadata: m } = input;
  const tags = m.hashtags.slice(0, MAX_HASHTAGS).map((t) => t.replace(/^#/, ""));
  const tiktokText = `${m.tiktokCaption} ${hashtagLine(tags)}`.trim();
  const youtubeTitle = m.youtubeTitle.slice(0, YOUTUBE_TITLE_MAX);
  const base = { autoPublish: METRICOOL_AUTO_PUBLISH, draft: false, descendants: [], firstCommentText: "", hasNotReadNotes: false, shortener: false, smartLinkData: { ids: [] }, media: [input.mediaUrl], mediaAltText: [] };
  // P2 2026-11-15: the comment Fillbook pins under the video goes in as the first comment on TikTok and YouTube (it was left empty).
  const firstComment = { firstCommentText: m.pinnedComment ?? "" };
  const tiktok = {
    ...base,
    ...firstComment,
    providers: [{ network: "tiktok" }],
    text: tiktokText,
    tiktokData: {
      privacyOption: "PUBLIC_TO_EVERYONE",
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      commercialContentOwnBrand: true,
      commercialContentThirdParty: false,
      isAigc: true,
      autoAddMusic: false,
    },
  };
  const youtube = {
    ...base,
    ...firstComment,
    providers: [{ network: "youtube" }],
    text: m.youtubeDescription,
    youtubeData: { title: youtubeTitle, type: "short", privacy: "public", madeForKids: false, isAiGeneratedContent: true, tags, category: "EDUCATION" },
  };
  const all = `${tiktokText}\n${youtubeTitle}\n${m.youtubeDescription}`;
  const checks = [
    { check: "TikTok caption says the figures are demo data", ok: /demo (account )?data|sample/i.test(m.tiktokCaption) },
    { check: "YouTube description says the figures are demo data", ok: /demo data|sample (fillbook )?account/i.test(m.youtubeDescription) },
    { check: "No giveaway link or giveaway wording", ok: !/giveaway/i.test(all) },
    { check: "No /go tracking links (not cleared for posts yet)", ok: !/\/go\//i.test(all) },
    { check: "Says Fillbook, never FillbookHQ in the copy", ok: !/fillbookhq(?!\.com)/i.test(all.replace(/@fillbookhq/gi, "")) },
    { check: `YouTube title at most ${YOUTUBE_TITLE_MAX} characters`, ok: m.youtubeTitle.length <= YOUTUBE_TITLE_MAX },
    { check: "Autopublish stays off until the first two posts are verified", ok: METRICOOL_AUTO_PUBLISH === false },
  ];
  // P2 2026-11-15: Instagram Reels when the video has an Instagram caption.
  const instagram = m.instagramCaption
    ? { ...base, providers: [{ network: "instagram" }], text: `${m.instagramCaption} ${hashtagLine(tags)}`.trim(), instagramData: { type: "REEL" } }
    : undefined;
  const youtubeBlocked = Boolean(input.youtubeBlockedUntil);
  const packageId = `mp-${createHash("sha256").update(JSON.stringify([input.videoRenderId, input.sha256, tiktokText, youtubeTitle, m.youtubeDescription])).digest("hex").slice(0, 8)}`;
  return {
    packageId,
    videoRenderId: input.videoRenderId,
    sha256: input.sha256,
    durationSeconds: input.durationSeconds,
    mediaUrl: input.mediaUrl,
    mediaUrlExpiresAt: input.mediaUrlExpiresAt,
    // YouTube is left out while the 48-hour rule blocks it, so the package can never schedule a second YouTube post too soon.
    posts: { tiktok, ...(youtubeBlocked ? {} : { youtube }), ...(instagram ? { instagram } : {}) },
    youtubeBlockedUntil: input.youtubeBlockedUntil ?? null,
    checks,
  };
}

/** The text Justin copies from the app: what to approve, then the two `info` objects for the session. */
export function metricoolPackageText(p: MetricoolPackage): string {
  const failed = p.checks.filter((c) => !c.ok);
  return [
    `METRICOOL PACKAGE ${p.packageId}`,
    `Render ${p.videoRenderId}${p.durationSeconds ? `, ${p.durationSeconds.toFixed(1)} s` : ""}`,
    `File fingerprint ${p.sha256}`,
    `Platforms: ${["TikTok", p.posts.youtube ? "YouTube Short" : null, p.posts.instagram ? "Instagram Reel" : null].filter(Boolean).join(" + ")} (one post each). Autopublish: ${METRICOOL_AUTO_PUBLISH ? "on" : "off (Metricool notifies the phone)"}`,
    p.youtubeBlockedUntil ? `YouTube left out: one YouTube post per 48 hours, next after ${p.youtubeBlockedUntil}` : null,
    `Media link expires ${p.mediaUrlExpiresAt}`,
    failed.length ? `CHECKS FAILED, do not queue: ${failed.map((c) => c.check).join("; ")}` : "Checks: all passed",
    `Copying this is not approval. To approve, write: approve ${p.packageId} for <date and time, Arizona>`,
    "",
    `TikTok info: ${JSON.stringify(p.posts.tiktok)}`,
    "",
    p.posts.youtube ? `YouTube info: ${JSON.stringify(p.posts.youtube)}` : null,
    p.posts.instagram ? "" : null,
    p.posts.instagram ? `Instagram info: ${JSON.stringify(p.posts.instagram)}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export class MetricoolPackageError extends Error {}

/** Builds the package for a ready render: downloads the file once to hash it and signs a 24-hour media link. */
export async function getMetricoolPackage(client: SupabaseClient, videoRenderId: string, now: Date = new Date()): Promise<MetricoolPackage> {
  const { data: row, error } = await client
    .from("video_renders")
    .select("id, campaign_asset_id, status, storage_path, duration_seconds")
    .eq("id", videoRenderId)
    .maybeSingle();
  if (error) throw new Error(`metricool package: ${error.message}`);
  const r = row as { id: string; campaign_asset_id: string; status: string; storage_path: string | null; duration_seconds: number | null } | null;
  if (!r) throw new MetricoolPackageError(`No render ${videoRenderId}.`);
  if (r.status !== "ready" || !r.storage_path) throw new MetricoolPackageError(`Render ${videoRenderId} is not ready (status ${r.status}).`);

  const { data: versions } = await client
    .from("content_versions")
    .select("metadata, version")
    .eq("campaign_asset_id", r.campaign_asset_id)
    .order("version", { ascending: false })
    .limit(1);
  const metadata = parseVideoRenderMetadata((versions as Array<{ metadata: unknown }> | null)?.[0]?.metadata, r.campaign_asset_id);
  if (!metadata) throw new MetricoolPackageError(`Render ${videoRenderId} has no captions stored, so no package can be built.`);

  // P2 2026-11-15: fingerprint the file from its storage metadata (ETag and size) instead of downloading the whole MP4 on every tap; a
  // missing listing falls back to the full download. The package id changes when the file changes either way.
  const sha256 = await fileFingerprint(client, r.storage_path);

  // The one-YouTube-post-per-48-hours rule (postingPlan.ts) applies to the package too.
  const { data: lastYt } = await client.from("video_posts").select("posted_at").eq("platform", "youtube_shorts").order("posted_at", { ascending: false }).limit(1);
  const youtubeBlockedUntil = youtubeNextAllowedAt(((lastYt ?? []) as Array<{ posted_at: string }>)[0]?.posted_at ?? null, now);

  const { data: signed, error: signError } = await client.storage.from(STORAGE_BUCKET).createSignedUrl(r.storage_path, MEDIA_URL_TTL_SECONDS);
  if (signError || !signed?.signedUrl) throw new Error(`metricool package: could not sign the media link (${signError?.message ?? "no url"}).`);

  return buildMetricoolPackage({
    videoRenderId: r.id,
    sha256,
    durationSeconds: r.duration_seconds,
    metadata,
    mediaUrl: signed.signedUrl,
    mediaUrlExpiresAt: new Date(now.getTime() + MEDIA_URL_TTL_SECONDS * 1000).toISOString(),
    youtubeBlockedUntil,
  });
}

async function fileFingerprint(client: SupabaseClient, path: string): Promise<string> {
  const slash = path.lastIndexOf("/");
  const folder = slash >= 0 ? path.slice(0, slash) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  let listed: unknown[] | null = null;
  try {
    listed = (await client.storage.from(STORAGE_BUCKET).list(folder, { search: name, limit: 5 })).data;
  } catch {
    listed = null; // falls back to the full download below
  }
  const entry = ((listed ?? []) as Array<{ name: string }>).find((f) => f.name === name) as { metadata?: { eTag?: string; size?: number } } | undefined;
  if (entry?.metadata?.eTag) {
    return createHash("sha256").update(`${path}:${entry.metadata.eTag}:${entry.metadata.size ?? ""}`).digest("hex");
  }
  const { data: file, error: dlError } = await client.storage.from(STORAGE_BUCKET).download(path);
  if (dlError || !file) throw new Error(`metricool package: could not read the video (${dlError?.message ?? "no data"}).`);
  return createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
}

/**
 * Records that a package was handed to the owner for Metricool (P2 2026-11-15). A handoff, never a publication: posting is only recorded
 * when the owner saves the post links. Best effort.
 */
export async function recordMetricoolHandoff(client: SupabaseClient, p: MetricoolPackage): Promise<void> {
  try {
    await client.from("audit_logs").insert({
      action_name: "metricool_package_copied",
      action_class: "EXTERNAL_DRAFT",
      outcome: "drafted",
      reason: "Metricool package built for the owner to queue by hand; this is not a publication.",
      agent: "growth-os-app",
      context: { videoRenderId: p.videoRenderId, packageId: p.packageId, platforms: Object.keys(p.posts) },
    });
  } catch {
    // never block the copy
  }
}
