import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage } from "../lib/errorMessage.js";
import {
  EngagementActionError,
  discoverYoutube,
  draftItem,
  skipItem,
  type DiscoveryResult,
  type EngagementDeps,
} from "./engagementHandlers.js";
import * as repo from "./engagementRepository.js";
import { AUTOFILL_TARGET_WAITING, EngagementBlockedError, resolveLimits } from "./policy.js";

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

/** search.list is 100 units; 2 per run x 3 runs a day is at most 600 units of the 3,000 budget. */
export const AUTOFILL_MAX_SEARCHES_PER_RUN = 2;
/** Model calls are slow (up to ~20 s each); this and the time budget keep the run inside the 60 s function limit. */
export const AUTOFILL_MAX_DRAFTS_PER_RUN = 8;
export const AUTOFILL_TIME_BUDGET_MS = 35_000;
export const AUTOFILL_MIN_VIEWS = 100;
export const AUTOFILL_MAX_AGE_DAYS = 7;
const RUN_SLOT_MS = 5 * 60 * 60 * 1000;

/** Marker row in integration_health so a deliberately emptied watchlist is never re-seeded. */
export const AUTOFILL_SEED_MARKER = "engagement_seed";

export const DEFAULT_WATCH_QUERIES = [
  "prop firm trading",
  "futures trading journal",
  "topstep combine",
  "apex trader funding",
  "trading psychology revenge trading",
  "daily loss limit trading",
] as const;

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
}

export interface AutoFillDeps extends EngagementDeps {
  isPaused: () => Promise<boolean>;
  /** Wall clock for the time budget; separate from `now` so tests can control it. */
  monotonicMs?: () => number;
}

function emptyResult(summary: string, skipped: boolean): AutoFillResult {
  return { skipped, summary, seeded: 0, discovered: 0, drafted: 0, autoSkipped: 0, waiting: 0, quotaUsed: 0 };
}

async function markSeeded(client: SupabaseClient, now: Date, notes: string): Promise<void> {
  const iso = now.toISOString();
  const { error } = await client
    .from("integration_health")
    .upsert({ platform: AUTOFILL_SEED_MARKER, status: "healthy", last_checked_at: iso, last_success_at: iso, notes }, { onConflict: "platform" });
  if (error) throw new Error(`seed marker write failed: ${error.message}`);
}

/** Seeds the default queries once: only when the watchlist is empty AND it was never seeded before. */
export async function seedDefaultWatchlist(client: SupabaseClient, now: Date): Promise<number> {
  const { data: marker, error } = await client.from("integration_health").select("platform").eq("platform", AUTOFILL_SEED_MARKER).maybeSingle();
  if (error) throw new Error(`seed marker lookup failed: ${error.message}`);
  if (marker) return 0;
  if ((await repo.listWatchlist(client)).length > 0) {
    // The owner already curated a list; never override it, and remember not to seed later if they empty it.
    await markSeeded(client, now, "owner watchlist present");
    return 0;
  }
  for (const query of DEFAULT_WATCH_QUERIES) await repo.addWatchlistEntry(client, "query", query, "default", now);
  await markSeeded(client, now, `seeded ${DEFAULT_WATCH_QUERIES.length} default queries`);
  return DEFAULT_WATCH_QUERIES.length;
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

  const waitingBefore = (await repo.listQueue(client, 500)).length;
  const room = Math.min(AUTOFILL_TARGET_WAITING - waitingBefore, limits.maxPendingItems - waitingBefore);

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
        rotationSeed: Math.floor(now.getTime() / RUN_SLOT_MS),
      });
    } catch (err) {
      discoveryError = errorMessage(err);
    }
  }

  // Pre-draft every undrafted waiting item (oldest first), bounded per run and by the time budget.
  let drafted = 0;
  let autoSkipped = 0;
  let failures = 0;
  let stopNote: string | null = null;
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
    try {
      await draftItem(client, item.id, deps);
      drafted++;
    } catch (err) {
      if (err instanceof EngagementBlockedError) {
        if (err.block.code === "daily_cap") {
          stopNote = "daily cap reached";
          break;
        }
        continue; // creator on cooldown: leave it for later
      }
      if (err instanceof EngagementActionError) {
        // The drafter declined (off topic, nothing to add) or nothing passed the guardrails: not worth a card.
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
  const parts = [
    `discovered ${discovery?.added ?? 0}`,
    `drafted ${drafted}`,
    ...(autoSkipped > 0 ? [`auto-skipped ${autoSkipped}`] : []),
    `queue ${waiting}`,
    `quota ${quotaUsed - quotaBefore} units this run (${quotaUsed}/${limits.youtubeDailyQuotaBudget} today)`,
  ];
  const notes = [
    ...(seeded > 0 ? [`seeded ${seeded} default queries`] : []),
    ...(discovery?.stoppedReason ? [`discovery stopped: ${discovery.stoppedReason}`] : []),
    ...(discovery && discovery.errors.length > 0 ? [`${discovery.errors.length} source error(s)`] : []),
    ...(discoveryError ? [`discovery failed: ${discoveryError}`] : []),
    ...(stopNote ? [`drafting stopped: ${stopNote}`] : []),
  ];
  return {
    skipped: false,
    summary: parts.join(", ") + (notes.length > 0 ? ` (${notes.join("; ")})` : ""),
    seeded,
    discovered: discovery?.added ?? 0,
    drafted,
    autoSkipped,
    waiting,
    quotaUsed,
  };
}
