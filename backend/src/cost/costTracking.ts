import { startOfDay } from "../video/dailyLimit.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LlmUsage } from "../content/llmClient.js";

/**
 * USD per million tokens (input / output), Anthropic's standard (non-batch) API pricing, per the published price
 * list as of 2026-10-13. Cache reads bill at 0.1x the input rate and cache writes at 1.25x (applied in
 * estimateCostUsd). Re-verify against Anthropic's pricing page before trusting this beyond a running total.
 *
 * Corrected 2026-10-13: Haiku 4.5 was listed at the Haiku 3.5 rate ($0.80 / $4); its real rate is $1 / $5, so every
 * review-agent and relevance-check cost was under-recorded by 20 percent. The 5.x generation was missing entirely
 * (it fell through to the Sonnet 4.5 default).
 */
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
const DEFAULT_PRICING = { input: 3, output: 15 };

/** Looks a model id up by exact id, then with a trailing date suffix (-20250929) stripped. Null when unknown. */
export function pricingForModel(model: string): { input: number; output: number } | null {
  if (typeof model !== "string") return null;
  const exact = PRICING_PER_MILLION_TOKENS[model];
  if (exact) return exact;
  const stripped = model.replace(/-\d{8}$/, "");
  return PRICING_PER_MILLION_TOKENS[stripped] ?? null;
}

export function estimateCostUsd(usage: LlmUsage): number {
  const pricing = pricingForModel(usage.model) ?? DEFAULT_PRICING;
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  // Cache writes cost 1.25x the base input rate; cache reads cost 0.1x.
  const cacheWriteCost = ((usage.cacheCreationInputTokens ?? 0) / 1_000_000) * pricing.input * 1.25;
  const cacheReadCost = ((usage.cacheReadInputTokens ?? 0) / 1_000_000) * pricing.input * 0.1;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

/**
 * What goes into cost_events.context for one LLM call: the caller's own context plus the fields the cost views
 * group by. `step` is the job's name (e.g. "engagement-draft"); cached token counts are kept here because the table
 * has no columns for them (input_tokens excludes cached tokens, as the API reports them).
 */
export function contextWithUsage(context: Record<string, unknown>, usage: LlmUsage): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...context };
  if (usage.step && merged.step === undefined) merged.step = usage.step;
  if (usage.cacheCreationInputTokens) merged.cacheCreationInputTokens = usage.cacheCreationInputTokens;
  if (usage.cacheReadInputTokens) merged.cacheReadInputTokens = usage.cacheReadInputTokens;
  if (pricingForModel(usage.model) === null) merged.priceKnown = false;
  return merged;
}

/** PostgREST returns at most 1000 rows per request (Supabase default max-rows); every sum over cost_events pages through. */
export const COST_EVENTS_PAGE_SIZE = 1000;
/** Safety bound on one aggregation (a year of heavy use is far below this). */
const COST_EVENTS_MAX_ROWS = 100_000;

export interface CostEventRow {
  id?: string;
  event_type?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd: number | null;
  context?: Record<string, unknown> | null;
  created_at?: string;
}

export interface CostEventFilter {
  /** Inclusive lower bound on created_at (ISO). */
  since?: string;
  /** Exclusive upper bound on created_at (ISO). */
  until?: string;
  eventTypes?: string[];
  /** Prefix for a read error, so callers keep their own error text (e.g. "getTodaySpendUsd"). */
  label?: string;
}

/**
 * Reads cost_events in stable pages (ordered by created_at, id) until exhausted, so no total is silently capped at
 * 1000 rows. Before 2026-10-13 every spend sum used a single unpaged select and the cost summary reported only the
 * first 1000 rows ($11.82 of a real ~$26 month).
 */
export async function selectCostEvents(client: SupabaseClient, columns: string, filter: CostEventFilter = {}): Promise<CostEventRow[]> {
  const rows: CostEventRow[] = [];
  for (let from = 0; from < COST_EVENTS_MAX_ROWS; from += COST_EVENTS_PAGE_SIZE) {
    let query = client.from("cost_events").select(columns);
    if (filter.since) query = query.gte("created_at", filter.since);
    if (filter.until) query = query.lt("created_at", filter.until);
    if (filter.eventTypes && filter.eventTypes.length > 0) query = query.in("event_type", filter.eventTypes);
    const { data, error } = await query.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, from + COST_EVENTS_PAGE_SIZE - 1);
    if (error) throw new Error(`${filter.label ?? "cost_events read"} failed: ${error.message}`);
    const page = (data ?? []) as unknown as CostEventRow[];
    rows.push(...page);
    if (page.length < COST_EVENTS_PAGE_SIZE) break;
  }
  return rows;
}

