import type { SupabaseClient } from "@supabase/supabase-js";
import { createLlmClient } from "../content/llmClient.js";
import { recordCostEvent } from "../cost/costTracking.js";
import { loadGroundingContext } from "../inbound/inboundHandlers.js";
import { extractYoutubeVideoId } from "../video/youtubeUrl.js";
import { checkEngagementComment } from "./commentGuardrails.js";
import { findNearDuplicate, normalizeForDedupe, selectDistinct } from "./dedupe.js";
import { draftEngagementOptions, type EngagementDraftContext, type EngagementDraftResult } from "./engagementDrafter.js";
import * as repo from "./engagementRepository.js";
import {
  EngagementBlockedError,
  arizonaDayKey,
  arizonaDayStartIso,
  checkActionAllowance,
  checkCreatorCooldown,
  checkDraftingAllowance,
  checkMinSpacing,
  checkOpenAllowance,
  checkQuotaBudget,
  nextAutoFillRun,
  AUTOFILL_TARGET_WAITING,
  pacificDayKey,
  resolveLimits,
  type Block,
  type EngagementLimits,
  type PriorDoneAction,
} from "./policy.js";
import { TiktokOembedError, fetchTiktokOembed, isTiktokUrl } from "./tiktokOembed.js";
import type { EngagementActionRow, EngagementDid, EngagementDraft, EngagementItem, EngagementPlatform, VideoMetadata } from "./types.js";
import { ENGAGEMENT_PLATFORMS } from "./types.js";
import { SHORTS_MAX_SECONDS, YoutubeDataClient } from "./youtubeDataClient.js";

export { EngagementBlockedError } from "./policy.js";
export { isMissingEngagementTables } from "./engagementRepository.js";

/** A request the owner can fix (bad input, nothing to draft). Maps to HTTP 400. */
export class EngagementActionError extends Error {}

/** integration_health row the scheduled fill reports to (api/growth-pulse.ts) and the status endpoint reads. */
export const AUTOFILL_HEALTH_KEY = "engagement_autofill";

/** Search is 100 units a call, so one discovery run runs at most this many watchlist queries. */
export const MAX_SEARCHES_PER_RUN = 3;
/** Newest uploads read per watched channel. */
export const UPLOADS_PER_CHANNEL = 5;
/** New queue rows one discovery run may add. */
export const MAX_NEW_ITEMS_PER_RUN = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Seams so handlers can be exercised with no network, LLM or clock. Nothing here can post anywhere. */
export interface EngagementDeps {
  now?: () => Date;
  limits?: Partial<EngagementLimits>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  drafter?: (context: EngagementDraftContext) => Promise<EngagementDraftResult>;
  loadGrounding?: (client: SupabaseClient) => Promise<{ brandRulesSummary: string }>;
}

