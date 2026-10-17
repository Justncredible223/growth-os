export type InboundPriority = "p1_direct_reply" | "p2_relationship" | "p3_comment" | "p4_mention" | "low_value";

export type InboundStatus =
  | "new"
  | "needs_response"
  | "draft_ready"
  | "responded"
  | "follow_up"
  | "review_needed"
  | "closed";

export interface InboundEngagement {
  id: string;
  platform: string;
  externalId: string;
  conversationId: string | null;
  inReplyToExternalId: string | null;
  authorHandle: string | null;
  authorExternalId: string | null;
  creatorId: string | null;
  body: string;
  inResponseToText: string | null;
  publicMetrics: Record<string, number>;
  priority: InboundPriority;
  status: InboundStatus;
  draftResponse: string | null;
  draftUsesLink: boolean | null;
  /** The owner's own wording when they edited the draft before posting (0036). Null when posted as drafted or not yet responded. */
  finalResponse?: string | null;
  respondedAt: string | null;
  respondedNote: string | null;
  isRepeatEngager: boolean;
  observedAt: string;
  sourceReference: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewInboundEngagement = Omit<InboundEngagement, "id" | "createdAt" | "updatedAt">;

export interface InboundRepository {
  /**
   * Upserts on (platform, externalId) -- the same message ingested twice
   * (e.g. a since_id cursor reset during backlog recovery) updates rather
   * than duplicates. Returns the row's id and whether it was newly
   * created, so ingestion can decide whether to run classification/repeat
   * -engager detection (skip on an existing row -- don't reclassify or
   * reprioritize something the operator may have already triaged).
   */
  upsertIfNew(engagement: NewInboundEngagement): Promise<{ id: string; created: boolean }>;
  countPriorFromAuthor(platform: string, authorExternalId: string): Promise<number>;
  findLatestInConversation(conversationId: string): Promise<InboundEngagement | null>;
  listByStatus(statuses: InboundStatus[]): Promise<InboundEngagement[]>;
  getById(id: string): Promise<InboundEngagement | null>;
  /** Stores the conversation text the drafter was given, so the card can show it. */
  setInResponseToText(id: string, text: string): Promise<void>;
  updateStatus(
    id: string,
    status: InboundStatus,
    fields?: Partial<Pick<InboundEngagement, "draftResponse" | "draftUsesLink" | "respondedAt" | "respondedNote" | "finalResponse">>,
  ): Promise<void>;
}
