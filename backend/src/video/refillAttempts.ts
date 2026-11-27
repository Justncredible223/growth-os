import type { getServiceClient } from "../lib/supabaseClient.js";
import { ONE_PER_DAY_ZONE } from "./dailyLimit.js";

type Client = ReturnType<typeof getServiceClient>;

/**
 * The automatic refill's own record of what it tried: one system_jobs row per attempt, stored as already 'succeeded' so no
 * job worker ever picks it up. It does two jobs. It caps automatic attempts per Arizona day, so a broken service cannot
 * buy run after run. And it tells the campaign worker that a run was automatic, so that run is held to the background
 * spending limits and not the owner's (the app's Motion render button writes no such row).
 *
 * The attempt number is part of the row's unique idempotency_key, so two runs can never take the same attempt.
 */
export const ATTEMPT_JOB_TYPE = "chart_card_attempt";
/** Including the first. After these, the refill waits for the next request day. */
export const MAX_AUTOMATIC_ATTEMPTS_PER_DAY = 3;
/** Minutes that must have passed since the previous attempt before the second and the third. The pulses are about 5 hours apart. */
export const ATTEMPT_BACKOFF_MINUTES: readonly number[] = [0, 60, 120];
/** How long an attempt with no request id yet still marks its opportunity's run as automatic. */
const UNLINKED_ATTEMPT_MINUTES = 30;

const UNIQUE_VIOLATION = "23505";

interface AttemptPayload {
  at: string;
  conceptId: string;
  opportunityId?: string;
  campaignRunRequestId?: string;
}

export type AttemptReservation = { ok: true; attemptId: string; attempt: number } | { ok: false; reason: string };

function dayKeyPrefix(now: Date): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: ONE_PER_DAY_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return `chart_card_attempt:${day}:`;
}

export async function reserveRefillAttempt(client: Client, conceptId: string, now: Date = new Date()): Promise<AttemptReservation> {
  const prefix = dayKeyPrefix(now);
  const { data, error } = await client.from("system_jobs").select("payload").eq("job_type", ATTEMPT_JOB_TYPE).like("idempotency_key", `${prefix}%`);
  if (error) throw new Error(`could not read today's refill attempts: ${error.message}`);
  const made = ((data ?? []) as Array<{ payload: AttemptPayload }>).map((r) => Date.parse(r.payload.at));
  if (made.length >= MAX_AUTOMATIC_ATTEMPTS_PER_DAY) {
    return { ok: false, reason: `${made.length} automatic attempts already made today; waiting for the next request day` };
  }
  if (made.length > 0) {
    const waited = (now.getTime() - Math.max(...made)) / 60_000;
    const needed = ATTEMPT_BACKOFF_MINUTES[made.length]!;
    if (waited < needed) return { ok: false, reason: `backing off: attempt ${made.length + 1} needs ${needed} minutes after the last one` };
  }

  const attempt = made.length + 1;
  const payload: AttemptPayload = { at: now.toISOString(), conceptId };
  const { data: inserted, error: insertError } = await client
    .from("system_jobs")
    .insert({ job_type: ATTEMPT_JOB_TYPE, status: "succeeded", idempotency_key: `${prefix}${attempt}`, payload })
    .select("id")
    .single();
  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) return { ok: false, reason: "another run took this attempt" };
    throw new Error(`could not record the refill attempt: ${insertError.message}`);
  }
  return { ok: true, attemptId: (inserted as { id: string }).id, attempt };
}

/** Adds what is now known about an attempt: its opportunity before the run is queued, then the queued run's id. */
export async function linkRefillAttempt(client: Client, attemptId: string, link: { opportunityId: string; campaignRunRequestId?: string }): Promise<void> {
  const { data, error } = await client.from("system_jobs").select("payload").eq("id", attemptId).single();
  if (error) throw new Error(`could not read the refill attempt: ${error.message}`);
  const payload = { ...(data as { payload: AttemptPayload }).payload, ...link };
  const { error: updateError } = await client.from("system_jobs").update({ payload, updated_at: new Date().toISOString() }).eq("id", attemptId);
  if (updateError) throw new Error(`could not update the refill attempt: ${updateError.message}`);
}

/**
 * Whether the automatic refill queued this run. The opportunity match covers the moment between queueing the run and
 * writing its id (or a failed write), so an automatic run is never mistaken for the owner's. A read error throws: the
 * worker then fails the run rather than guess which spending limit applies.
 */
export async function isAutomaticRefillRun(client: Client, campaignRunRequestId: string, opportunityId: string, now: Date = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const { data, error } = await client.from("system_jobs").select("payload").eq("job_type", ATTEMPT_JOB_TYPE).gte("created_at", since);
  if (error) throw new Error(`could not check whether this run was automatic: ${error.message}`);
  return ((data ?? []) as Array<{ payload: AttemptPayload }>).some(
    ({ payload }) =>
      payload.campaignRunRequestId === campaignRunRequestId ||
      (!payload.campaignRunRequestId && payload.opportunityId === opportunityId && now.getTime() - Date.parse(payload.at) < UNLINKED_ATTEMPT_MINUTES * 60_000),
  );
}
