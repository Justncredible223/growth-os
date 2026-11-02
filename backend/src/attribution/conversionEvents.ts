import type { SupabaseClient } from "@supabase/supabase-js";

export type ConversionEventType = "signup" | "activation" | "first_trade" | "first_paid";
export const CONVERSION_EVENT_TYPES: ConversionEventType[] = ["signup", "activation", "first_trade", "first_paid"];

export interface NewConversionEvent {
  source: string;
  eventType?: ConversionEventType;
  /** Fillbook's own stable id for the underlying event (their `events.id` UUID) -- the dedup key. Omitted only by the original pre-2026-09-18 signup-only callers. */
  externalEventId?: string | null;
  /** HMAC of Fillbook's user_id, keyed by a secret only Fillbook holds -- see migration 0035's comment. Never a real user_id/email. */
  subjectHash?: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  eventTouchUtmSource?: string | null;
  eventTouchUtmMedium?: string | null;
  eventTouchUtmCampaign?: string | null;
  eventTouchUtmContent?: string | null;
  referralCode: string | null;
  occurredAt: string;
}

export interface RecordConversionEventResult {
  /** false when this externalEventId was already recorded -- a safe, expected outcome for a retried/duplicate delivery, not an error. */
  inserted: boolean;
}

/**
 * Records one conversion reported by an external webhook (today: only
 * Fillbook's signup/activation/first_trade/first_paid events, all under
 * source="fillbook_signup" -- see migration 0035). Throws on failure
 * rather than swallowing it, unlike cost/costTracking.ts's recordCostEvent
 * -- this is the entire point of the request (there's no discovery/reply
 * work happening alongside it to protect), so the caller (api/ingest.ts)
 * should see the failure and return a 500 rather than silently losing the
 * event.
 *
 * Idempotent by (source, externalEventId): a retried webhook delivery or
 * a re-run of Fillbook's sync cron after a partial failure re-sends the
 * same externalEventId, and the unique index from migration 0035 makes a
 * duplicate a no-op rather than a double-counted conversion. Detected via
 * Postgres's own unique_violation code (23505) rather than a
 * select-then-insert race, which two concurrent deliveries of the same
 * event could both pass.
 */
export async function recordConversionEvent(client: SupabaseClient, event: NewConversionEvent): Promise<RecordConversionEventResult> {
  const { error } = await client.from("conversion_events").insert({
    source: event.source,
    event_type: event.eventType ?? "signup",
    external_event_id: event.externalEventId ?? null,
    subject_hash: event.subjectHash ?? null,
    utm_source: event.utmSource,
    utm_medium: event.utmMedium,
    utm_campaign: event.utmCampaign,
    utm_content: event.utmContent,
    event_touch_utm_source: event.eventTouchUtmSource ?? null,
    event_touch_utm_medium: event.eventTouchUtmMedium ?? null,
    event_touch_utm_campaign: event.eventTouchUtmCampaign ?? null,
    event_touch_utm_content: event.eventTouchUtmContent ?? null,
    referral_code: event.referralCode,
    occurred_at: event.occurredAt,
  });
  if (error) {
    if (error.code === "23505") return { inserted: false };
    throw new Error(`Failed to record conversion event: ${error.message}`);
  }
  return { inserted: true };
}
