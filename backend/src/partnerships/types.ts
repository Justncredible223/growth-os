export type PartnerCategory = "educator_coach" | "creator_community" | "prop_firm" | "platform_broker" | "other";

export type PartnershipStage =
  | "prospect"
  | "qualified"
  | "draft_ready"
  | "contacted"
  | "replied"
  | "pilot"
  | "active_partner"
  | "closed"
  | "archived"
  | "do_not_contact";

export type PartnershipInteractionType =
  | "note"
  | "draft_generated"
  | "contacted"
  | "reply_received"
  | "follow_up_sent"
  | "pilot_started"
  | "pilot_ended"
  | "outcome_recorded";

export type PartnershipOutcomeMetric = "signups" | "activations" | "paid_conversions" | "retention" | "referral_cost_usd";
export type PartnershipOutcomeSource = "measured" | "manual_entry";

export interface PartnershipProspect {
  id: string;
  organizationName: string;
  contactName: string | null;
  partnerCategory: PartnerCategory;
  stage: PartnershipStage;
  websiteUrl: string | null;
  /** Free-form platform->url map, e.g. {"x": "https://x.com/handle"} -- never fabricated, only what was actually researched. */
  socialLinks: Record<string, string>;
  contactRoute: string | null;
  contactRouteSource: string | null;
  audienceFocus: string | null;
  futuresRelevanceEvidence: string | null;
  sourceUrls: string[];
  /** The recipient's own real words (post text, bio, creator notes) -- see 0022_partnership_evidence_excerpts.sql. Empty for most manually entered prospects. */
  evidenceExcerpts: string[];
  researchDate: string | null;
  competingJournalRelationships: string | null;
  competingJournalEvidence: string | null;
  proposedCollaboration: string | null;
  qualificationRationale: string | null;
  ownerNotes: string | null;
  nextAction: string | null;
  nextActionDueDate: string | null;
  pilotTermsProposed: string | null;
  pilotTermsAgreed: string | null;
  pilotStartDate: string | null;
  pilotEndDate: string | null;
  referralCode: string | null;
  followUpCount: number;
  /** The campaign_assets row currently approved for contact -- null until a draft passes review, and cleared again if the approved text is materially edited afterward (see stageTransitions.ts's invalidateApproval). */
  approvedCampaignAssetId: string | null;
  contactedAt: string | null;
  contactedChannel: string | null;
  normalizedDomain: string | null;
  normalizedHandle: string | null;
  /** 0-100 ranking score computed at discovery time by discoveryScoring.ts -- null for manually entered prospects. */
  discoveryScore: number | null;
  discoveryConfidence: "low" | "medium" | "high" | null;
  /** Set only by automated reassessment -- null means not suppressed. Distinct from and never overrides owner-driven 'archived'/'do_not_contact' stages. Reversible. */
  suppressedReason: string | null;
  /** 'manual' for owner-entered prospects; otherwise which discovery source found this one. Never overwritten after creation. */
  discoveredVia: "manual" | "creators" | "prospecting" | "inbound" | "x_search";
  createdAt: string;
  updatedAt: string;
}

export interface PartnershipInteraction {
  id: string;
  partnershipId: string;
  interactionType: PartnershipInteractionType;
  occurredAt: string;
  summary: string;
}

export interface NewPartnershipProspect {
  organizationName: string;
  contactName?: string | null;
  partnerCategory: PartnerCategory;
  websiteUrl?: string | null;
  socialLinks?: Record<string, string>;
  contactRoute?: string | null;
  contactRouteSource?: string | null;
  audienceFocus?: string | null;
  futuresRelevanceEvidence?: string | null;
  sourceUrls?: string[];
  evidenceExcerpts?: string[];
  researchDate?: string | null;
  competingJournalRelationships?: string | null;
  competingJournalEvidence?: string | null;
  proposedCollaboration?: string | null;
  qualificationRationale?: string | null;
  ownerNotes?: string | null;
  discoveryScore?: number | null;
  discoveryConfidence?: "low" | "medium" | "high" | null;
  discoveredVia?: "manual" | "creators" | "prospecting" | "inbound" | "x_search";
}

export interface PartnershipRepository {
  list(): Promise<PartnershipProspect[]>;
  get(id: string): Promise<PartnershipProspect | null>;
  create(input: NewPartnershipProspect, normalized: { domain: string | null; handle: string | null }): Promise<PartnershipProspect>;
  update(id: string, patch: Partial<NewPartnershipProspect>): Promise<PartnershipProspect>;
  /** The ONLY path that changes `stage` -- always paired with an interaction row so history and stage never drift apart. */
  transitionStage(id: string, toStage: PartnershipStage, interaction: { interactionType: PartnershipInteractionType; summary: string }): Promise<PartnershipProspect>;
  setApprovedDraft(id: string, campaignAssetId: string | null): Promise<void>;
  /** Reversible, system-driven only. Pass null to un-suppress. */
  setSuppressedReason(id: string, reason: string | null): Promise<void>;
  recordContact(id: string, channel: string, contactedAt: string): Promise<void>;
  insertInteraction(partnershipId: string, interactionType: PartnershipInteractionType, summary: string): Promise<PartnershipInteraction>;
  listInteractions(partnershipId: string): Promise<PartnershipInteraction[]>;
  recordOutcome(partnershipId: string, metric: PartnershipOutcomeMetric, value: number | null, source: PartnershipOutcomeSource, note?: string | null): Promise<void>;
  /** Every row whose normalized_domain or normalized_handle matches, for dedup.ts -- own-history cross-reference, not the cross-system creators/prospecting/inbound checks (those are separate queries against those tables). */
  findByNormalized(domain: string | null, handle: string | null): Promise<PartnershipProspect[]>;
}