function clockOf(deps: EngagementDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function limitsOf(deps: EngagementDeps): EngagementLimits {
  return resolveLimits(deps.limits);
}

/** The window of 'done' history every guardrail needs: the cooldown, and at least the current day. */
function doneWindowDays(limits: EngagementLimits): number {
  return Math.max(limits.creatorCooldownDays, 1);
}

/** Builds the read-only YouTube client, or null when YOUTUBE_API_KEY is not set (the TikTok flow still works). */
function youtubeClientFor(client: SupabaseClient, deps: EngagementDeps): YoutubeDataClient | null {
  const key = (deps.env ?? process.env).YOUTUBE_API_KEY;
  if (!key) return null;
  const limits = limitsOf(deps);
  const spend = async (endpoint: string, units: number): Promise<void> => {
    const now = clockOf(deps);
    const used = await repo.quotaUsedToday(client, now);
    const block = checkQuotaBudget(used, units, limits);
    if (block) throw new EngagementBlockedError(block);
    // Recorded BEFORE the call so a failed request still counts against the budget.
    await repo.recordQuotaUnits(client, endpoint, units, now);
  };
  return new YoutubeDataClient(key, spend, deps.fetchImpl ?? fetch);
}

function requireYoutube(client: SupabaseClient, deps: EngagementDeps): YoutubeDataClient {
  const yt = youtubeClientFor(client, deps);
  if (!yt) {
    throw new EngagementActionError("YouTube discovery is not configured: set YOUTUBE_API_KEY (a read-only Data API v3 key) in the server environment. Pasting TikTok links still works.");
  }
  return yt;
}

// ---- JSON shapes for the app --------------------------------------------------------------------------------

export function toItemJson(item: EngagementItem, block: Block | null = null) {
  return {
    id: item.id,
    platform: item.platform,
    url: item.url,
    title: item.title,
    creatorName: item.creatorName,
    thumbnailUrl: item.thumbnailUrl,
    topComments: item.topComments,
    drafts: item.drafts,
    status: item.status,
    source: item.source,
    block,
    createdAt: item.createdAt,
  };
}

function toActionJson(a: EngagementActionRow) {
  return { id: a.id, kind: a.kind, did: a.did, platform: a.platform, createdAt: a.createdAt };
}

// ---- status -------------------------------------------------------------------------------------------------

export async function getEngagementStatus(client: SupabaseClient, deps: EngagementDeps = {}) {
  const now = clockOf(deps);
  const limits = limitsOf(deps);

  // Retention is best-effort housekeeping: a failure must never hide the queue.
  try {
    await repo.purgeStaleCache(client, now);
  } catch (err) {
    if (repo.isMissingEngagementTables(err)) throw err;
    console.warn("engagement: cache purge failed", err);
  }

  const [queue, watchlist, done, quotaUsed] = await Promise.all([
    repo.listQueue(client),
    repo.listWatchlist(client),
    repo.loadRecentDoneActions(client, now, doneWindowDays(limits)),
    repo.quotaUsedToday(client, now),
  ]);

  // The last scheduled fill's summary (written by the pulse step). Best-effort: it only feeds an empty-state message.
  let lastFill: { at: string | null; note: string | null } = { at: null, note: null };
  try {
    const { data } = await client.from("integration_health").select("last_attempted_at, last_success_at, notes, last_error").eq("platform", AUTOFILL_HEALTH_KEY).maybeSingle();
    const row = data as { last_success_at?: string | null; last_attempted_at?: string | null; notes?: string | null; last_error?: string | null } | null;
    if (row) lastFill = { at: row.last_success_at ?? row.last_attempted_at ?? null, note: row.notes ?? row.last_error ?? null };
  } catch {
    // ignore
  }
  const nextFill = nextAutoFillRun(now);

  const dayStart = arizonaDayStartIso(now);
  const doneToday = (platform: EngagementPlatform) => done.filter((a) => a.platform === platform && a.createdAt >= dayStart).length;
  const spacing = checkMinSpacing(done, now, limits);

  return {
    configured: true as const,
    youtubeConfigured: Boolean((deps.env ?? process.env).YOUTUBE_API_KEY),
    limits: {
      dailyCapPerPlatform: limits.dailyCapPerPlatform,
      minSpacingSeconds: limits.minSpacingSeconds,
      creatorCooldownDays: limits.creatorCooldownDays,
    },
    today: {
      youtube: { done: doneToday("youtube"), cap: limits.dailyCapPerPlatform },
      tiktok: { done: doneToday("tiktok"), cap: limits.dailyCapPerPlatform },
    },
    nextActionInSeconds: spacing?.retryAfterSeconds ?? 0,
    autoFill: {
      targetWaiting: AUTOFILL_TARGET_WAITING,
      nextRunAt: nextFill.at,
      nextRunLabel: nextFill.label,
      lastRunAt: lastFill.at,
      lastRunNote: lastFill.note,
    },
    quota: {
      day: pacificDayKey(now),
      used: quotaUsed,
      budget: limits.youtubeDailyQuotaBudget,
      remaining: Math.max(0, limits.youtubeDailyQuotaBudget - quotaUsed),
    },
    queue: queue.map((item) => toItemJson(item, checkDraftingAllowance(item.platform, item.creatorId, done, now, limits))),
    watchlist: watchlist.map((w) => ({ id: w.id, kind: w.kind, value: w.value, label: w.label, active: w.active })),
  };
}

// ---- watchlist ----------------------------------------------------------------------------------------------

export async function addWatch(client: SupabaseClient, input: { kind: unknown; value: unknown; label?: unknown }, deps: EngagementDeps = {}) {
  if (input.kind !== "channel" && input.kind !== "query") throw new EngagementActionError('kind must be "channel" or "query"');
  const value = typeof input.value === "string" ? input.value.trim() : "";
  if (value.length < 2 || value.length > 120) throw new EngagementActionError("value must be 2 to 120 characters");
  if (input.kind === "channel" && !/^(UC[A-Za-z0-9_-]{20,24}|@[A-Za-z0-9._-]{2,60})$/.test(value)) {
    throw new EngagementActionError("A channel is a channel id (starts with UC) or an @handle");
  }
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 80) : null;
  return repo.addWatchlistEntry(client, input.kind, value, label, clockOf(deps));
}

