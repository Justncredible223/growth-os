import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage } from "../lib/errorMessage.js";
import {
  EngagementActionError,
  EngagementDraftDeclined,
  discoverYoutube,
  draftItem,
  skipItem,
  type DiscoveryDiagnostics,
  type DiscoveryResult,
  type EngagementDeps,
} from "./engagementHandlers.js";
import * as repo from "./engagementRepository.js";
import {
  AUTOFILL_MAX_AGE_DAYS,
  AUTOFILL_MAX_DRAFTS_PER_RUN,
  AUTOFILL_MAX_SEARCHES_PER_RUN,
  AUTOFILL_MIN_VIEWS,
  AUTOFILL_RUN_HOURS_UTC,
  AUTOFILL_SEARCH_ORDERS,
  AUTOFILL_SEARCH_RESULTS_PER_QUERY,
  AUTOFILL_TARGET_WAITING,
  EngagementBlockedError,
  checkCreatorCooldown,
  resolveLimits,
} from "./policy.js";

// The tuning knobs live in policy.ts (one place, with the quota math); re-exported for callers and tests.
export {
  AUTOFILL_MAX_AGE_DAYS,
  AUTOFILL_MAX_DRAFTS_PER_RUN,
  AUTOFILL_MAX_SEARCHES_PER_RUN,
  AUTOFILL_MIN_VIEWS,
  AUTOFILL_SEARCH_ORDERS,
  AUTOFILL_SEARCH_RESULTS_PER_QUERY,
};

/**
 * The scheduled "ready to go" fill for the Engage tab (docs/ENGAGEMENT_ASSISTANT.md). Rides on the existing
 * growth-pulse cron (the youtubeComments step group, 3 runs a day), so it adds no serverless function.
 *
 * It only DISCOVERS and DRAFTS. Nothing here posts, likes or follows anything: the owner still opens each video and
 * posts by hand with one tap per item. TikTok has no discovery API, so TikTok items still arrive only as links the
 * owner pastes (they get drafted here too once pasted).
 *
 * Bounded and idempotent: it tops the queue up to AUTOFILL_TARGET_WAITING, searches are capped per run and by the
 * daily quota guard, drafting is capped per run and by a time budget, and a second run right after the first finds
 * nothing left to do.
 */

/** Model calls are slow (up to ~20 s each); the draft cap (policy.ts) and this budget keep the run inside the 60 s limit. */
export const AUTOFILL_TIME_BUDGET_MS = 35_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** integration_health row holding the full per-run rejection breakdown as JSON (the main row stays one short line). */
export const AUTOFILL_DETAIL_HEALTH_KEY = "engagement_autofill_detail";

/** Marker row in integration_health so a deliberately emptied watchlist is never re-seeded (first seed, 6 queries). */
export const AUTOFILL_SEED_MARKER = "engagement_seed";
/** Marker for the second seed (the 2026-10-10 yield rework). Written once; its presence ends all seeding work. */
export const AUTOFILL_SEED_MARKER_V2 = "engagement_seed_v2";

/** The first seeded set. Only used to recognise an UNTOUCHED seeded watchlist so it can be migrated once. */
export const ORIGINAL_WATCH_QUERIES = [
  "prop firm trading",
  "futures trading journal",
  "topstep combine",
  "apex trader funding",
  "trading psychology revenge trading",
  "daily loss limit trading",
] as const;

/**
 * What a futures / prop-firm trader's audience actually searches and watches, in natural search phrasing. Nine
 * queries at 3 per run and 3 runs a day cover the whole list once a day.
 */
export const DEFAULT_WATCH_QUERIES = [
  "topstep payout",
  "apex funded account",
  "prop firm rules explained",
  "blew my funded account",
  "futures day trading",
  "trading journal",
  "revenge trading",
  "trailing drawdown explained",
  "prop firm challenge",
] as const;

/**
 * Stateless rotation seed: consecutive scheduled runs get consecutive seeds, so with 3 queries per run the windows
 * are adjacent and never overlap (a time-slot hash left gaps and repeats). Runs between schedule slots (manual
 * triggers) share the seed of the latest slot, so they re-read the same window rather than skipping ahead.
 */
