import type { getServiceClient } from "../lib/supabaseClient.js";
import { MANUAL_MOTION_CONCEPT_TITLE_PREFIX } from "../opportunities/manualMotionConcept.js";

type Client = ReturnType<typeof getServiceClient>;

/**
 * Owner rule, 2026-10-03: only ONE new video concept may be requested per day. "A day" is the calendar day in this zone
 * (America/Phoenix since 2026-10-04, the same day the render cap and the posting plan use; it was US Eastern before), so the
 * limit resets at midnight Arizona time whatever the server's clock says. The rule
 * covers both ways a request is made: the app's Motion render button (api/run-campaign.ts) and the daily refill
 * (src/video/dailyChartCardRequests.ts), so a manual request in the morning stops the refill that evening and vice versa.
 */
export const ONE_PER_DAY_ZONE = "America/Phoenix";

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function partsInZone(date: Date, zone: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const get = (type: string) => Number(f.formatToParts(date).find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** How far the zone's wall clock is ahead of UTC at this instant, in ms (negative for US zones). */
function offsetMs(date: Date, zone: string): number {
  const p = partsInZone(date, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant the zone's calendar day containing `now` began. Handles daylight-saving changes. */
export function startOfDay(now: Date, zone: string = ONE_PER_DAY_ZONE): Date {
  const p = partsInZone(now, zone);
  const wallMidnight = Date.UTC(p.y, p.m - 1, p.d, 0, 0, 0);
  let instant = wallMidnight - offsetMs(new Date(wallMidnight), zone);
  const corrected = wallMidnight - offsetMs(new Date(instant), zone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/** The instant the next calendar day begins in the zone, i.e. when the limit lifts. */
export function nextDayStart(now: Date, zone: string = ONE_PER_DAY_ZONE): Date {
  const p = partsInZone(now, zone);
  const tomorrowWall = Date.UTC(p.y, p.m - 1, p.d + 1, 0, 0, 0);
  let instant = tomorrowWall - offsetMs(new Date(tomorrowWall), zone);
  const corrected = tomorrowWall - offsetMs(new Date(instant), zone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

export interface TodaysRequests {
  /** Campaigns drafted today for a motion concept (thesis starts with the manual-request prefix). */
  campaigns: Array<{ thesis: string; status: string }>;
  /** Titles of concept requests made today that are still queued or running (no campaign yet). */
  pendingTitles: string[];
}

/**
 * The title of the concept already requested today, or null if today's request is still free. A request counts while its
 * draft is waiting in Approvals or approved, or while it is queued or running. It does NOT count once the owner rejected
 * the draft (the concept was not made), nor when the draft was retired by the plan-update cleanup SQL (it was never rejected
 * on its merits), nor when the run failed: those leave the day's request free to try again.
 */
export function conceptRequestedToday(today: TodaysRequests): string | null {
  const drafted = today.campaigns.find((c) => c.thesis.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX) && (c.status === "approved" || c.status === "in_review"));
  return drafted?.thesis ?? today.pendingTitles[0] ?? null;
}

/** Reads today's concept requests from the database. */
export async function motionRequestedToday(client: Client, now: Date = new Date()): Promise<string | null> {
  const since = startOfDay(now).toISOString();
  const { data: campaigns, error } = await client
    .from("campaigns")
    .select("thesis, status")
    .like("thesis", `${MANUAL_MOTION_CONCEPT_TITLE_PREFIX}%`)
    .in("status", ["approved", "in_review"])
    .gte("created_at", since);
  if (error) throw new Error(`One-a-day check failed (campaigns): ${error.message}`);

  const { data: pending, error: pendingError } = await client.from("campaign_run_requests").select("opportunity_id").in("status", ["queued", "running"]).gte("created_at", since);
  if (pendingError) throw new Error(`One-a-day check failed (requests): ${pendingError.message}`);
  const ids = [...new Set(((pending ?? []) as Array<{ opportunity_id: string }>).map((r) => r.opportunity_id))];
  let pendingTitles: string[] = [];
  if (ids.length > 0) {
    const { data: opps, error: oppError } = await client.from("opportunities").select("title").in("id", ids);
    if (oppError) throw new Error(`One-a-day check failed (opportunities): ${oppError.message}`);
    pendingTitles = ((opps ?? []) as Array<{ title: string }>).map((o) => o.title).filter((t) => t.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX));
  }
  return conceptRequestedToday({ campaigns: (campaigns ?? []) as TodaysRequests["campaigns"], pendingTitles });
}

/** What the owner is told when a second request is refused. */
export function oneADayMessage(requestedTitle: string, now: Date = new Date()): string {
  const shown = requestedTitle.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX) ? requestedTitle.slice(MANUAL_MOTION_CONCEPT_TITLE_PREFIX.length) : requestedTitle;
  const opens = nextDayStart(now).toLocaleString("en-US", { timeZone: ONE_PER_DAY_ZONE, weekday: "short", hour: "numeric", minute: "2-digit" });
  return `One video a day: "${shown}" was already requested today. The next request opens ${opens} Arizona time. Reject that draft in Approvals if you would rather make a different one today.`;
}
