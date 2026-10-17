import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboundEngagement, InboundRepository, InboundStatus, NewInboundEngagement } from "./types.js";

function fromRow(data: Record<string, any>): InboundEngagement {
  return {
    id: data.id,
    platform: data.platform,
    externalId: data.external_id,
    conversationId: data.conversation_id,
    inReplyToExternalId: data.in_reply_to_external_id,
    authorHandle: data.author_handle,
    authorExternalId: data.author_external_id,
    creatorId: data.creator_id,
    body: data.body,
    inResponseToText: data.in_response_to_text,
    publicMetrics: data.public_metrics ?? {},
    priority: data.priority,
    status: data.status,
    draftResponse: data.draft_response,
    draftUsesLink: data.draft_uses_link,
    finalResponse: data.final_response ?? null,
    respondedAt: data.responded_at,
    respondedNote: data.responded_note,
    isRepeatEngager: data.is_repeat_engager,
    observedAt: data.observed_at,
    sourceReference: data.source_reference,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

export class SupabaseInboundRepository implements InboundRepository {
  constructor(private client: SupabaseClient) {}

  async upsertIfNew(engagement: NewInboundEngagement): Promise<{ id: string; created: boolean }> {
    const { data: existing, error: selectError } = await this.client
      .from("inbound_engagements")
      .select("id")
      .eq("platform", engagement.platform)
      .eq("external_id", engagement.externalId)
      .maybeSingle();
    if (selectError) throw new Error(`upsertIfNew select failed: ${selectError.message}`);
    if (existing) return { id: existing.id as string, created: false };

    const { data, error } = await this.client
      .from("inbound_engagements")
      .insert({
        platform: engagement.platform,
        external_id: engagement.externalId,
        conversation_id: engagement.conversationId,
        in_reply_to_external_id: engagement.inReplyToExternalId,
        author_handle: engagement.authorHandle,
        author_external_id: engagement.authorExternalId,
        creator_id: engagement.creatorId,
        body: engagement.body,
        in_response_to_text: engagement.inResponseToText,
        public_metrics: engagement.publicMetrics,
        priority: engagement.priority,
        status: engagement.status,
        draft_response: engagement.draftResponse,
        draft_uses_link: engagement.draftUsesLink,
        responded_at: engagement.respondedAt,
        responded_note: engagement.respondedNote,
        is_repeat_engager: engagement.isRepeatEngager,
        observed_at: engagement.observedAt,
        source_reference: engagement.sourceReference,
      })
      .select("id")
      .single();
    if (error) {
      // A unique-constraint race (concurrent ingestion runs) is not a
      // real failure -- someone else already inserted the same
      // (platform, external_id) row between our select and insert.
      if (error.code === "23505") {
        const { data: raceRow, error: raceError } = await this.client
          .from("inbound_engagements")
          .select("id")
          .eq("platform", engagement.platform)
          .eq("external_id", engagement.externalId)
          .single();
        if (raceError) throw new Error(`upsertIfNew race-recovery select failed: ${raceError.message}`);
        return { id: raceRow.id as string, created: false };
      }
      throw new Error(`upsertIfNew insert failed: ${error.message}`);
    }
    return { id: data.id as string, created: true };
  }

  async countPriorFromAuthor(platform: string, authorExternalId: string): Promise<number> {
    const { count, error } = await this.client
      .from("inbound_engagements")
      .select("id", { count: "exact", head: true })
      .eq("platform", platform)
      .eq("author_external_id", authorExternalId);
    if (error) throw new Error(`countPriorFromAuthor failed: ${error.message}`);
    return count ?? 0;
  }

  async findLatestInConversation(conversationId: string): Promise<InboundEngagement | null> {
    const { data, error } = await this.client
      .from("inbound_engagements")
      .select()
      .eq("conversation_id", conversationId)
      .order("observed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`findLatestInConversation failed: ${error.message}`);
    return data ? fromRow(data) : null;
  }

  async listByStatus(statuses: InboundStatus[]): Promise<InboundEngagement[]> {
    const { data, error } = await this.client
      .from("inbound_engagements")
      .select()
      .in("status", statuses)
      .order("observed_at", { ascending: false });
    if (error) throw new Error(`listByStatus failed: ${error.message}`);
    return (data ?? []).map(fromRow);
  }

  async setInResponseToText(id: string, text: string): Promise<void> {
    const { error } = await this.client.from("inbound_engagements").update({ in_response_to_text: text }).eq("id", id);
    if (error) throw new Error(`setInResponseToText failed: ${error.message}`);
  }

  async getById(id: string): Promise<InboundEngagement | null> {
    const { data, error } = await this.client.from("inbound_engagements").select().eq("id", id).maybeSingle();
    if (error) throw new Error(`getById failed: ${error.message}`);
    return data ? fromRow(data) : null;
  }

  async updateStatus(
    id: string,
    status: InboundStatus,
    fields?: Partial<Pick<InboundEngagement, "draftResponse" | "draftUsesLink" | "respondedAt" | "respondedNote" | "finalResponse">>,
  ): Promise<void> {
    const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (fields?.draftResponse !== undefined) update.draft_response = fields.draftResponse;
    if (fields?.draftUsesLink !== undefined) update.draft_uses_link = fields.draftUsesLink;
    if (fields?.respondedAt !== undefined) update.responded_at = fields.respondedAt;
    if (fields?.respondedNote !== undefined) update.responded_note = fields.respondedNote;
    if (fields?.finalResponse !== undefined) update.final_response = fields.finalResponse;
    const { error } = await this.client.from("inbound_engagements").update(update).eq("id", id);
    if (error) throw new Error(`updateStatus failed: ${error.message}`);
  }
}
