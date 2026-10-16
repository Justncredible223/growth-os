import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseNotificationRepository } from "../notifications/supabaseNotificationRepository.js";
import type { NotificationSeverity } from "../notifications/types.js";

/**
 * The post-draw plan for the "Win a year of Fillbook Elite" giveaway (fillbookhq.com/giveaway), written 2026-10-15.
 *
 * Why it exists: the giveaway is follow-gated, so follows made only to enter tend to leave once the draw is over, and
 * nothing in Growth OS planned for the draw, the winner, the churn or what to say afterwards. The entry data lives in the
 * Fillbook site's database (giveaway_entries / giveaway_draws, drawn from the owner-only admin Giveaway page), not here, so
 * this module cannot see whether a draw happened. It is a dated playbook: on each milestone one notification carries a
 * checklist and, where a public post helps, a ready draft. Nothing is posted or emailed for the owner.
 *
 * Every date and rule below comes from the official rules page (verified 2026-10-15):
 *   - open Oct 11 2026 12:00 AM EDT, closes Nov 30 2026 11:59 PM EST;
 *   - one winner drawn at random "within 7 days after the entry period ends";
 *   - before the prize is given the winner must still be following @FillbookHQ on X, otherwise it is forfeited and a new
 *     winner is drawn the same way; the winner has 7 days to reply to the notification email;
 *   - the winner's first name and country may be announced publicly, with their permission;
 *   - an entrant's email is used to run the giveaway and contact the winner, and goes on the newsletter only if they ticked
 *     the box (giveaway_entries.marketing_opt_in).
 */
export const GIVEAWAY_OPENS_AT = "2026-10-11T04:00:00Z"; // Oct 11 12:00 AM EDT
export const GIVEAWAY_CLOSES_AT = "2026-12-01T04:59:59Z"; // Nov 30 11:59 PM EST
/** "Within 7 days after the entry period ends". */
export const GIVEAWAY_DRAW_DEADLINE = "2026-12-08T04:59:59Z"; // Dec 7 11:59 PM EST
export const GIVEAWAY_PAGE = "fillbookhq.com/giveaway";
/** A milestone missed for longer than this (the daily run was down) is not sent late as if it were current. */
export const MAX_LATE_MS = 3 * 24 * 60 * 60 * 1000;

export interface GiveawayMilestone {
  id: string;
  /** The first daily pipeline run at or after this instant creates it (13:00 UTC is 6:00 AM Arizona). */
  dueAt: string;
  /** After this instant the milestone is no longer true (a countdown after the close, a deadline after it passed) and is never sent. */
  expiresAt?: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
}

const RULES_LINE = `Free to enter, no purchase necessary, 18 or older. Entry and official rules: ${GIVEAWAY_PAGE}`;

/** The public drafts. Plain words, no emoji, no hashtags, no promise beyond the official rules. The owner posts by hand. */
export const DRAFTS = {
  lastWeek: `One week left to enter the Fillbook Elite giveaway. A free year of Elite, a $399.90 value. Closes Nov 30 at 11:59 PM Eastern. ${RULES_LINE}`,
  lastDay: `The Fillbook Elite giveaway closes tonight at 11:59 PM Eastern. A free year of Elite, a $399.90 value. ${RULES_LINE}`,
  closed: `The Fillbook Elite giveaway is closed. Thank you to everyone who entered. The winner is drawn at random within 7 days and notified by email. Official rules: ${GIVEAWAY_PAGE}`,
  /** Only with the winner's permission: the rules allow first name and country, nothing else. */
  winner: `The Fillbook Elite giveaway winner: [FIRST NAME] from [COUNTRY], drawn at random from [ENTRY COUNT] entries. Thank you to everyone who entered. Official rules and how it was drawn: ${GIVEAWAY_PAGE}`,
  whatsNext: `The giveaway is over. If you entered and want to see the product anyway, there is a 14-day trial with no card, and a free plan for one account after that. fillbookhq.com`,
} as const;

const DRAW_CHECKLIST = [
  "1. Open the owner-only Giveaway page on the Fillbook site (Admin > Giveaway). Draw is available only after the giveaway has closed.",
  "2. Draw once. Note the entry count shown (you need it for the winner post).",
  "3. Before anything is given: open x.com/<winner's X handle> while signed in as @FillbookHQ and check it says \"Follows you\". If it does not, mark the draw Forfeited with a note and redraw. The rules say the prize is forfeited and a new winner drawn the same way.",
  "4. Email the winner at the address they entered. They have 7 days to reply. Ask if they agree to be named by first name and country.",
  "5. When they reply, mark the draw Claimed. If they already pay for Fillbook, the 12 free months are applied to their account instead.",
  "6. Do not email other entrants about anything promotional. Their address is for running the giveaway and contacting the winner; only those who ticked the newsletter box can be mailed marketing.",
].join("\n");

