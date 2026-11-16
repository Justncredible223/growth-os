import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Scheduled-step failures that Health can show (Home P1 2026-11-15, ChatGPT). Until now a failed pulse or pipeline step only reached the
 * cron response and, for the daily pipeline, a notification; Health never saw it. Failures are written to audit_logs (outcome "rejected",
 * the table's only failure-shaped outcome) and read back for the last 24 hours. Best effort: recording never breaks a run.
 */
export const STEP_FAILURE_ACTION = "cron_step_failed";
export const STEP_FAILURE_WINDOW_HOURS = 24;

export async function recordStepFailures(client: SupabaseClient, job: string, results: Array<{ step: string; ok: boolean; detail: string }>): Promise<void> {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return;
  try {
    await client.from("audit_logs").insert(
      failed.map((r) => ({
        action_name: STEP_FAILURE_ACTION,
        action_class: "INTERNAL_WRITE",
        outcome: "rejected",
        reason: r.detail.slice(0, 300),
        agent: job,
        context: { job, step: r.step },
      })),
    );
  } catch {
    // never block the run
  }
}

export interface StepFailureSummary {
  step: string;
  job: string;
  count: number;
  lastAt: string;
  lastDetail: string;
}

/** Failures in the window, newest first, one entry per step. */
export function summarizeStepFailures(rows: Array<{ created_at: string; reason: string | null; context: { job?: string; step?: string } | null }>): StepFailureSummary[] {
  const byStep = new Map<string, StepFailureSummary>();
  for (const r of [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const step = r.context?.step;
    if (!step) continue;
    const existing = byStep.get(step);
    if (existing) existing.count++;
    else byStep.set(step, { step, job: r.context?.job ?? "cron", count: 1, lastAt: r.created_at, lastDetail: r.reason ?? "" });
  }
  return [...byStep.values()];
}

export async function loadStepFailures(client: SupabaseClient, now: Date = new Date()): Promise<StepFailureSummary[]> {
  const since = new Date(now.getTime() - STEP_FAILURE_WINDOW_HOURS * 3_600_000).toISOString();
  const { data, error } = await client.from("audit_logs").select("created_at, reason, context").eq("action_name", STEP_FAILURE_ACTION).gte("created_at", since).limit(200);
  if (error) throw new Error(`step failure lookup failed: ${error.message}`);
  return summarizeStepFailures((data ?? []) as Array<{ created_at: string; reason: string | null; context: { job?: string; step?: string } | null }>);
}