/** selectCostEvents shaped like a single Supabase response ({ data, error }) for call sites inside a Promise.all of queries. */
export async function selectCostEventsResult(
  client: SupabaseClient,
  columns: string,
  filter: CostEventFilter = {},
): Promise<{ data: CostEventRow[] | null; error: Error | null }> {
  try {
    return { data: await selectCostEvents(client, columns, filter), error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export function sumCostUsd(rows: Array<{ cost_usd: number | null }>): number {
  return rows.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
}

/** The step a cost row belongs to: its recorded step, else the legacy endpoint tag, else its event type. */
export function stepOfCostRow(row: CostEventRow): string {
  const ctx = row.context ?? {};
  const step = typeof ctx.step === "string" ? ctx.step : typeof ctx.endpoint === "string" ? ctx.endpoint : null;
  return step ?? row.event_type ?? "unknown";
}

export interface CostBucket {
  key: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
}

function addTo(map: Map<string, CostBucket>, key: string, row: CostEventRow): void {
  const bucket = map.get(key) ?? { key, calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 };
  bucket.calls++;
  bucket.costUsd += Number(row.cost_usd ?? 0);
  bucket.inputTokens += Number(row.input_tokens ?? 0);
  bucket.outputTokens += Number(row.output_tokens ?? 0);
  const cached = row.context?.cacheReadInputTokens;
  bucket.cachedReadTokens += typeof cached === "number" ? cached : 0;
  map.set(key, bucket);
}

function sortedBuckets(map: Map<string, CostBucket>, order: "costDesc" | "keyDesc"): CostBucket[] {
  const out = [...map.values()].map((b) => ({ ...b, costUsd: Number(b.costUsd.toFixed(6)) }));
  return order === "costDesc" ? out.sort((a, b) => b.costUsd - a.costUsd) : out.sort((a, b) => (a.key < b.key ? 1 : -1));
}

export interface CostBreakdown {
  /** Rows scanned; all are counted (the old view silently stopped at 1000). */
  totalCalls: number;
  totalCostUsd: number;
  windowDays: number;
  /** Per job, over the window: which step costs what. */
  byStep: CostBucket[];
  /** Per UTC day, newest first, over the window. */
  byDay: CostBucket[];
  /** Per model, over the window. */
  byModel: CostBucket[];
  /** Per day and step, newest day first, so a spike day can be attributed. */
  byDayStep: Array<CostBucket & { day: string; step: string }>;
}

/** Groups cost rows over the last `windowDays` by step, day and model. Pure, so it is unit-tested directly. */
export function breakdownCostEvents(rows: CostEventRow[], now: Date, windowDays = 30): CostBreakdown {
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const byStep = new Map<string, CostBucket>();
  const byDay = new Map<string, CostBucket>();
  const byModel = new Map<string, CostBucket>();
  const byDayStep = new Map<string, CostBucket>();
  let totalCostUsd = 0;
  let totalCalls = 0;
  for (const row of rows) {
    const created = row.created_at ?? "";
    if (created < cutoff) continue;
    totalCalls++;
    totalCostUsd += Number(row.cost_usd ?? 0);
    const step = stepOfCostRow(row);
    const day = created.slice(0, 10);
    addTo(byStep, step, row);
    addTo(byDay, day, row);
    addTo(byModel, row.model ?? "unknown", row);
    addTo(byDayStep, `${day}|${step}`, row);
  }
  return {
    totalCalls,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    windowDays,
    byStep: sortedBuckets(byStep, "costDesc"),
    byDay: sortedBuckets(byDay, "keyDesc"),
    byModel: sortedBuckets(byModel, "costDesc"),
    byDayStep: sortedBuckets(byDayStep, "keyDesc").map((b) => {
      const [day, ...rest] = b.key.split("|");
      return { ...b, day: day ?? "", step: rest.join("|") };
    }),
  };
}

/**
 * Persists one real LLM call's cost. Never blocks or fails the caller's
 * actual work if this write fails -- cost visibility matters, but it
 * should never be the reason a real review agent call gets lost.
 *
 * [eventType] defaults to "llm_call" (every existing caller's exact
 * prior behavior -- auto-draft, prospecting's reply writer, Today's X
 * Post, video scripts). Partnerships passes "partnership_llm_call"
 * explicitly -- confirmed live in production that without this, every
 * partnership pitch-generation call was silently recorded under the
 * generic "llm_call" type, which getPartnershipMonthSpendUsd never
 * queries (it only looks for "partnership_llm_call"), so the $3/month
 * cap was never actually gating LLM generation cost, only the separate
 * X-search-read cost. A single shared event_type here would have the
 * opposite problem -- Partnerships' budget would then also count every
 * OTHER feature's LLM spend against its own $3 cap, and vice versa.
 */
/**
 * Returns whether the write actually succeeded (checking the insert's own
 * `error` result, not just catching a thrown exception -- a Supabase
 * insert normally FAILS by returning `{error}`, not by throwing, so the
 * previous version of this function -- try/catch with no error check --
 * could never actually detect a failed write). Partnerships' budget
 * reservation settlement (see budgetReservation.ts / migration 0025)
 * depends on this being accurate: a caller that can't tell "the cost was
 * recorded" from "the LLM call merely returned a usage block" would risk
 * reversing a conservative settled charge for an attempt whose real cost
 * was never actually durably recorded, silently losing track of it.
 */
export async function recordCostEvent(
  client: SupabaseClient,
  usage: LlmUsage,
  context: Record<string, unknown> = {},
  eventType: string = "llm_call",
): Promise<boolean> {
  try {
    const { error } = await client.from("cost_events").insert({
      event_type: eventType,
      provider: "anthropic",
      model: usage.model,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: estimateCostUsd(usage),
      context: contextWithUsage(context, usage),
    });
    return !error;
  } catch {
    // Deliberately swallowed -- see docstring above; cost visibility must
    // never block the actual work. Reported as a failed write, not thrown.
    return false;
  }
}

/** X's general read rate ($0.005/read) -- NOT the cheaper $0.001 Owned Reads tier, since a search result isn't the authenticated user's own resource. See docs/PROGRESS_LEDGER.md Phase 4. */
export const X_SEARCH_COST_PER_READ_USD = 0.005;

/**
 * Persists one X search API call's cost -- resultsReturned reads billed at
 * the general (non-Owned-Reads) rate. Same silent-failure contract as
 * recordCostEvent above: cost visibility must never block the actual
 * search/ingestion work.
 */
export async function recordXSearchCostEvent(
  client: SupabaseClient,
  resultsReturned: number,
  context: Record<string, unknown> = {},
): Promise<number> {
  const costUsd = resultsReturned * X_SEARCH_COST_PER_READ_USD;
  try {
    await client.from("cost_events").insert({
      event_type: "x_search_read",
      provider: "x",
      model: "search/recent",
      input_tokens: 0,
      output_tokens: resultsReturned,
      cost_usd: costUsd,
      context,
    });
  } catch {
    // Deliberately swallowed -- see recordCostEvent's docstring above.
  }
  return costUsd;
}

/** X Owned Reads rate: tweets the authenticated account itself posted (results tracking). */
export const X_OWNED_READ_COST_USD = 0.001;

/** Persists one read of the account's own tweets, at the Owned Reads rate. Same silent-failure contract as recordCostEvent. */
export async function recordXOwnedReadCostEvent(client: SupabaseClient, resultsReturned: number, context: Record<string, unknown> = {}): Promise<number> {
  const costUsd = resultsReturned * X_OWNED_READ_COST_USD;
  try {
    await client.from("cost_events").insert({
      event_type: "x_owned_read",
      provider: "x",
      model: "users/tweets",
      input_tokens: 0,
      output_tokens: resultsReturned,
      cost_usd: costUsd,
      context,
    });
  } catch {
    // Deliberately swallowed -- see recordCostEvent's docstring above.
  }
  return costUsd;
}

/**
 * Same $0.005/read rate as recordXSearchCostEvent, but its OWN event_type
 * -- Partnerships discovery must never inflate Prospecting's separate
 * getProspectingMonthSpendUsd budget gate (it sums ALL "x_search_read"
 * rows regardless of caller), and Partnerships' own
 * getPartnershipMonthSpendUsd needs to see this spend alongside its LLM
 * pitch-generation cost to enforce ONE shared $3/month cap across
 * discovery + ranking + drafting, per docs/PARTNERSHIPS_MISSION.md
 * Phase 7 ("account for research/provider costs and model
 * generation/review costs ... together").
 */
/**
 * Returns both the (always-computed) cost and whether it was actually
 * durably recorded -- see recordCostEvent's docstring on why checking the
 * insert's own `error` result matters. Partnerships' discovery budget
 * reservation (see discovery.ts / migration 0025) needs to know real
 * recorded status, not just the theoretical cost, before it can safely
 * reverse a conservative settled charge.
 */
export async function recordPartnershipXSearchCostEvent(
  client: SupabaseClient,
  resultsReturned: number,
  context: Record<string, unknown> = {},
): Promise<{ costUsd: number; recorded: boolean }> {
  const costUsd = resultsReturned * X_SEARCH_COST_PER_READ_USD;
  try {
    const { error } = await client.from("cost_events").insert({
      event_type: "partnership_x_search_read",
      provider: "x",
      model: "search/recent",
      input_tokens: 0,
      output_tokens: resultsReturned,
      cost_usd: costUsd,
      context,
    });
    return { costUsd, recorded: !error };
  } catch {
    // Deliberately swallowed -- see recordCostEvent's docstring above.
    return { costUsd, recorded: false };
  }
}

/**
 * Real recorded spend for the given month across BOTH of Prospecting's own
 * cost sources -- its X search reads ("x_search_read") and its reply-writer
 * LLM calls ("prospecting_llm_call", see draftProspectingCandidateReply).
 *
 * Previously this only summed "x_search_read", so the reply-writer's LLM
 * cost was recorded under the generic "llm_call" event_type (shared with
 * auto-draft/inbound/x-feed-post/run-campaign) and never counted against
 * MONTHLY_PROSPECTING_BUDGET_USD at all -- the same bug class Partnerships
 * had (see recordCostEvent's own docstring). Confirmed via
 * cost_events.context->>'endpoint' = 'prospecting-draft': 39 historical rows
 * ($0.3333) were cleanly attributable and reclassified to
 * "prospecting_llm_call"; every other "llm_call" row had its own
 * unambiguous endpoint (run-campaign/x-feed-post/inbound-draft/
 * opportunity-reply-draft) and was left untouched.
 */
export async function getProspectingMonthSpendUsd(client: SupabaseClient, now: Date = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const rows = await selectCostEvents(client, "cost_usd", { since: monthStart, until: nextMonthStart, eventTypes: ["x_search_read", "prospecting_llm_call"], label: "getProspectingMonthSpendUsd" });
  return sumCostUsd(rows);
}

/**
 * X search requests recorded today (Arizona day, the same day the one-a-day video limit uses). One cost_events row is written per
 * search request (recordXSearchCostEvent), so the row count is the request count. Feeds Prospecting's daily search limit
 * (2026-10-24), so a run of "Search now" taps or refills can never spend more than about DAILY_SEARCH_CAP requests a day.
 */
export async function getTodayXSearchCount(client: SupabaseClient, now: Date = new Date()): Promise<number> {
  const rows = await selectCostEvents(client, "id", { since: startOfDay(now).toISOString(), eventTypes: ["x_search_read"], label: "getTodayXSearchCount" });
  return rows.length;
}

/** X search spend recorded today (Arizona day). Feeds Prospecting's daily search budget (2026-10-25). */
export async function getTodayXSearchSpendUsd(client: SupabaseClient, now: Date = new Date()): Promise<number> {
  const rows = await selectCostEvents(client, "cost_usd", { since: startOfDay(now).toISOString(), eventTypes: ["x_search_read"], label: "getTodayXSearchSpendUsd" });
  return sumCostUsd(rows);
}

/** Real recorded spend today (any provider/event_type), created_at-based, UTC calendar day. Distinct from getProspectingMonthSpendUsd (that one is a budget gate scoped to one event_type over a month) -- this is what a "today's spend" display should actually query instead of an unfiltered lifetime sum. */
export async function getTodaySpendUsd(client: SupabaseClient, now: Date = new Date()): Promise<number> {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  return sumCostUsd(await selectCostEvents(client, "cost_usd", { since: startOfToday, label: "getTodaySpendUsd" }));
}

/**
 * cost_events has no retention policy and grows forever -- one row per LLM
 * call and per X search read, indefinitely. Deletes rows older than
 * RETENTION_DAYS so a free-tier (500MB) Supabase project doesn't slowly
 * fill up with cost-ledger history nobody needs after the fact: the real
 * budget gates (getProspectingMonthSpendUsd, autoDraftRunRepository's
 * getMonthSpendUsd) only ever look at the current calendar month, and the
 * "Today's spend" tile only looks at today, so nothing operational reads
 * data this old. Called once/day from daily-pipeline.ts -- deliberately
 * NOT from the 3x/day growth-pulse, since running a delete sweep 3x
 * as often buys nothing.
 */
const RETENTION_DAYS = 180;

export async function pruneOldCostEvents(client: SupabaseClient, now: Date = new Date()): Promise<string> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error, count } = await client.from("cost_events").delete({ count: "exact" }).lt("created_at", cutoff);
  if (error) throw new Error(`pruneOldCostEvents failed: ${error.message}`);
  return `deleted ${count ?? 0} cost_events rows older than ${RETENTION_DAYS}d`;
}
