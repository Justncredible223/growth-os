/**
 * "Published content -> customer outcomes" growth loop (2026-09-18),
 * Analytics item 4: pure aggregation over already-fetched rows, kept
 * separate from summary.ts's Supabase queries the same way
 * dailyXFeedPost.ts's computeTodayXPostView is -- easy to unit test
 * without a database, and the honesty rules below (what counts as
 * "unavailable" vs "zero") live in exactly one place.
 *
 * What this can and cannot honestly claim, given what Growth OS actually
 * has access to (see docs/ARCHITECTURE.md's isolation goal -- no DB
 * access into Fillbook):
 *  - "Published content" = content_publications rows with a real
 *    owner-confirmed publication (ownerReportedPublishedAt set) --
 *    see migration 0035's own comment on why row-existence alone isn't
 *    enough (a placeholder row can exist purely to hold a destination
 *    link before anything is published).
 *  - "Attributable visits" = link_clicks, NOT total site traffic --
 *    Growth OS has no visibility into visits that never went through one
 *    of its own tracked links. Labeled explicitly, never called
 *    "visitors."
 *  - "Signups"/"activated"/"first paid" = conversion_events by
 *    event_type, delivered by Fillbook's own sync (see fillbook's
 *    growthOsSync.ts). Zero here can mean either "really zero" or
 *    "Fillbook's sync hasn't run yet" -- see hasAnyFunnelData below,
 *    which the caller uses to distinguish those two cases explicitly
 *    rather than presenting a bare 0.
 *  - "Current active subscriptions" is NOT computed here at all --
 *    billing state lives in Fillbook's own database and is
 *    structurally unavailable to this isolated project. Never
 *    approximated from first_paid conversion counts, which only ever
 *    grow and say nothing about churn.
 *  - "Cost" here is content-production cost (cost_events -- LLM/API
 *    spend), never "ad spend" (this project runs organic-only, no paid
 *    placement exists to spend on).
 */

export interface GrowthLoopPublicationRow {
  channel: string;
  /** Null means this row only ever held a destination link, never a real owner-confirmed publication -- see migration 0035's comment. */
  ownerReportedPublishedAt: string | null;
}

export interface GrowthLoopConversionRow {
  eventType: string;
  utmSource: string | null;
  occurredAt: string;
}

export interface GrowthLoopInput {
  windowDays: number;
  publications: GrowthLoopPublicationRow[];
  linkClickCount: number;
  conversions: GrowthLoopConversionRow[];
  contentProductionCostUsd: number;
  /** True once Fillbook's sync has ever delivered ANY event (any event_type, any time, not just this window) -- distinguishes "the funnel is genuinely empty this window" from "nothing has ever arrived, this isn't connected yet." */
  fillbookSyncHasEverDelivered: boolean;
}

export interface GrowthLoopChannelBreakdown {
  channel: string;
  publishedContentCount: number;
  signups: number;
  activated: number;
  firstPaidConversions: number;
}

export interface GrowthLoopSummary {
  windowDays: number;
  publishedContentCount: number;
  /** Explicitly NOT "visitors" -- see this file's own header comment. */
  trackedLinkClicks: number;
  funnelConnectionStatus: "not_yet_connected" | "connected";
  signups: number;
  activated: number;
  firstPaidConversions: number;
  contentProductionCostUsd: number;
  costPerSignup: number | null;
  activeSubscriptions: { status: "unavailable"; reason: string };
  byChannel: GrowthLoopChannelBreakdown[];
  attributionNote: string;
}

const ATTRIBUTION_NOTE =
  "Tracked-link clicks measure attributable visits only -- they cannot identify everyone who saw published content or who later visited fillbookhq.com without clicking a tracked link.";

const SUBSCRIPTION_UNAVAILABLE_REASON =
  "Billing/subscription state lives in Fillbook's own database, kept isolated from Growth OS by design (see docs/ARCHITECTURE.md). Not computable here from first-paid conversion counts, which only ever grow and say nothing about later cancellations.";

export function computeGrowthLoopSummary(input: GrowthLoopInput): GrowthLoopSummary {
  const publishedContentCount = input.publications.filter((p) => p.ownerReportedPublishedAt !== null).length;

  const bySignupType = (type: string) => input.conversions.filter((c) => c.eventType === type).length;
  const signups = bySignupType("signup");
  const activated = bySignupType("activation");
  const firstPaidConversions = bySignupType("first_paid");

  // Cost-per-signup is only ever shown when the denominator is real --
  // dividing by zero signups would produce Infinity/NaN, and reporting a
  // huge or undefined "cost per signup" from a zero denominator is
  // exactly the misleading-rate failure mode the task calls out.
  const costPerSignup = signups > 0 ? Number((input.contentProductionCostUsd / signups).toFixed(2)) : null;

  const channels = new Set<string>([
    ...input.publications.map((p) => p.channel),
    ...input.conversions.filter((c) => c.utmSource).map((c) => c.utmSource as string),
  ]);
  const byChannel: GrowthLoopChannelBreakdown[] = [...channels].sort().map((channel) => ({
    channel,
    publishedContentCount: input.publications.filter((p) => p.channel === channel && p.ownerReportedPublishedAt !== null).length,
    signups: input.conversions.filter((c) => c.eventType === "signup" && c.utmSource === channel).length,
    activated: input.conversions.filter((c) => c.eventType === "activation" && c.utmSource === channel).length,
    firstPaidConversions: input.conversions.filter((c) => c.eventType === "first_paid" && c.utmSource === channel).length,
  }));

  return {
    windowDays: input.windowDays,
    publishedContentCount,
    trackedLinkClicks: input.linkClickCount,
    funnelConnectionStatus: input.fillbookSyncHasEverDelivered ? "connected" : "not_yet_connected",
    signups,
    activated,
    firstPaidConversions,
    contentProductionCostUsd: Number(input.contentProductionCostUsd.toFixed(6)),
    costPerSignup,
    activeSubscriptions: { status: "unavailable", reason: SUBSCRIPTION_UNAVAILABLE_REASON },
    byChannel,
    attributionNote: ATTRIBUTION_NOTE,
  };
}
