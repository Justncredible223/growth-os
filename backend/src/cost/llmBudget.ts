import type { SupabaseClient } from "@supabase/supabase-js";
import { LlmBudgetError, type LlmBudgetGuard, type LlmUsage } from "../content/llmClient.js";
import { estimateCostUsd, selectCostEvents } from "./costTracking.js";

/**
 * Hard DAILY ceiling on Anthropic spend (UTC day, the same day the Anthropic console bills by). Added 2026-10-13
 * after a 30-day bill of about $26 with spike days of $1.75 to $2.75.
 *
 * Two kinds of caller, two limits:
 *  - "background": scheduled and automatic work (Engage autofill, auto-draft, Prospecting/Inbound pulses, partnerships).
 *    Stops at DAILY_LLM_BUDGET_USD of everything spent today.
 *  - "owner": an action the owner just tapped (draft this reply, request this video, regenerate today's post).
 *    Exempt from the background ceiling; only the absolute backstop below applies.
 *
 * ABSOLUTE_DAILY_LLM_CEILING_USD is the last line: when ALL spend today reaches it, every caller skips, owner
 * actions included. Both values are env-tunable without a deploy (LLM_DAILY_BUDGET_USD, LLM_DAILY_HARD_CEILING_USD);
 * a non-numeric or non-positive value falls back to the default.
 *
 * A skip is never an exception into a pipeline: callers receive LlmBudgetError (message "skipped -- daily LLM budget
 * reached") before any network call and report a skip line. If today's spend cannot be read the guard FAILS OPEN:
 * a measurement problem must not stop real work (the per-feature caps still apply).
 */
export const DAILY_LLM_BUDGET_USD = 4;
export const ABSOLUTE_DAILY_LLM_CEILING_USD = 8;

/**
 * Monthly hard cap on Growth OS's Anthropic spend (team decision 2026-11-08: ChatGPT $40, Gemini $45, HQ $40, owner delegated; owner goal:
 * the whole Anthropic account stays inside the $100/month Max credit, HQ having its own $50 cap). Calendar month, UTC (the day the Anthropic
 * console bills by). Two lines:
 *  - at 80% of the cap (MONTHLY_BACKGROUND_PAUSE_SHARE) background work pauses (Prospecting drafts, auto-draft, Engage autofill, partnerships);
 *    the daily X post and anything the owner just tapped keep running;
 *  - at 100% every caller skips, owner actions included (the daily ceilings above still apply as well).
 * Tunable without a deploy: LLM_MONTHLY_HARD_CAP_USD. If the month's spend cannot be read the guard fails open, like the daily one.
 */
export const MONTHLY_LLM_HARD_CAP_USD = 40;
export const MONTHLY_BACKGROUND_PAUSE_SHARE = 0.8;

export type LlmCallerTier = "background" | "owner";

export const BUDGET_SKIP_MESSAGE = "skipped -- daily LLM budget reached";
export const MONTHLY_BUDGET_SKIP_MESSAGE = "skipped -- monthly LLM budget reached";

/** Event types that hold Anthropic spend (the X read events are not model calls). */
const LLM_EVENT_TYPES = ["llm_call", "partnership_llm_call", "prospecting_llm_call"];

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

export function monthlyCapUsd(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env.LLM_MONTHLY_HARD_CAP_USD, MONTHLY_LLM_HARD_CAP_USD);
}

export type MonthlyBudgetState = "ok" | "background_paused" | "hard_stop";

/** Where this month's spend stands against the monthly cap. Pure. */
export function monthlyBudgetState(monthUsd: number, env: NodeJS.ProcessEnv = process.env): MonthlyBudgetState {
  const cap = monthlyCapUsd(env);
  if (monthUsd >= cap) return "hard_stop";
  if (monthUsd >= cap * MONTHLY_BACKGROUND_PAUSE_SHARE) return "background_paused";
  return "ok";
}

export interface TodaySpend {
  totalUsd: number;
  /** This calendar month's model spend (UTC). Absent when it could not be read: the monthly line is then skipped (fail open). */
  monthUsd?: number;
}

/** Why a call at this tier must be skipped given today's and this month's spend, or null. Pure. */
export function budgetSkipReason(tier: LlmCallerTier, spend: TodaySpend, env: NodeJS.ProcessEnv = process.env): "daily" | "monthly" | null {
  if (spend.monthUsd !== undefined) {
    const state = monthlyBudgetState(spend.monthUsd, env);
    if (state === "hard_stop") return "monthly";
    if (state === "background_paused" && tier === "background") return "monthly";
  }
  if (spend.totalUsd >= absoluteCeilingUsd(env)) return "daily";
  if (tier === "background" && spend.totalUsd >= dailyBudgetUsd(env)) return "daily";
  return null;
}

/** True when a call at this tier must be skipped given today's and this month's spend. Pure. */
export function budgetExceeded(tier: LlmCallerTier, spend: TodaySpend, env: NodeJS.ProcessEnv = process.env): boolean {
  return budgetSkipReason(tier, spend, env) !== null;
}

function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function utcMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Today's and this month's model spend from cost_events (one paged read from the start of the month; never capped at 1000 rows). */
export async function loadTodayLlmSpend(client: SupabaseClient, now: Date = new Date()): Promise<TodaySpend> {
  const dayStart = utcDayStart(now);
  const rows = await selectCostEvents(client, "cost_usd, created_at", { since: utcMonthStart(now), eventTypes: LLM_EVENT_TYPES });
  let totalUsd = 0;
  let monthUsd = 0;
  for (const row of rows) {
    const cost = Number(row.cost_usd ?? 0);
    monthUsd += cost;
    // A row with no timestamp is counted as today (the stricter reading).
    if (!row.created_at || row.created_at >= dayStart) totalUsd += cost;
  }
  return { totalUsd, monthUsd };
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
  private loggedMonthly = false;

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
    const spend = await this.current();
    const reason = spend ? budgetSkipReason(this.tier, spend, this.env) : null;
    if (!reason) return;
    if (reason === "monthly" && !this.loggedMonthly) {
      this.loggedMonthly = true;
      // One line per process so the Vercel runtime logs show when the monthly line was hit (and at which state).
      console.warn("[llm-budget] monthly Anthropic cap: " + monthlyBudgetState(spend?.monthUsd ?? 0, this.env) + " (month $" + (spend?.monthUsd ?? 0).toFixed(2) + " of $" + monthlyCapUsd(this.env).toFixed(2) + "), tier " + this.tier + ": call skipped");
    }
    throw new LlmBudgetError(reason === "monthly" ? MONTHLY_BUDGET_SKIP_MESSAGE : BUDGET_SKIP_MESSAGE);
  }

  /** Adds a finished call's cost so the next check in this process sees it before the next re-read. */
  note(usage: LlmUsage): void {
    if (!this.spend) return;
    const cost = estimateCostUsd(usage);
    this.spend = { totalUsd: this.spend.totalUsd + cost, ...(this.spend.monthUsd !== undefined ? { monthUsd: this.spend.monthUsd + cost } : {}) };
  }
}
