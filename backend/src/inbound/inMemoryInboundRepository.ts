import type { InboundEngagement, InboundRepository, InboundStatus, NewInboundEngagement } from "./types.js";

export class InMemoryInboundRepository implements InboundRepository {
  private rows: InboundEngagement[] = [];
  private counter = 0;

  async upsertIfNew(engagement: NewInboundEngagement): Promise<{ id: string; created: boolean }> {
    const existing = this.rows.find((r) => r.platform === engagement.platform && r.externalId === engagement.externalId);
    if (existing) return { id: existing.id, created: false };
    const now = new Date().toISOString();
    const id = `inbound-${++this.counter}`;
    this.rows.push({ ...engagement, id, createdAt: now, updatedAt: now });
    return { id, created: true };
  }

  async countPriorFromAuthor(platform: string, authorExternalId: string): Promise<number> {
    return this.rows.filter((r) => r.platform === platform && r.authorExternalId === authorExternalId).length;
  }

  async findLatestInConversation(conversationId: string): Promise<InboundEngagement | null> {
    const matches = this.rows
      .filter((r) => r.conversationId === conversationId)
      .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime());
    return matches[0] ?? null;
  }

  async listByStatus(statuses: InboundStatus[]): Promise<InboundEngagement[]> {
    return this.rows.filter((r) => statuses.includes(r.status));
  }

  async setInResponseToText(id: string, text: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.inResponseToText = text;
  }

  async getById(id: string): Promise<InboundEngagement | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async updateStatus(
    id: string,
    status: InboundStatus,
    fields?: Partial<Pick<InboundEngagement, "draftResponse" | "draftUsesLink" | "respondedAt" | "respondedNote" | "finalResponse">>,
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`No inbound_engagements row with id "${id}"`);
    row.status = status;
    if (fields?.draftResponse !== undefined) row.draftResponse = fields.draftResponse;
    if (fields?.draftUsesLink !== undefined) row.draftUsesLink = fields.draftUsesLink;
    if (fields?.respondedAt !== undefined) row.respondedAt = fields.respondedAt;
    if (fields?.respondedNote !== undefined) row.respondedNote = fields.respondedNote;
    if (fields?.finalResponse !== undefined) row.finalResponse = fields.finalResponse;
    row.updatedAt = new Date().toISOString();
  }

  /** Test-only inspection helper. */
  all(): InboundEngagement[] {
    return this.rows;
  }
}
