import type { SupabaseClient } from "@supabase/supabase-js";
import { selectCostEvents } from "../cost/costTracking.js";
import { PROSPECTING_TOPICS } from "./prospectingTopics.js";

/**
 * Search yield per topic (P2, ChatGPT 2026-11-15). Every X search request already records what it read and kept on its cost event
 * (context.topics / context.watchlist, context.read, context.funnel.inserted), so this reads those rows; there is no new table.
 *
 * A topic request covers up to four topics at once, so a request's read and kept counts are credited to every topic in it. That is an
 * approximation: a group that kept one post credits all four of its topics. It is conservative for pausing (a topic is only paused when
 * every request it was part of kept nothing).
 *
 * Pausing: a topic whose last 5 requests all kept 0 posts, spread over at least 3 different days, is paused for 7 days from its latest
 * request. When the 7 days pass it is searched again; if it still keeps nothing it is paused again. The creator watchlist is never paused.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const PAUSE_AFTER_EMPTY_RUNS = 5;
export const PAUSE_MIN_DISTINCT_DAYS = 3;
export const PAUSE_DAYS = 7;
export const YIELD_WINDOW_DAYS = 7;
/** How far back pausing looks: long enough to hold 5 requests spread over several days. */
export const PAUSE_LOOKBACK_DAYS = 21;

export interface YieldEvent {
  at: string;
  /** Topic keys this request covered; empty for a watchlist request. */
  topics: string[];
  watchlist: boolean;
  read: number;
  kept: number;
}

export interface TopicPause {
  key: string;
  until: string;
  reason: string;
}

/** Turns cost_events rows (x_search_read) into yield events; rows without the funnel context are skipped. */
export function yieldEventsFromRows(rows: Array<{ created_at?: string | null; context?: unknown }>): YieldEvent[] {
  const out: YieldEvent[] = [];
  for (const row of rows) {
    const ctx = (row.context ?? {}) as { topics?: unknown; watchlist?: unknown; read?: unknown; funnel?: { inserted?: unknown } };
    if (!row.created_at || !ctx.funnel) continue;
    out.push({
      at: row.created_at,
      topics: Array.isArray(ctx.topics) ? ctx.topics.filter((t): t is string => typeof t === "string") : [],
      watchlist: ctx.watchlist === true,
      read: typeof ctx.read === "number" ? ctx.read : 0,
      kept: typeof ctx.funnel.inserted === "number" ? ctx.funnel.inserted : 0,
    });
  }
  return out;
}

/** Topics to leave out of searches right now, with when they come back and why. */
export function pausedTopics(events: YieldEvent[], now: Date): Map<string, TopicPause> {
  const byTopic = new Map<string, YieldEvent[]>();
  for (const e of events) for (const key of e.topics) byTopic.set(key, [...(byTopic.get(key) ?? []), e]);
  const paused = new Map<string, TopicPause>();
  for (const [key, list] of byTopic) {
    const last = [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, PAUSE_AFTER_EMPTY_RUNS);
    if (last.length < PAUSE_AFTER_EMPTY_RUNS || last.some((e) => e.kept > 0)) continue;
    const days = new Set(last.map((e) => e.at.slice(0, 10)));
    if (days.size < PAUSE_MIN_DISTINCT_DAYS) continue;
    const untilMs = Date.parse(last[0]!.at) + PAUSE_DAYS * DAY_MS;
    if (untilMs <= now.getTime()) continue;
    paused.set(key, {
      key,
      until: new Date(untilMs).toISOString(),
      reason: `Kept 0 posts in its last ${PAUSE_AFTER_EMPTY_RUNS} searches over ${days.size} days`,
    });
  }
  return paused;
}

export interface QueryYieldRow {
  key: string;
  label: string;
  runs: number;
  read: number;
  kept: number;
  /** kept / read as a whole percentage, or null when nothing was read. */
  keptPct: number | null;
  pausedUntil: string | null;
  pauseReason: string | null;
}

/** Last-7-days yield per topic plus one row for the creator watchlist, best first; paused topics are included so the pause is visible. */
export function queryYieldSummary(events: YieldEvent[], now: Date): QueryYieldRow[] {
  const since = now.getTime() - YIELD_WINDOW_DAYS * DAY_MS;
  const recent = events.filter((e) => Date.parse(e.at) >= since);
  const pauses = pausedTopics(events, now);
  const labels = new Map(PROSPECTING_TOPICS.map((t) => [t.key, t.label]));
  const rows = new Map<string, QueryYieldRow>();
  const add = (key: string, label: string, e: YieldEvent) => {
    const r = rows.get(key) ?? { key, label, runs: 0, read: 0, kept: 0, keptPct: null, pausedUntil: null, pauseReason: null };
    r.runs++;
    r.read += e.read;
    r.kept += e.kept;
    rows.set(key, r);
  };
  for (const e of recent) {
    if (e.watchlist) add("watchlist", "Creator watchlist", e);
    for (const key of e.topics) add(key, labels.get(key) ?? key, e);
  }
  for (const p of pauses.values()) {
    if (!rows.has(p.key)) rows.set(p.key, { key: p.key, label: labels.get(p.key) ?? p.key, runs: 0, read: 0, kept: 0, keptPct: null, pausedUntil: null, pauseReason: null });
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      keptPct: r.read > 0 ? Math.round((r.kept / r.read) * 100) : null,
      pausedUntil: pauses.get(r.key)?.until ?? null,
      pauseReason: pauses.get(r.key)?.reason ?? null,
    }))
    .sort((a, b) => b.kept - a.kept || b.read - a.read || a.label.localeCompare(b.label));
}

/** Reads the search requests of the last `days` days. */
export async function loadYieldEvents(client: SupabaseClient, now: Date, days: number): Promise<YieldEvent[]> {
  const rows = await selectCostEvents(client, "created_at, context", { since: new Date(now.getTime() - days * DAY_MS).toISOString(), eventTypes: ["x_search_read"], label: "loadYieldEvents" });
  return yieldEventsFromRows(rows as Array<{ created_at?: string | null; context?: unknown }>);
}
