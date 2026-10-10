import type { PartnershipStage } from "./types.js";

/**
 * Enforced in code, not purely by the DB CHECK constraint -- same
 * discipline as the Creators readiness score. The DB
 * constraint only guards against a garbage stage value; THIS is what
 * guards against an illegal jump (e.g. 'prospect' straight to 'pilot').
 *
 * 'archived' and 'do_not_contact' are reachable from every non-terminal
 * stage (an owner can bail at any point) but are themselves terminal --
 * nothing transitions out of them. 'active_partner' and 'closed' are also
 * terminal for this graph's purposes (re-engaging a closed/former partner
 * is a new prospect record, not a stage reversal on the old one).
 */
const FORWARD_EDGES: Record<PartnershipStage, PartnershipStage[]> = {
  prospect: ["qualified"],
  qualified: ["draft_ready"],
  draft_ready: ["contacted"],
  contacted: ["replied"],
  replied: ["pilot", "closed"],
  pilot: ["active_partner", "closed"],
  active_partner: ["closed"],
  closed: [],
  archived: [],
  do_not_contact: [],
};

const BAILOUT_STAGES: PartnershipStage[] = ["archived", "do_not_contact"];
const TERMINAL_STAGES: PartnershipStage[] = ["closed", "archived", "do_not_contact"];

export function isValidTransition(from: PartnershipStage, to: PartnershipStage): boolean {
  if (from === to) return false;
  if (TERMINAL_STAGES.includes(from)) return false;
  if (BAILOUT_STAGES.includes(to)) return true;
  return FORWARD_EDGES[from].includes(to);
}

export function isTerminalStage(stage: PartnershipStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/** A prospect can only be moved to 'contacted' once it actually has an approved, reviewed draft -- this is the "approval vs. actual contact" guarantee, checked independently of the stage graph above (a stage-valid transition can still be blocked for this reason). */
export function canMarkContacted(stage: PartnershipStage, approvedCampaignAssetId: string | null): boolean {
  return stage === "draft_ready" && approvedCampaignAssetId !== null;
}