export function autoFillRotationSeed(now: Date): number {
  const hours = [...AUTOFILL_RUN_HOURS_UTC].sort((a, b) => a - b);
  const day = Math.floor(now.getTime() / DAY_MS);
  const hour = now.getUTCHours();
  let slot = -1;
  hours.forEach((h, i) => {
    if (hour >= h) slot = i;
  });
  return day * hours.length + slot;
}

/** The full breakdown of one run, stored as JSON in the engagement_autofill_detail integration_health row. */
export interface AutoFillDetail {
  at: string;
  knobs: { searchesPerRun: number; resultsPerQuery: number; maxAgeDays: number; minViews: number; orders: readonly string[] };
  /** Null when discovery did not run (queue already full, paused, quota). */
  funnel: DiscoveryDiagnostics | null;
  /** Discovery errors and why it stopped, if it did. */
  discovery: { stoppedReason: string | null; errors: string[]; failed: string | null };
  drafting: {
    attempted: number;
    drafted: number;
    /** The drafter chose to say nothing. */
    declined: number;
    /** Options were written but none passed the comment guardrails. */
    guardrail: number;
    /** Left alone because the creator is on cooldown or the daily cap was hit. */
    blocked: number;
    declineReasons: string[];
    stop: string | null;
  };
  queue: { waitingBefore: number; onCooldownBefore: number; waitingAfter: number };
  quota: { thisRun: number; today: number; budget: number };
}

export interface AutoFillResult {
  skipped: boolean;
  /** The one-line step summary the pulse reports. */
  summary: string;
  seeded: number;
  discovered: number;
  drafted: number;
  autoSkipped: number;
  waiting: number;
  quotaUsed: number;
  /** Present when the run got as far as discovery/drafting. */
  detail?: AutoFillDetail;
}

export interface AutoFillDeps extends EngagementDeps {
  isPaused: () => Promise<boolean>;
  /** Wall clock for the time budget; separate from `now` so tests can control it. */
  monotonicMs?: () => number;
}

function emptyResult(summary: string, skipped: boolean): AutoFillResult {
  return { skipped, summary, seeded: 0, discovered: 0, drafted: 0, autoSkipped: 0, waiting: 0, quotaUsed: 0 };
}

async function markSeeded(client: SupabaseClient, platform: string, now: Date, notes: string): Promise<void> {
  const iso = now.toISOString();
  const { error } = await client
    .from("integration_health")
    .upsert({ platform, status: "healthy", last_checked_at: iso, last_success_at: iso, notes }, { onConflict: "platform" });
  if (error) throw new Error(`seed marker write failed: ${error.message}`);
}

async function markerExists(client: SupabaseClient, platform: string): Promise<boolean> {
  const { data, error } = await client.from("integration_health").select("platform").eq("platform", platform).maybeSingle();
  if (error) throw new Error(`seed marker lookup failed: ${error.message}`);
  return Boolean(data);
}

const lower = (v: string) => v.trim().toLowerCase();

/**
 * Seeds the default watchlist, once per seed marker, and never at the expense of an owner-curated list.
 *
 *  - v2 marker present: nothing to do (also covers a deliberately emptied list).
 *  - never seeded and the list is empty: seed the current defaults.
 *  - seeded before (v1 marker) and the list is exactly the untouched original seed (all six original queries, label
 *    "default", all active, nothing else): swap it for the current defaults. Anything the owner added, removed,
 *    relabelled or deactivated makes the list "curated" and it is left completely alone.
 * The swap inserts the new rows first, then deletes the original rows, then writes the marker, and it recognises its
 * own half-finished state, so it is safe to re-run after a crash.
 * Returns the number of queries inserted.
 */