export const GIVEAWAY_MILESTONES: readonly GiveawayMilestone[] = [
  {
    id: "two-weeks",
    dueAt: "2026-11-16T13:00:00Z",
    expiresAt: GIVEAWAY_CLOSES_AT,
    severity: "info",
    title: "Giveaway: two weeks left",
    body: [
      "The giveaway closes Nov 30 at 11:59 PM Eastern.",
      "No post is needed today. Entries come mostly from people already looking at the profile, and pushing the giveaway more brings more people who follow only to enter and then leave.",
      "Do check that the pinned post and fillbookhq.com/giveaway still say the same thing as the official rules.",
    ].join("\n"),
  },
  {
    id: "last-week",
    dueAt: "2026-11-23T13:00:00Z",
    expiresAt: GIVEAWAY_CLOSES_AT,
    severity: "info",
    title: "Giveaway: last week, draft ready",
    body: ["One week left. A single reminder post is enough. Draft (post by hand):", "", DRAFTS.lastWeek].join("\n"),
  },
  {
    id: "last-day",
    dueAt: "2026-11-30T13:00:00Z",
    expiresAt: GIVEAWAY_CLOSES_AT,
    severity: "warning",
    title: "Giveaway closes tonight",
    body: [
      "Closes tonight at 11:59 PM Eastern (9:59 PM Arizona). Entries after that do not count.",
      "Draft (post by hand, optional):",
      "",
      DRAFTS.lastDay,
      "",
      "Expect the follower count to wobble after the draw. Follows made only to enter tend to leave; that is normal and the weekly review will show it.",
    ].join("\n"),
  },
  {
    id: "closed",
    dueAt: "2026-12-01T13:00:00Z",
    severity: "warning",
    title: "Giveaway closed: draw the winner today",
    body: [
      `The entry period has ended. The rules require the draw within 7 days (by Dec 7 11:59 PM Eastern). Do it today.`,
      "",
      DRAW_CHECKLIST,
      "",
      "Closing post draft (no winner yet, post by hand):",
      "",
      DRAFTS.closed,
    ].join("\n"),
  },
  {
    id: "draw-deadline",
    dueAt: "2026-12-05T13:00:00Z",
    expiresAt: GIVEAWAY_DRAW_DEADLINE,
    severity: "warning",
    title: "Giveaway: draw deadline in 2 days",
    body: [
      "The rules say the winner is drawn within 7 days after the entry period ends: by Dec 7 11:59 PM Eastern.",
      "If the draw is done, ignore this. If not, do it now (Admin > Giveaway). Growth OS cannot see the Fillbook site's draw records, so this reminder is unconditional.",
    ].join("\n"),
  },
  {
    id: "afterglow",
    dueAt: "2026-12-09T13:00:00Z",
    severity: "info",
    title: "Giveaway: after the draw, what to post and what to watch",
    body: [
      "If the winner agreed to be named (first name and country only), a winner post helps people trust the next giveaway. Draft, fill the brackets:",
      "",
      DRAFTS.winner,
      "",
      "A follow-on post for people who entered and left without an account. One time only, no pressure:",
      "",
      DRAFTS.whatsNext,
      "",
      "What to watch: the Monday review shows the follower change against what was posted. Compare the two weeks after Dec 1 with the two weeks before Oct 11. A dip that matches the number of entrants who followed only to enter is expected, not a content problem.",
    ].join("\n"),
  },
  {
    id: "claim-window",
    dueAt: "2026-12-12T13:00:00Z",
    severity: "warning",
    title: "Giveaway: has the winner replied?",
    body: [
      "The winner has 7 days from your notification email to reply. If you notified them by Dec 5 that window has ended.",
      "If they have not replied, are not following @FillbookHQ, or declined: mark the draw Forfeited with a note and redraw the same way (Admin > Giveaway), then repeat the follow check and notification.",
      "If they replied and the prize is applied, mark the draw Claimed.",
    ].join("\n"),
  },
];

/** Milestones due now and not stale. Pure, so every date rule is unit-tested without a database. */
export function dueMilestones(now: Date, alreadyCreated: ReadonlySet<string>): GiveawayMilestone[] {
  return GIVEAWAY_MILESTONES.filter((m) => {
    const due = Date.parse(m.dueAt);
    const live = !m.expiresAt || now.getTime() <= Date.parse(m.expiresAt);
    return live && due <= now.getTime() && now.getTime() - due <= MAX_LATE_MS && !alreadyCreated.has(relatedIdFor(m.id));
  });
}

export const relatedIdFor = (id: string) => `giveaway-plan-${id}`;

/** The daily pipeline step. Creates each due milestone once (deduped on related_id) and reads no other table. */
export async function runGiveawayPlanStep(client: SupabaseClient, now: Date): Promise<string> {
  const ids = GIVEAWAY_MILESTONES.map((m) => relatedIdFor(m.id));
  const { data, error } = await client.from("notifications").select("related_id").in("related_id", ids);
  if (error) throw new Error(`giveaway plan: notification lookup failed: ${error.message}`);
  const existing = new Set(((data ?? []) as Array<{ related_id: string | null }>).map((r) => r.related_id).filter((x): x is string => !!x));
  const due = dueMilestones(now, existing);
  const repo = new SupabaseNotificationRepository(client);
  for (const m of due) {
    await repo.create({ type: "giveaway_plan", title: m.title, body: m.body, severity: m.severity, relatedId: relatedIdFor(m.id) });
  }
  if (due.length > 0) return `${due.length} created: ${due.map((m) => m.id).join(", ")}`;
  const next = GIVEAWAY_MILESTONES.find((m) => Date.parse(m.dueAt) > now.getTime());
  return next ? `nothing due; next: ${next.id} on ${next.dueAt.slice(0, 10)}` : "giveaway plan complete";
}
