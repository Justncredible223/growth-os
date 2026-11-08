import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationSeverity } from "../notifications/types.js";

/**
 * The Fillbook Elite giveaway has ENDED (team decision 2026-11-08, Site Work's public wording). The site no longer has
 * a /giveaway page (it redirects home), no entry form and no rules page, so the dated playbook that used to live here
 * (countdown posts that linked the page, a draw checklist, a winner post) is retired: nothing in it is true any more.
 *
 * Public status, the only thing we say: the giveaway has ended; thank you for entering; no new entries; no further
 * giveaways promised. Never say a winner was drawn, how, who won, the prize or its value, or an entry count, and never
 * link /giveaway. A person who asks about their own entry is pointed to the owner by email, with no promises.
 */
export const GIVEAWAY_ENDED_LINE = "The Fillbook Elite giveaway has ended. Thank you to everyone who entered.";
export const GIVEAWAY_OWNER_EMAIL = "developer@fillbookhq.com";

export interface GiveawayMilestone {
  id: string;
  dueAt: string;
  expiresAt?: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
}

/** Retired: no milestones are sent now that the giveaway has ended. */
export const GIVEAWAY_MILESTONES: readonly GiveawayMilestone[] = [];

export const relatedIdFor = (id: string) => `giveaway-plan-${id}`;

/** The daily pipeline step, kept so the pipeline's step list is stable. It does nothing now. */
export async function runGiveawayPlanStep(_client: SupabaseClient, _now: Date): Promise<string> {
  return "giveaway ended; no milestones";
}