export async function seedDefaultWatchlist(client: SupabaseClient, now: Date): Promise<number> {
  if (await markerExists(client, AUTOFILL_SEED_MARKER_V2)) return 0;
  const seededBefore = await markerExists(client, AUTOFILL_SEED_MARKER);
  const list = await repo.listWatchlist(client);

  if (list.length === 0) {
    if (seededBefore) {
      // The owner emptied it on purpose; remember so it is never re-seeded.
      await markSeeded(client, AUTOFILL_SEED_MARKER_V2, now, "emptied by owner; not re-seeded");
      return 0;
    }
    for (const query of DEFAULT_WATCH_QUERIES) await repo.addWatchlistEntry(client, "query", query, "default", now);
    await markSeeded(client, AUTOFILL_SEED_MARKER, now, `seeded ${DEFAULT_WATCH_QUERIES.length} default queries`);
    await markSeeded(client, AUTOFILL_SEED_MARKER_V2, now, `seeded ${DEFAULT_WATCH_QUERIES.length} default queries`);
    return DEFAULT_WATCH_QUERIES.length;
  }

  const original = new Set<string>(ORIGINAL_WATCH_QUERIES.map(lower));
  const current = new Set<string>(DEFAULT_WATCH_QUERIES.map(lower));
  const allSeededRows = list.every((w) => w.kind === "query" && w.label === "default" && w.active && (original.has(lower(w.value)) || current.has(lower(w.value))));
  const originalRows = list.filter((w) => original.has(lower(w.value)) && !current.has(lower(w.value)));
  const currentRows = list.filter((w) => current.has(lower(w.value)));
  const hasAllOriginal = originalRows.length === original.size;
  const hasAllCurrent = currentRows.length === current.size;
  const untouchedSeed = seededBefore && allSeededRows && (hasAllOriginal || hasAllCurrent);

  if (!untouchedSeed) {
    // Owner-curated (or never seeded but not empty): leave every row alone and never come back to it.
    await markSeeded(client, AUTOFILL_SEED_MARKER, now, "owner watchlist present");
    await markSeeded(client, AUTOFILL_SEED_MARKER_V2, now, "owner watchlist left untouched");
    return 0;
  }

  let inserted = 0;
  for (const query of DEFAULT_WATCH_QUERIES) {
    if (currentRows.some((w) => lower(w.value) === lower(query))) continue;
    await repo.addWatchlistEntry(client, "query", query, "default", now);
    inserted++;
  }
  for (const row of originalRows) await repo.removeWatchlistEntry(client, row.id);
  await markSeeded(client, AUTOFILL_SEED_MARKER_V2, now, `migrated seeded watchlist to ${DEFAULT_WATCH_QUERIES.length} queries`);
  return inserted;
}

/** Never throws: every failure mode becomes a one-line summary. */
export async function runEngagementAutoFill(client: SupabaseClient, deps: AutoFillDeps): Promise<AutoFillResult> {
  try {
    return await run(client, deps);
  } catch (err) {
    if (repo.isMissingEngagementTables(err)) return emptyResult("skipped -- migration 0050 (engagement tables) not applied yet", true);
    return emptyResult(`failed -- ${errorMessage(err)}`, false);
  }
}