export async function removeWatch(client: SupabaseClient, id: string): Promise<void> {
  await repo.removeWatchlistEntry(client, id);
}

// ---- discovery ----------------------------------------------------------------------------------------------

export interface DiscoveryResult {
  added: number;
  considered: number;
  skippedCooldown: number;
  skippedHandled: number;
  stoppedReason: string | null;
  errors: string[];
}

/**
 * Pulls fresh candidates from the watchlist through the official Data API (API key, read-only). Cheap calls
 * (channels, playlistItems, videos: 1 unit each) do the bulk; search.list (100 units) is capped per run and by the
 * daily budget guard in the unit spender.
 */
export interface DiscoverOptions {
  /** Hard cap on rows added this run (still bounded by the queue room and MAX_NEW_ITEMS_PER_RUN). */
  maxNew?: number;
  /** Cap on search.list calls (100 units each) this run. Defaults to MAX_SEARCHES_PER_RUN. */
  maxSearches?: number;
  /** Drop videos published longer ago than this many days (scheduled fill only). */
  maxAgeDays?: number;
  /** Drop videos whose cached view count is below this (scheduled fill only). */
  minViews?: number;
  /** Require trading-related words in search results and prefer videos with real discussion (scheduled fill only). */
  curate?: boolean;
  /** Varies which watchlist queries run so several runs a day cover the whole list. Defaults to the day number. */
  rotationSeed?: number;
}

/** Cheap relevance pre-filter for search hits; the drafter still declines anything off topic. */
const TRADING_WORDS =
  /\b(trad(?:e|es|er|ers|ing)|futures?|prop|topstep|apex|tradeify|funded|payout|combine|drawdown|scalp\w*|nq|mnq|es|mes|nasdaq|s&p|stocks?|options?|forex|market|journal|stop ?loss|risk|p&l|pnl|revenge)\b/i;

export function looksTradingRelated(title: string, description: string | null): boolean {
  return TRADING_WORDS.test(`${title} ${description ?? ""}`);
}

