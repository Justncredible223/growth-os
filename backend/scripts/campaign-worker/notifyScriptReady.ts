import type { SupabaseClient } from "@supabase/supabase-js";
import { MANUAL_MOTION_CONCEPT_TITLE_PREFIX } from "../../src/opportunities/manualMotionConcept.js";
import type { sendScriptReadyNotification } from "../video-worker/pushSender.js";

/**
 * Pushes "script ready to approve" to every registered device once a draft has passed review and landed in Approvals.
 * Best effort and silent when push is not configured (no Firebase credentials in the run): a push problem must never fail the
 * draft, which is already saved and waiting in Approvals either way.
 */
export async function notifyScriptReady(client: SupabaseClient, opportunityTitle: string, send: typeof sendScriptReadyNotification): Promise<void> {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH) return;
    const { data: devices } = await client.from("device_push_tokens").select("fcm_token").is("revoked_at", null);
    const title = opportunityTitle.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX) ? opportunityTitle.slice(MANUAL_MOTION_CONCEPT_TITLE_PREFIX.length) : opportunityTitle;
    for (const device of (devices ?? []) as Array<{ fcm_token: string }>) {
      await send(device.fcm_token, title);
    }
  } catch (err) {
    console.error("[campaign-worker] script-ready push could not be sent:", (err as Error).message ?? err);
  }
}