async function run(client: SupabaseClient, deps: AutoFillDeps): Promise<AutoFillResult> {
  const now = deps.now ? deps.now() : new Date();
  const limits = resolveLimits(deps.limits);
  const clock = deps.monotonicMs ?? (() => Date.now());
  const startedMs = clock();

  // Retention first and always: the 30-day purge of cached YouTube data is a policy obligation, so it runs on
  // every scheduled pass, even when the system is paused or the key is missing. It also detects a missing migration.
  await repo.purgeStaleCache(client, now);

  if (await deps.isPaused()) return emptyResult("skipped -- system is paused", true);

  const env = deps.env ?? process.env;
  if (!env.YOUTUBE_API_KEY) return emptyResult("skipped -- YOUTUBE_API_KEY not configured", true);

  const quotaBefore = await repo.quotaUsedToday(client, now);
  if (quotaBefore >= limits.youtubeDailyQuotaBudget) {
    return { ...emptyResult(`skipped -- YouTube quota budget reached (${quotaBefore}/${limits.youtubeDailyQuotaBudget} units today)`, true), quotaUsed: quotaBefore };
  }

  const seeded = await seedDefaultWatchlist(client, now);

  // Items whose creator is on cooldown cannot be drafted or posted until the cooldown ends, so they do not count as
  // "ready": the queue is topped up to the target of USABLE waiting items (the hard cap still counts every item).
  const queueBefore = await repo.listQueue(client, 500);
  const doneRecent = await repo.loadRecentDoneActions(client, now, Math.max(limits.creatorCooldownDays, 1));
  const onCooldownBefore = queueBefore.filter((i) => checkCreatorCooldown(i.platform, i.creatorId, doneRecent, now, limits)).length;
  const waitingBefore = queueBefore.length;
  const room = Math.min(AUTOFILL_TARGET_WAITING - (waitingBefore - onCooldownBefore), limits.maxPendingItems - waitingBefore);

  let discovery: DiscoveryResult | null = null;
  let discoveryError: string | null = null;
  if (room > 0) {
    try {
      discovery = await discoverYoutube(client, deps, {
        maxNew: room,
        maxSearches: AUTOFILL_MAX_SEARCHES_PER_RUN,
        maxAgeDays: AUTOFILL_MAX_AGE_DAYS,
        minViews: AUTOFILL_MIN_VIEWS,
        curate: true,
        rotationSeed: autoFillRotationSeed(now),
        searchOrders: AUTOFILL_SEARCH_ORDERS,
        searchResultsPerQuery: AUTOFILL_SEARCH_RESULTS_PER_QUERY,
      });
    } catch (err) {
      discoveryError = errorMessage(err);
    }
  }
  if (discovery) {
    // The exact queries, so a run's yield can be traced to what was searched.
    console.log(`engagement_autofill: searches ${JSON.stringify(discovery.diagnostics.queries)}`);
  }

  // Pre-draft every undrafted waiting item (oldest first), bounded per run and by the time budget.
  let drafted = 0;
  let autoSkipped = 0;
  let declined = 0;
  let guardrail = 0;
  let blocked = 0;
  let attempted = 0;
  let failures = 0;
  let stopNote: string | null = null;
  const declineReasons: string[] = [];
  const undrafted = (await repo.listQueue(client, 500)).filter((i) => i.status === "new").reverse();
  for (const item of undrafted) {
    if (drafted + autoSkipped >= AUTOFILL_MAX_DRAFTS_PER_RUN) {
      stopNote = "draft cap per run";
      break;
    }
    if (clock() - startedMs > AUTOFILL_TIME_BUDGET_MS) {
      stopNote = "time budget";
      break;
    }
    attempted++;
    try {
      await draftItem(client, item.id, deps);
      drafted++;
    } catch (err) {
      if (err instanceof EngagementBlockedError) {
        if (err.block.code === "daily_cap") {
          stopNote = "daily cap reached";
          break;
        }
        blocked++;
        continue; // creator on cooldown: leave it for later
      }
      if (err instanceof EngagementActionError) {
        // The drafter declined (off topic, nothing to add) or nothing passed the guardrails: not worth a card.
        // Only THIS video is closed. Cooldown is driven by done actions only, so the creator's other videos stay
        // eligible.
        if (err instanceof EngagementDraftDeclined) {
          declined++;
          if (declineReasons.length < 8) declineReasons.push(err.reason.slice(0, 80));
        } else {
          guardrail++;
        }
        await skipItem(client, { id: item.id, reason: `auto: ${err.message}` }, deps);
        autoSkipped++;
        continue;
      }
      failures++;
      if (failures >= 2) {
        stopNote = `drafting errors (${errorMessage(err)})`;
        break;
      }
    }
  }

  const waiting = (await repo.listQueue(client, 500)).length;
  const quotaUsed = await repo.quotaUsedToday(client, now);
  const diag = discovery?.diagnostics ?? null;
  const parts = [
    `discovered ${discovery?.added ?? 0}`,
    `drafted ${drafted}`,
    ...(autoSkipped > 0 ? [`auto-skipped ${autoSkipped}`] : []),
    `queue ${waiting}`,
    `quota ${quotaUsed - quotaBefore} units this run (${quotaUsed}/${limits.youtubeDailyQuotaBudget} today)`,
  ];
  const notes = [
    ...(seeded > 0 ? [`seeded ${seeded} default queries`] : []),
    ...(diag && diag.seen > 0 ? [funnelLine(diag)] : []),
    ...(discovery?.stoppedReason ? [`discovery stopped: ${discovery.stoppedReason}`] : []),
    ...(discovery && discovery.errors.length > 0 ? [`${discovery.errors.length} source error(s)`] : []),
    ...(discoveryError ? [`discovery failed: ${discoveryError}`] : []),
    ...(stopNote ? [`drafting stopped: ${stopNote}`] : []),
  ];
  const detail: AutoFillDetail = {
    at: now.toISOString(),
    knobs: {
      searchesPerRun: AUTOFILL_MAX_SEARCHES_PER_RUN,
      resultsPerQuery: AUTOFILL_SEARCH_RESULTS_PER_QUERY,
      maxAgeDays: AUTOFILL_MAX_AGE_DAYS,
      minViews: AUTOFILL_MIN_VIEWS,
      orders: AUTOFILL_SEARCH_ORDERS,
    },
    funnel: diag,
    discovery: { stoppedReason: discovery?.stoppedReason ?? null, errors: (discovery?.errors ?? []).slice(0, 5).map((e) => e.slice(0, 160)), failed: discoveryError },
    drafting: { attempted, drafted, declined, guardrail, blocked, declineReasons, stop: stopNote },
    queue: { waitingBefore, onCooldownBefore, waitingAfter: waiting },
    quota: { thisRun: quotaUsed - quotaBefore, today: quotaUsed, budget: limits.youtubeDailyQuotaBudget },
  };
  await writeDetailRow(client, now, detail);
  return {
    skipped: false,
    summary: parts.join(", ") + (notes.length > 0 ? ` (${notes.join("; ")})` : ""),
    seeded,
    discovered: discovery?.added ?? 0,
    drafted,
    autoSkipped,
    waiting,
    quotaUsed,
    detail,
  };
}

