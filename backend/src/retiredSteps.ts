/**
 * Scheduled steps that were switched OFF on purpose (owner decision 2026-10-10: the Radar, Campaigns, Research Lab,
 * Creators and Strategy screens were removed from the app in PR #167, so the scheduled work that only fed those screens
 * was turned off to cut running costs).
 *
 * A retired step is still called by its pipeline, still appears in the pipeline/pulse output, and returns an ordinary
 * `ok: true` result whose detail says it is intentionally off -- but it returns BEFORE any paid call, database read or
 * setup. Nothing is deleted: the step code, its tables and its tests all stay, so turning a step back on is ONE edit:
 * delete its entry from RETIRED_STEPS below.
 *
 * Each step checks `retiredStepSkip("<step name>")` as the very first line of its body.
 */
export interface RetiredStep {
  /** Date the owner retired the step. */
  retiredOn: string;
  /** Why it is off, in a few words. Shown in the step output. */
  reason: string;
}

const REASON_RADAR = "Radar/Strategy screens removed";

export const RETIRED_STEPS: Readonly<Record<string, RetiredStep>> = {
  // api/daily-pipeline.ts (group=core)
  generate_opportunities: { retiredOn: "2026-10-10", reason: REASON_RADAR },
  auto_draft: { retiredOn: "2026-10-10", reason: REASON_RADAR },
  strategy_evolution: { retiredOn: "2026-10-10", reason: REASON_RADAR },
  // api/growth-pulse.ts. Only the Radar-signal ingestion; x_inbound keeps its own cursor and its own mentions read.
  x_mentions: { retiredOn: "2026-10-10", reason: REASON_RADAR },
};

export function isStepRetired(step: string, table: Readonly<Record<string, RetiredStep>> = RETIRED_STEPS): boolean {
  return Object.prototype.hasOwnProperty.call(table, step);
}

/**
 * The step-result detail to return for a retired step, or null when the step is live. The text also names the one-line
 * way to turn the step back on so the pipeline output is self-explanatory.
 */
export function retiredStepSkip(step: string, table: Readonly<Record<string, RetiredStep>> = RETIRED_STEPS): string | null {
  if (!isStepRetired(step, table)) return null;
  const entry = table[step]!;
  return `skipped -- retired ${entry.retiredOn} (${entry.reason}); re-enable by deleting "${step}" from src/retiredSteps.ts`;
}
