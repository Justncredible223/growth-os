import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_VIDEO_RENDERS_PER_DAY, MAX_VIDEO_RENDERS_PER_MONTH } from "./videoRenderEligibility.js";

/**
 * Render caps counted from durable history (P2, ChatGPT 2026-11-15). The enqueue RPC counts video_renders rows, but Dismiss, Retry and the
 * 7-day cleanup delete rows, so the "monthly" cap under-counted. Every render attempt also writes a system_jobs row (job_type render_video)
 * that nothing deletes, so this checks the same caps against those rows first. The RPC's own check still runs after it.
 * Month: UTC calendar month (same as the RPC). Day: the owner's day in Arizona (UTC-7, no daylight saving; same as the RPC).
 */
export function renderCapWindows(now: Date): { monthStart: string; dayStart: string } {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const az = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  const dayStart = new Date(Date.UTC(az.getUTCFullYear(), az.getUTCMonth(), az.getUTCDate()) + 7 * 60 * 60 * 1000).toISOString();
  return { monthStart, dayStart };
}

/** The refusal reason (same wording as the RPC) when a cap is reached by recorded render attempts, else null. A failed read refuses nothing. */
export async function durableRenderCapReason(client: SupabaseClient, now: Date = new Date()): Promise<string | null> {
  const { monthStart, dayStart } = renderCapWindows(now);
  const count = async (since: string): Promise<number | null> => {
    try {
      const { count: n, error } = await client.from("system_jobs").select("id", { count: "exact", head: true }).eq("job_type", "render_video").gte("created_at", since);
      return error ? null : (n ?? 0);
    } catch {
      return null; // the RPC still enforces its own caps
    }
  };
  const month = await count(monthStart);
  if (month !== null && month >= MAX_VIDEO_RENDERS_PER_MONTH) return `monthly_render_cap_reached (${month} renders this month, cap is ${MAX_VIDEO_RENDERS_PER_MONTH})`;
  const day = await count(dayStart);
  if (day !== null && day >= MAX_VIDEO_RENDERS_PER_DAY) return `daily_render_cap_reached (${day} renders today, cap is ${MAX_VIDEO_RENDERS_PER_DAY})`;
  return null;
}