const FUNNEL_LABELS: Array<[keyof DiscoveryDiagnostics, string]> = [
  ["notShortLength", "long"],
  ["tooOld", "old"],
  ["tooFewViews", "low views"],
  ["noTradingWords", "off topic"],
  ["creatorCooldown", "cooldown"],
  ["creatorAlreadyQueued", "same creator"],
  ["alreadyHandled", "handled"],
  ["alreadyQueued", "queued"],
  ["notReturned", "gone"],
  ["noCreatorOrOwn", "own/none"],
  ["roomExhausted", "no room"],
];

/** Short, non-zero-only funnel for the one-line summary, e.g. "funnel 18 seen, 1 added; low views 9, off topic 4". */
export function funnelLine(d: DiscoveryDiagnostics): string {
  const drops = FUNNEL_LABELS.map(([key, label]) => [label, d[key] as number] as const).filter(([, n]) => n > 0);
  return `funnel ${d.seen} seen, ${d.added} added${drops.length > 0 ? `; ${drops.map(([l, n]) => `${l} ${n}`).join(", ")}` : ""}`;
}

/** Best-effort: the breakdown must never fail a fill. A separate row keeps the main row's one-line note readable. */
async function writeDetailRow(client: SupabaseClient, now: Date, detail: AutoFillDetail): Promise<void> {
  try {
    const iso = now.toISOString();
    await client
      .from("integration_health")
      .upsert(
        { platform: AUTOFILL_DETAIL_HEALTH_KEY, status: "healthy", last_checked_at: iso, last_success_at: iso, last_error: null, notes: JSON.stringify(detail) },
        { onConflict: "platform" },
      );
  } catch {
    // ignore
  }
}
