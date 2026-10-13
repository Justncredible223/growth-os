import type { SupabaseClient } from "@supabase/supabase-js";
import { LlmBudgetError, type LlmBudgetGuard, type LlmUsage } from "../content/llmClient.js";
import { estimateCostUsd, selectCostEvents } from "./costTracking.js";

/**
 * Hard DAILY ceiling on Anthropic spend (UTC day, the same day the Anthropic console bills by). Added 2026-10-13
 * after a 30-day bill of about $26 with spike days of $1.75 to $2.75.
 *
 * Three kinds of caller, three limits:
 *  - "background": scheduled and automatic work (Engage autofill, auto-draft, Prospecting/Inbound pulses, partnerships).
 *    Stops at DAILY_LLM_BUDGET_USD of everything spent today EXCLUDING the live host, so a long stream cannot starve
 *    the daily pipeline and the pipeline cannot starve a stream.
 *  - "owner": an action the owner just tapped (draft this reply, request this video, regenerate today's post).
 *    Exempt from the background ceiling; only the absolute backstop below applies.
 *  - "live": the live host. It keeps its own per-stream budget (live_host_settings.daily_budget_usd, default $3) and
 *    is exempt from the background ceiling; only the absolute backstop applies.
 *
 * ABSOLUTE_DAILY_LLM_CEILING_USD is the last line: when ALL spend today reaches it, every caller skips, owner
 * actions included. Both values are env-tunable without a deploy (LLM_DAILY_BUDGET_USD, LLM_DAILY_HARD_CEILING_USD);
 * a non-numeric or non-positive value falls back to the default.
 *
 * A skip is never an exception into a pipeline: callers receive LlmBudgetError (message "skipped -- daily LLM budget
 * reached") before any network call and report a skip line. If today's spend cannot be read the guard FAILS OPEN:
 * a measurement problem must not stop real work (the per-feature caps still apply).
 */
export const DAILY_LLM_BUDGET_USD = 1.5;
export const ABSOLUTE_DAILY_LLM_CEILING_USD = 5;

export type LlmCallerTier = "background" | "owner" | "live";

export const BUDGET_SKIP_MESSAGE = "skipped -- daily LLM budget reached";

/** Event types that hold Anthropic spend (the X read events are not model calls). */
const LLM_EVENT_TYPES = ["llm_call", "partnership_llm_call", "prospecting_llm_call"];
export const LIVE_HOST_COST_ENDPOINT_TAG = "live-host-line";

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function dailyBudgetUsd(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env.LLM_DAILY_BUDGET_USD, DAILY_LLM_BUDGET_USD);
}
export function absoluteCeilingUsd(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env.LLM_DAILY_HARD_CEILING_USD, ABSOLUTE_DAILY_LLM_CEILING_USD);
}

export interface TodaySpend {
  totalUsd: number;
  liveHostUsd: number;
}

/** True when a call at this tier must be skipped given today's spend. Pure. */
export function budgetExceeded(tier: LlmCallerTier, spend: TodaySpend, env: NodeJS.ProcessEnv = process.env): boolean {
  if (spend.totalUsd >= absoluteCeilingUsd(env)) return true;
  if (tier === "background") return spend.totalUsd - spend.liveHostUsd >= dailyBudgetUsd(env);
  return false;
}

function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** Today's model spend from cost_events, paged (never capped at 1000 rows). */
export async function loadTodayLlmSpend(client: SupabaseClient, now: Date = new Date()): Promise<TodaySpend> {
  const rows = await selectCostEvents(client, "cost_usd, context", { since: utcDayStart(now), eventTypes: LLM_EVENT_TYPES });
  let totalUsd = 0;
  let liveHostUsd = 0;
  for (const row of rows) {
    const cost = Number(row.cost_usd ?? 0);
    totalUsd += cost;
    if (row.context?.endpoint === LIVE_HOST_COST_ENDPOINT_TAG) liveHostUsd += cost;
  }
  return { totalUsd, liveHostUsd };
}

/** How long a read of today's spend is trusted within one process, so a burst of calls is one query, not N. */
const SPEND_TTL_MS = 15_000;

/**
 * One guard per client. It reads today's spend lazily on the first call, then adds each call's own estimated cost
 * locally (note), re-reading from the database after SPEND_TTL_MS so other invocations' spend is seen.
 */
export class DailyBudgetGuard implements LlmBudgetGuard {
  private spend: TodaySpend | null = null;
  private loadedAt = 0;

  constructor(
    private readonly loadSpend: () => Promise<TodaySpend>,
    private readonly tier: LlmCallerTier,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Today's spend (cached for SPEND_TTL_MS); null when it has never been readable. */
  private async current(): Promise<TodaySpend | null> {
    const nowMs = this.clock();
    if (this.spend && nowMs - this.loadedAt < SPEND_TTL_MS) return this.spend;
    try {
      this.spend = await this.loadSpend();
      this.loadedAt = nowMs;
    } catch {
      // Fail open: keep whatever we last knew (possibly nothing).
    }
    return this.spend;
  }

  /** True when a call would be skipped right now. */
  async isExhausted(): Promise<boolean> {
    const spend = await this.current();
    return spend !== null && budgetExceeded(this.tier, spend, this.env);
  }

  async check(): Promise<void> {
    if (await this.isExhausted()) throw new LlmBudgetError(BUDGET_SKIP_MESSAGE);
  }

  /** Adds a finished call's cost so the next check in this process sees it before the next re-read. */
  note(usage: LlmUsage, isLiveHost: boolean): void {
    if (!this.spend) return;
    const cost = estimateCostUsd(usage);
    this.spend = { totalUsd: this.spend.totalUsd + cost, liveHostUsd: this.spend.liveHostUsd + (isLiveHost ? cost : 0) };
  }
}