export async function discoverYoutube(client: SupabaseClient, deps: EngagementDeps = {}, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const yt = requireYoutube(client, deps);
  const now = clockOf(deps);
  const limits = limitsOf(deps);
  const result: DiscoveryResult = { added: 0, considered: 0, skippedCooldown: 0, skippedHandled: 0, stoppedReason: null, errors: [] };

  const room = Math.min(limits.maxPendingItems - (await repo.countPending(client)), options.maxNew ?? MAX_NEW_ITEMS_PER_RUN);
  if (room <= 0) {
    result.stoppedReason = "The queue is full. Clear some items first.";
    return result;
  }

  const watchlist = (await repo.listWatchlist(client)).filter((w) => w.active);
  if (watchlist.length === 0) {
    result.stoppedReason = "The watchlist is empty. Add a channel or a search query first.";
    return result;
  }

  const sourceById = new Map<string, "watchlist" | "search">();
  const channels = watchlist.filter((w) => w.kind === "channel");
  const queries = watchlist.filter((w) => w.kind === "query");
  // Rotate which queries run so a long list is covered across days instead of always the first few.
  const searchCap = options.maxSearches ?? MAX_SEARCHES_PER_RUN;
  const seed = options.rotationSeed ?? Math.floor(now.getTime() / DAY_MS);
  const offset = queries.length > 0 ? (seed * searchCap) % queries.length : 0;
  const todaysQueries = [...queries.slice(offset), ...queries.slice(0, offset)].slice(0, searchCap);
  const publishedAfter = new Date(now.getTime() - 7 * DAY_MS).toISOString();

  try {
    for (const entry of channels) {
      try {
        const uploads = await yt.uploadsPlaylist(entry.value);
        if (!uploads) {
          result.errors.push(`Channel ${entry.value} was not found`);
          continue;
        }
        for (const id of await yt.playlistVideoIds(uploads.playlistId, UPLOADS_PER_CHANNEL)) sourceById.set(id, "watchlist");
      } catch (err) {
        if (err instanceof EngagementBlockedError) throw err;
        result.errors.push(`Channel ${entry.value}: ${(err as Error).message}`);
      }
    }
    for (const entry of todaysQueries) {
      try {
        for (const id of await yt.searchRecentShorts(entry.value, publishedAfter, 10)) if (!sourceById.has(id)) sourceById.set(id, "search");
      } catch (err) {
        if (err instanceof EngagementBlockedError) throw err;
        result.errors.push(`Search "${entry.value}": ${(err as Error).message}`);
      }
    }
  } catch (err) {
    if (!(err instanceof EngagementBlockedError)) throw err;
    result.stoppedReason = err.block.message;
  }

  // Drop what is already queued or already handled before spending a videos.list on it.
  const fresh: string[] = [];
  for (const id of sourceById.keys()) {
    result.considered++;
    if (await repo.findItemByVideo(client, "youtube", id)) continue;
    if (await repo.isVideoHandled(client, "youtube", id)) {
      result.skippedHandled++;
      continue;
    }
    fresh.push(id);
  }
  if (fresh.length === 0) return result;

  let metas: Awaited<ReturnType<YoutubeDataClient["videos"]>> = [];
  try {
    metas = await yt.videos(fresh);
  } catch (err) {
    if (err instanceof EngagementBlockedError) {
      result.stoppedReason = err.block.message;
      return result;
    }
    throw err;
  }

  const done = await repo.loadRecentDoneActions(client, now, doneWindowDays(limits));
  const cap = Math.min(room, MAX_NEW_ITEMS_PER_RUN);
  const ordered = options.curate
    ? [...metas].sort((a, b) => (b.stats?.commentCount ?? 0) - (a.stats?.commentCount ?? 0) || (b.stats?.viewCount ?? 0) - (a.stats?.viewCount ?? 0))
    : metas;
  const oldestAllowed = options.maxAgeDays !== undefined ? now.getTime() - options.maxAgeDays * DAY_MS : null;
  for (const meta of ordered) {
    if (result.added >= cap) break;
    if (meta.durationSeconds !== null && meta.durationSeconds > SHORTS_MAX_SECONDS) continue;
    if (oldestAllowed !== null && meta.publishedAt && new Date(meta.publishedAt).getTime() < oldestAllowed) continue;
    if (options.minViews !== undefined && meta.stats && (meta.stats.viewCount ?? 0) < options.minViews) continue;
    if (options.curate && sourceById.get(meta.externalId) === "search" && !looksTradingRelated(meta.title, meta.description)) continue;
    if (!meta.creatorId || /fill-?book/i.test(meta.creatorName)) continue;
    if (checkCreatorCooldown("youtube", meta.creatorId, done, now, limits)) {
      result.skippedCooldown++;
      continue;
    }
    await repo.insertItem(client, meta, sourceById.get(meta.externalId) ?? "watchlist", now);
    result.added++;
  }
  return result;
}

// ---- pasted links -------------------------------------------------------------------------------------------

/** Adds one video the owner pasted. TikTok goes through public oEmbed only; a YouTube link costs 1 quota unit. */
export async function addLink(client: SupabaseClient, url: unknown, deps: EngagementDeps = {}): Promise<EngagementItem> {
  if (typeof url !== "string" || url.trim().length === 0) throw new EngagementActionError("Body must include { url: string }");
  const cleaned = url.trim();
  const now = clockOf(deps);

  let meta: VideoMetadata;
  if (isTiktokUrl(cleaned)) {
    try {
      meta = await fetchTiktokOembed(cleaned, deps.fetchImpl ?? fetch);
    } catch (err) {
      if (err instanceof TiktokOembedError) throw new EngagementActionError(err.message);
      throw err;
    }
  } else {
    const youtubeId = extractYoutubeVideoId(cleaned);
    if (!youtubeId) throw new EngagementActionError("Paste a YouTube Shorts or watch link, or a TikTok video link.");
    const found = await requireYoutube(client, deps).videos([youtubeId]);
    if (found.length === 0) throw new EngagementActionError("YouTube did not find that video (private, removed or wrong link).");
    meta = found[0]!;
  }

  const existing = await repo.findItemByVideo(client, meta.platform, meta.externalId);
  if (existing) {
    if (existing.status === "done" || existing.status === "skipped") throw new EngagementActionError("You already handled that video.");
    return existing;
  }
  if (await repo.isVideoHandled(client, meta.platform, meta.externalId)) throw new EngagementActionError("You already handled that video.");
  return repo.insertItem(client, meta, "pasted", now);
}

