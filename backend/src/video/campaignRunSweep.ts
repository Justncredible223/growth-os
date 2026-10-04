import type { getServiceClient } from "../lib/supabaseClient.js";

type Client = ReturnType<typeof getServiceClient>;

/**
 * A draft run (campaign_run_requests) is worked by a GitHub Actions job that is stopped after 15 minutes (campaign-run.yml), so a
 * request still queued or running well past that is dead: the dispatch never started (a bad token, a lost webhook) or the job
 * was killed. Left alone it blocks everything behind it: a queued or running request counts as "waiting" for its concept, holds
 * the day's one request (src/video/dailyLimit.ts), and the one-active-per-opportunity index refuses a new one.
 *
 * So after this long with no update the request is marked failed with a plain reason. That frees the concept and the day to try
 * again. Nothing else is touched: a late-finishing job still records its own result, and the draft it produced (if any) is not
 * deleted.
 */
export const STUCK_CAMPAIGN_RUN_MINUTES = 25;

export function stuckRunCutoff(now: Date, minutes: number = STUCK_CAMPAIGN_RUN_MINUTES): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

export const STUCK_RUN_ERROR = `Timed out: the draft run did not finish within ${STUCK_CAMPAIGN_RUN_MINUTES} minutes. Request it again.`;

/** Marks stuck draft runs failed and returns a one-line report for the pulse step. */
export async function expireStuckCampaignRuns(client: Client, now: Date = new Date()): Promise<string> {
  const { data, error } = await client
    .from("campaign_run_requests")
    .select("id")
    .in("status", ["queued", "running"])
    .lt("updated_at", stuckRunCutoff(now));
  if (error) throw new Error(`stuck campaign run lookup failed: ${error.message}`);
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return "no stuck draft runs";

  // Re-check the status in the update itself, so a run that finished a moment ago is not overwritten.
  const { error: updateError } = await client
    .from("campaign_run_requests")
    .update({ status: "failed", error: STUCK_RUN_ERROR, updated_at: now.toISOString() })
    .in("id", ids)
    .in("status", ["queued", "running"]);
  if (updateError) throw new Error(`could not expire stuck campaign runs: ${updateError.message}`);
  return `expired ${ids.length} stuck draft run${ids.length === 1 ? "" : "s"} (no update for ${STUCK_CAMPAIGN_RUN_MINUTES}+ minutes)`;
}
