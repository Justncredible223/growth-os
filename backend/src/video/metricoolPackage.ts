import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseVideoRenderMetadata, type VideoRenderMetadataJson } from "./videoStatusHandlers.js";

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
  /** One createScheduledPost `info` per network, without the date (the session adds publicationDate after Justin's yes). */
  posts: { tiktok: Record<string, unknown>; youtube: Record<string, unknown> };
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
}): MetricoolPackage {
  const { metadata: m } = input;
  const tags = m.hashtags.slice(0, MAX_HASHTAGS).map((t) => t.replace(/^#/, ""));
  const tiktokText = `${m.tiktokCaption} ${hashtagLine(tags)}`.trim();
  const youtubeTitle = m.youtubeTitle.slice(0, YOUTUBE_TITLE_MAX);
  const base = { autoPublish: METRICOOL_AUTO_PUBLISH, draft: false, descendants: [], firstCommentText: "", hasNotReadNotes: false, shortener: false, smartLinkData: { ids: [] }, media: [input.mediaUrl], mediaAltText: [] };
  const tiktok = {
    ...base,
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
  const packageId = `mp-${createHash("sha256").update(JSON.stringify([input.videoRenderId, input.sha256, tiktokText, youtubeTitle, m.youtubeDescription])).digest("hex").slice(0, 8)}`;
  return {
    packageId,
    videoRenderId: input.videoRenderId,
    sha256: input.sha256,
    durationSeconds: input.durationSeconds,
    mediaUrl: input.mediaUrl,
    mediaUrlExpiresAt: input.mediaUrlExpiresAt,
    posts: { tiktok, youtube },
    checks,
  };
}

/** The text Justin copies from the app: what to approve, then the two `info` objects for the session. */
export function metricoolPackageText(p: MetricoolPackage): string {
  const failed = p.checks.filter((c) => !c.ok);
  return [
    `METRICOOL PACKAGE ${p.packageId}`,
    `Render ${p.videoRenderId}${p.durationSeconds ? `, ${p.durationSeconds.toFixed(1)} s` : ""}`,
    `File SHA256 ${p.sha256}`,
    `Platforms: TikTok + YouTube Short (one post each). Autopublish: ${METRICOOL_AUTO_PUBLISH ? "on" : "off (Metricool notifies the phone)"}`,
    `Media link expires ${p.mediaUrlExpiresAt}`,
    failed.length ? `CHECKS FAILED, do not queue: ${failed.map((c) => c.check).join("; ")}` : "Checks: all passed",
    `Copying this is not approval. To approve, write: approve ${p.packageId} for <date and time, Arizona>`,
    "",
    `TikTok info: ${JSON.stringify(p.posts.tiktok)}`,
    "",
    `YouTube info: ${JSON.stringify(p.posts.youtube)}`,
  ].join("\n");
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

  const { data: file, error: dlError } = await client.storage.from(STORAGE_BUCKET).download(r.storage_path);
  if (dlError || !file) throw new Error(`metricool package: could not read the video (${dlError?.message ?? "no data"}).`);
  const sha256 = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");

  const { data: signed, error: signError } = await client.storage.from(STORAGE_BUCKET).createSignedUrl(r.storage_path, MEDIA_URL_TTL_SECONDS);
  if (signError || !signed?.signedUrl) throw new Error(`metricool package: could not sign the media link (${signError?.message ?? "no url"}).`);

  return buildMetricoolPackage({
    videoRenderId: r.id,
    sha256,
    durationSeconds: r.duration_seconds,
    metadata,
    mediaUrl: signed.signedUrl,
    mediaUrlExpiresAt: new Date(now.getTime() + MEDIA_URL_TTL_SECONDS * 1000).toISOString(),
  });
}