// ---- drafting -----------------------------------------------------------------------------------------------

const MAX_DRAFT_ROUNDS = 3;
const MAX_OPTIONS = 3;

function firstWords(text: string, n: number): string {
  return normalizeForDedupe(text).split(" ").slice(0, n).join(" ");
}

async function loadItemOrThrow(client: SupabaseClient, id: unknown): Promise<EngagementItem> {
  if (typeof id !== "string" || id.length === 0) throw new EngagementActionError("Body must include { id: string }");
  const item = await repo.getItem(client, id);
  if (!item) throw new EngagementActionError(`No engagement item with id "${id}"`);
  return item;
}

export async function draftItem(client: SupabaseClient, id: unknown, deps: EngagementDeps = {}): Promise<EngagementItem> {
  const item = await loadItemOrThrow(client, id);
  if (item.status === "done" || item.status === "skipped") throw new EngagementActionError("That item is already closed.");
  const now = clockOf(deps);
  const limits = limitsOf(deps);

  // Refuse before spending anything: daily cap and per-creator cooldown.
  const done = await repo.loadRecentDoneActions(client, now, doneWindowDays(limits));
  const block = checkDraftingAllowance(item.platform, item.creatorId, done, now, limits);
  if (block) throw new EngagementBlockedError(block);

  // Top comments give the draft something real to react to. Best-effort: quota or API trouble just means fewer clues.
  let topComments = item.topComments;
  if (item.platform === "youtube" && topComments.length === 0) {
    const yt = youtubeClientFor(client, deps);
    if (yt) {
      try {
        topComments = await yt.topComments(item.externalId, 5);
        if (topComments.length > 0) await repo.updateItem(client, item.id, { topComments }, now);
      } catch (err) {
        if (!(err instanceof EngagementBlockedError)) console.warn("engagement: top comments lookup failed");
      }
    }
  }

  const history = await repo.loadRecentCommentTexts(client, limits.recentCommentWindow);
  let brandRulesSummary = "";
  try {
    brandRulesSummary = (await (deps.loadGrounding ?? loadGroundingContext)(client)).brandRulesSummary;
  } catch {
    // Grounding is a nicety; the hard guardrails below do not depend on it.
  }

  const costWrites: Array<Promise<unknown>> = [];
  const drafter =
    deps.drafter ??
    (async (context: EngagementDraftContext) => {
      const llm = createLlmClient(deps.env ?? process.env, (usage) => {
        costWrites.push(recordCostEvent(client, usage, { endpoint: "engagement-draft", engagementItemId: item.id }));
      });
      return draftEngagementOptions(llm, context);
    });

  const accepted: string[] = [];
  const feedback: string[] = [];
  let skipReason: string | null = null;
  try {
    for (let round = 0; round < MAX_DRAFT_ROUNDS && accepted.length < 2; round++) {
      const result = await drafter({
        platform: item.platform,
        title: item.title,
        creatorName: item.creatorName,
        description: item.description,
        topComments,
        recentOpeners: history.slice(0, 10).map((t) => firstWords(t, 4)).filter((w) => w.length > 0),
        brandRulesSummary,
        feedback: [...feedback],
      });
      if (result.options.length === 0) {
        skipReason = result.skipReason ?? "nothing specific to add";
        break;
      }
      const passing: string[] = [];
      for (const text of result.options) {
        const problem = checkEngagementComment(text, item.platform);
        if (problem) feedback.push(`"${text}" ${problem}`);
        else passing.push(text);
      }
      const { accepted: fresh, rejected } = selectDistinct(passing, [...history, ...accepted]);
      for (const r of rejected) feedback.push(`"${r.text}" ${r.reason}`);
      accepted.push(...fresh);
    }
  } finally {
    await Promise.allSettled(costWrites);
  }

  if (accepted.length === 0) {
    if (skipReason) throw new EngagementActionError(`Nothing worth saying here (${skipReason}). Skip it.`);
    throw new EngagementActionError(`Could not write a comment that passes the guardrails (${feedback.slice(0, 2).join("; ") || "no usable options"}). Try again or skip.`);
  }

  const drafts: EngagementDraft[] = accepted.slice(0, MAX_OPTIONS).map((text, i) => ({ id: `d${i + 1}`, text }));
  await repo.updateItem(client, item.id, { status: "drafted", drafts }, now);
  await repo.recordAction(
    client,
    { itemId: item.id, platform: item.platform, externalId: item.externalId, creatorId: item.creatorId, creatorName: item.creatorName, kind: "drafted", draftText: drafts.map((d) => d.text).join("\n---\n") },
    now,
  );
  return { ...item, topComments, status: "drafted", drafts, updatedAt: now.toISOString() };
}

