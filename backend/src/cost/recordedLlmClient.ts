import type { SupabaseClient } from "@supabase/supabase-js";
import { createLlmClient, type LlmClient, type LlmUsage } from "../content/llmClient.js";
import { recordCostEvent } from "./costTracking.js";
import { DailyBudgetGuard, loadTodayLlmSpend, type LlmCallerTier } from "./llmBudget.js";

export interface RecordedClientOptions {
  /** The job's name. Recorded on every cost row (context.step and context.endpoint) and shown in the cost summary. */
  step: string;
  /**
   * Who is asking: "background" (scheduled/automatic, subject to the daily ceiling) or "owner" (an action the owner
   * just took). See llmBudget.ts for exactly what each is exempt from.
   */
  tier?: LlmCallerTier;
  /** Extra context stored on each cost row (opportunityId, engagementItemId, ...). */
  context?: Record<string, unknown>;
  /** cost_events.event_type; defaults to "llm_call". Partnerships and Prospecting have their own budget types. */
  eventType?: string;
  env?: NodeJS.ProcessEnv;
  /** Called with each call's usage after it is recorded (per-run totals, step summaries). */
  onUsage?: (usage: LlmUsage) => void;
  /** Called after the cost row's insert settles, with whether it was durably written (Partnerships' budget settlement needs this). */
  onCostRecorded?: (recorded: boolean, usage: LlmUsage) => void;
}

/**
 * THE way Growth OS makes a model call. One recorder for every call site: it checks the daily budget before the
 * call, and after it writes a cost_events row (step, model, input/output tokens, cached tokens) that is AWAITED
 * inside the call, so no row is lost to a frozen serverless invocation and no call site can forget to record.
 * Throws LlmBudgetError (a clean skip) from callTool when the day's ceiling is reached.
 */
export function createRecordedLlmClient(client: SupabaseClient, options: RecordedClientOptions): LlmClient {
  const env = options.env ?? process.env;
  const tier = options.tier ?? "background";
  const guard = new DailyBudgetGuard(() => loadTodayLlmSpend(client), tier, env);
  return createLlmClient(
    env,
    async (usage) => {
      guard.note(usage);
      options.onUsage?.(usage);
      const recorded = await recordCostEvent(client, usage, { ...(options.context ?? {}), endpoint: options.step, step: options.step }, options.eventType ?? "llm_call");
      options.onCostRecorded?.(recorded, usage);
    },
    { step: options.step, guard },
  );
}
