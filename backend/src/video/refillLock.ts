import type { getServiceClient } from "../lib/supabaseClient.js";

type Client = ReturnType<typeof getServiceClient>;

/**
 * Lets only one chart-card refill decide and request at a time, so two overlapping pulses cannot both see the day's
 * request free. The lock is a row in system_jobs: its idempotency_key is unique, so only one insert can win. It is stored
 * as already 'succeeded', so no job worker or dispatcher ever picks it up (they claim 'pending' rows only). It is deleted
 * as soon as the refill step ends; one left behind by a killed function is cleared after LOCK_STALE_MINUTES.
 */
export const REFILL_LOCK_KEY = "lock:chart_card_requests";
export const REFILL_LOCK_JOB_TYPE = "chart_card_refill_lock";
/** The pulse function is stopped after 60 seconds (backend/vercel.json), so a lock this old has no owner. */
export const LOCK_STALE_MINUTES = 10;

const UNIQUE_VIOLATION = "23505";

/** Runs `work` while holding the lock. Returns null, without running it, when another run holds the lock. */
export async function withRefillLock<T>(client: Client, work: () => Promise<T>, now: Date = new Date()): Promise<T | null> {
  const cutoff = new Date(now.getTime() - LOCK_STALE_MINUTES * 60_000).toISOString();
  const { error: staleError } = await client.from("system_jobs").delete().eq("idempotency_key", REFILL_LOCK_KEY).lt("created_at", cutoff);
  if (staleError) throw new Error(`could not clear a stale refill lock: ${staleError.message}`);

  const { data, error } = await client
    .from("system_jobs")
    .insert({ job_type: REFILL_LOCK_JOB_TYPE, status: "succeeded", idempotency_key: REFILL_LOCK_KEY })
    .select("id")
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return null;
    throw new Error(`could not take the refill lock: ${error.message}`);
  }
  const lockId = (data as { id: string }).id;
  try {
    return await work();
  } finally {
    // By id, so a run that overran its stale window never removes the next holder's lock. A failed delete only delays
    // the next refill until the lock goes stale, so it must not replace the step's own result or error.
    await client.from("system_jobs").delete().eq("id", lockId);
  }
}