// ---- owner actions (open / copy / done / skip) --------------------------------------------------------------

/** Soft problems with owner-edited text. Shown as warnings: the owner has final control of what is posted. */
async function warningsFor(client: SupabaseClient, text: string, platform: EngagementPlatform, limits: EngagementLimits, ownDrafts: EngagementDraft[]): Promise<string[]> {
  const warnings: string[] = [];
  const problem = checkEngagementComment(text, platform);
  if (problem) warnings.push(`This text ${problem}.`);
  const history = await repo.loadRecentCommentTexts(client, limits.recentCommentWindow);
  const ownTexts = new Set(ownDrafts.map((d) => normalizeForDedupe(d.text)));
  // This item's own drafts are in history; they are not "recent comments", so they do not count against the text.
  const others = history.filter((h) => !ownTexts.has(normalizeForDedupe(h)));
  if (findNearDuplicate(text, others)) warnings.push("This is nearly identical to a recent comment. Change it so it is not repetitive.");
  return warnings;
}

export async function recordOpen(client: SupabaseClient, id: unknown, deps: EngagementDeps = {}) {
  const item = await loadItemOrThrow(client, id);
  const now = clockOf(deps);
  const limits = limitsOf(deps);
  const done = await repo.loadRecentDoneActions(client, now, doneWindowDays(limits));
  const block = checkOpenAllowance(item.platform, item.creatorId, done, now, limits);
  if (block) throw new EngagementBlockedError(block);
  await repo.recordAction(client, { itemId: item.id, platform: item.platform, externalId: item.externalId, creatorId: item.creatorId, creatorName: item.creatorName, kind: "opened" }, now);
  return { id: item.id, url: item.url };
}

export async function recordCopy(client: SupabaseClient, input: { id: unknown; draftId?: unknown; text?: unknown }, deps: EngagementDeps = {}) {
  const item = await loadItemOrThrow(client, input.id);
  const now = clockOf(deps);
  const limits = limitsOf(deps);
  const done = await repo.loadRecentDoneActions(client, now, doneWindowDays(limits));
  const block = checkActionAllowance(item.platform, item.creatorId, done, now, limits);
  if (block) throw new EngagementBlockedError(block);

  const draft = typeof input.draftId === "string" ? item.drafts.find((d) => d.id === input.draftId) : undefined;
  const edited = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
  const text = edited || draft?.text || "";
  if (!text) throw new EngagementActionError("Nothing to copy: pick a draft or provide text.");

  const warnings = await warningsFor(client, text, item.platform, limits, item.drafts);
  await repo.recordAction(
    client,
    { itemId: item.id, platform: item.platform, externalId: item.externalId, creatorId: item.creatorId, creatorName: item.creatorName, kind: "copied", draftId: draft?.id ?? null, draftText: draft?.text ?? null, finalText: text },
    now,
  );
  return { id: item.id, text, warnings };
}

function isDid(value: unknown): value is EngagementDid {
  return value === "commented" || value === "liked" || value === "both";
}

/** Records that the OWNER posted or liked. This is the only action that counts toward the caps. */
export async function markDone(client: SupabaseClient, input: { id: unknown; did?: unknown; draftId?: unknown; finalText?: unknown }, deps: EngagementDeps = {}) {
  const item = await loadItemOrThrow(client, input.id);
  if (item.status === "done" || item.status === "skipped") throw new EngagementActionError("That item is already closed.");
  if (input.did !== undefined && !isDid(input.did)) throw new EngagementActionError('did must be "commented", "liked" or "both"');
  const did: EngagementDid = input.did ?? "commented";
  const now = clockOf(deps);
  const limits = limitsOf(deps);

  const done = await repo.loadRecentDoneActions(client, now, doneWindowDays(limits));
  const block = checkActionAllowance(item.platform, item.creatorId, done, now, limits);
  if (block) throw new EngagementBlockedError(block);

  const draft = typeof input.draftId === "string" ? item.drafts.find((d) => d.id === input.draftId) : undefined;
  const typed = typeof input.finalText === "string" ? input.finalText.replace(/\s+/g, " ").trim() : "";
  const finalText = did === "liked" ? null : typed || draft?.text || null;
  const warnings = finalText ? await warningsFor(client, finalText, item.platform, limits, item.drafts) : [];

  const action = await repo.recordAction(
    client,
    { itemId: item.id, platform: item.platform, externalId: item.externalId, creatorId: item.creatorId, creatorName: item.creatorName, kind: "done", did, draftId: draft?.id ?? null, draftText: draft?.text ?? null, finalText },
    now,
  );
  await repo.updateItem(client, item.id, { status: "done" }, now);
  return { item: toItemJson({ ...item, status: "done" }), action: toActionJson(action), warnings };
}

