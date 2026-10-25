import type { SupabaseClient } from "@supabase/supabase-js";
import { createXSignalAdapter, type XSignalAdapter } from "../signals/adapters/xAdapter.js";
import { SupabaseProspectingRepository } from "./supabaseProspectingRepository.js";
import { prospectingRunExtras } from "./prospectingRunDeps.js";
import { runProspectingSearch, type ProspectingRunResult } from "./prospectingSearch.js";

/** How far apart (in minutes) two refills must be to start from different topics: the same as the reply cooldown. */
const REFILL_ROTATION_MINUTES = 20;

export interface RefillDeps {
  run?: typeof runProspectingSearch;
  adapter?: XSignalAdapter;
  now?: Date;
}

/**
 * Tops the queue up right after the owner marks a reply posted (2026-10-24). The 20-minute cooldown has just started, so by the time
 * it ends a fresh, vetted post is waiting instead of the owner tapping Search now and hoping. It is the same search as the scheduled
 * run: it skips when two usable posts are already waiting, searches one topic at a time, stops once the buffer is met, and is held by the
 * monthly budget and the daily search limit. It never throws: a failed refill must not undo or delay saving the reply. Returns a
 * one-line summary for logs.
 */
export async function refillProspectingQueue(client: SupabaseClient, deps: RefillDeps = {}): Promise<string> {
  const now = deps.now ?? new Date();
  const run = deps.run ?? runProspectingSearch;
  try {
    const result: ProspectingRunResult = await run({
      adapter: deps.adapter ?? createXSignalAdapter(client),
      repo: new SupabaseProspectingRepository(client),
      client,
      now,
      runIndexOffset: Math.floor(now.getTime() / (REFILL_ROTATION_MINUTES * 60 * 1000)) % 997,
      ...prospectingRunExtras(client),
    });
    return result.skipped ? `refill skipped -- ${result.skipReason}` : `refill: ${result.newCandidates} new, ${result.screenedOut ?? 0} screened out, ${result.searchRequests ?? 0} searches`;
  } catch (err) {
    return `refill failed -- ${err instanceof Error ? err.message : String(err)}`;
  }
}