export async function skipItem(client: SupabaseClient, input: { id: unknown; reason?: unknown }, deps: EngagementDeps = {}) {
  const item = await loadItemOrThrow(client, input.id);
  const now = clockOf(deps);
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim().slice(0, 160) : null;
  await repo.updateItem(client, item.id, { status: "skipped", skipReason: reason }, now);
  await repo.recordAction(client, { itemId: item.id, platform: item.platform, externalId: item.externalId, creatorId: item.creatorId, creatorName: item.creatorName, kind: "skipped" }, now);
  return { id: item.id, status: "skipped" as const };
}

// ---- outcomes + stats ---------------------------------------------------------------------------------------

/** The owner's manual note on what a done action led to (a reply, profile visits), so we can see what works. */
export async function logOutcome(client: SupabaseClient, input: { actionId: unknown; gotReply?: unknown; profileVisits?: unknown; note?: unknown }, deps: EngagementDeps = {}) {
  if (typeof input.actionId !== "string" || !input.actionId) throw new EngagementActionError("Body must include { actionId: string }");
  const action = await repo.getAction(client, input.actionId);
  if (!action || action.kind !== "done") throw new EngagementActionError("Outcomes can only be logged on a done action.");

  const gotReply = typeof input.gotReply === "boolean" ? input.gotReply : null;
  let profileVisits: number | null = null;
  if (input.profileVisits !== undefined && input.profileVisits !== null) {
    const n = Number(input.profileVisits);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new EngagementActionError("profileVisits must be a whole number, 0 or more");
    profileVisits = n;
  }
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 300) : null;
  if (gotReply === null && profileVisits === null && note === null) throw new EngagementActionError("Provide gotReply, profileVisits or note.");
  await repo.logOutcome(client, action.id, { gotReply, profileVisits, note }, clockOf(deps));
  return { id: action.id, gotReply, profileVisits, note };
}

export interface DayStats {
  day: string;
  platform: EngagementPlatform;
  done: number;
  copied: number;
  opened: number;
  skipped: number;
  drafted: number;
}

export async function getEngagementStats(client: SupabaseClient, days = 14, deps: EngagementDeps = {}) {
  const now = clockOf(deps);
  const span = Math.min(Math.max(Math.floor(days), 1), 90);
  const since = new Date(now.getTime() - span * DAY_MS).toISOString();
  const actions = await repo.listActionsSince(client, since);

  const byKey = new Map<string, DayStats>();
  for (const a of actions) {
    const day = arizonaDayKey(new Date(a.createdAt));
    const key = `${day}|${a.platform}`;
    const row = byKey.get(key) ?? { day, platform: a.platform, done: 0, copied: 0, opened: 0, skipped: 0, drafted: 0 };
    row[a.kind]++;
    byKey.set(key, row);
  }

  const doneRows = actions.filter((a) => a.kind === "done");
  const logged = doneRows.filter((a) => a.gotReply !== null || a.profileVisits !== null);
  return {
    days: span,
    byDay: [...byKey.values()].sort((a, b) => (a.day === b.day ? a.platform.localeCompare(b.platform) : a.day < b.day ? 1 : -1)),
    totals: Object.fromEntries(
      ENGAGEMENT_PLATFORMS.map((p) => [p, { done: doneRows.filter((a) => a.platform === p).length }]),
    ) as Record<EngagementPlatform, { done: number }>,
    outcomes: {
      done: doneRows.length,
      logged: logged.length,
      gotReply: logged.filter((a) => a.gotReply === true).length,
      profileVisits: logged.reduce((sum, a) => sum + (a.profileVisits ?? 0), 0),
    },
  };
}

export type { PriorDoneAction };
