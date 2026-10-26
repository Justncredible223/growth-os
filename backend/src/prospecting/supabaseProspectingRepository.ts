import type { WatchlistRow } from "./prospectingWatchlist.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DRAFT_OPTIONS_KEY, POSTED_STYLE_KEY, parseDraftOptions, type PostedStyle } from "./prospectingDraftOptions.js";
import { SCREENED_OUT_REASON, type NewProspectingCandidate, type ProspectingCandidate, type ProspectingRepository, type ProspectingStatus } from "./types.js";

/** The experiment's two fields live inside the existing score_breakdown JSON (no migration); this splits them back out. */
function splitBreakdown(raw: unknown): { scoreBreakdown: Record<string, string>; draftOptions: ProspectingCandidate["draftOptions"]; postedStyle: PostedStyle | null } {
  const all = (raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const draftOptions = parseDraftOptions(all[DRAFT_OPTIONS_KEY]);
  const posted = all[POSTED_STYLE_KEY];
  delete all[DRAFT_OPTIONS_KEY];
  delete all[POSTED_STYLE_KEY];
  const postedStyle = posted === "sharp" || posted === "helpful" || posted === "edited" || posted === "legacy" ? posted : null;
  return { scoreBreakdown: all as Record<string, string>, draftOptions, postedStyle };
}

function fromRow(data: Record<string, any>): ProspectingCandidate {
  const { scoreBreakdown, draftOptions, postedStyle } = splitBreakdown(data.score_breakdown);
  return {
    id: data.id,
    platform: data.platform,
    externalId: data.external_id,
    discoveryQuery: data.discovery_query,
    authorHandle: data.author_handle,
    authorExternalId: data.author_external_id,
    authorName: data.author_name,
    authorFollowerCount: data.author_follower_count,
    authorVerified: data.author_verified,
    postText: data.post_text,
    postUrl: data.post_url,
    postCreatedAt: data.post_created_at,
    publicMetrics: data.public_metrics ?? {},
    opportunityScore: Number(data.opportunity_score),
    scoreBreakdown,
    draftOptions,
    postedStyle,
    creatorCandidate: data.creator_candidate,
    status: data.status,
    shownAt: data.shown_at,
    openedAt: data.opened_at,
    draftReply: data.draft_reply,
    finalReply: data.final_reply,
    replyMentionsFillbook: data.reply_mentions_fillbook,
    replyUsedLink: data.reply_used_link,
    repliedAt: data.replied_at,
    skipReason: data.skip_reason,
    discoveredAt: data.discovered_at,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

export class SupabaseProspectingRepository implements ProspectingRepository {
  constructor(private client: SupabaseClient) {}

  async upsertIfNew(candidate: NewProspectingCandidate): Promise<{ id: string; created: boolean }> {
    const { data: existing, error: selectError } = await this.client
      .from("prospecting_candidates")
      .select("id")
      .eq("platform", candidate.platform)
      .eq("external_id", candidate.externalId)
      .maybeSingle();
    if (selectError) throw new Error(`upsertIfNew select failed: ${selectError.message}`);
    if (existing) return { id: existing.id as string, created: false };

    const { data, error } = await this.client
      .from("prospecting_candidates")
      .insert({
        platform: candidate.platform,
        external_id: candidate.externalId,
        discovery_query: candidate.discoveryQuery,
        author_handle: candidate.authorHandle,
        author_external_id: candidate.authorExternalId,
        author_name: candidate.authorName,
        author_follower_count: candidate.authorFollowerCount,
        author_verified: candidate.authorVerified,
        post_text: candidate.postText,
        post_url: candidate.postUrl,
        post_created_at: candidate.postCreatedAt,
        public_metrics: candidate.publicMetrics,
        opportunity_score: candidate.opportunityScore,
        score_breakdown: candidate.scoreBreakdown,
        creator_candidate: candidate.creatorCandidate,
        discovered_at: candidate.discoveredAt,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        const { data: raceRow, error: raceError } = await this.client
          .from("prospecting_candidates")
          .select("id")
          .eq("platform", candidate.platform)
          .eq("external_id", candidate.externalId)
          .single();
        if (raceError) throw new Error(`upsertIfNew race-recovery select failed: ${raceError.message}`);
        return { id: raceRow.id as string, created: false };
      }
      throw new Error(`upsertIfNew insert failed: ${error.message}`);
    }
    return { id: data.id as string, created: true };
  }

  async listRepliedSince(since: Date): Promise<ProspectingCandidate[]> {
    const { data, error } = await this.client
      .from("prospecting_candidates")
      .select()
      .eq("status", "replied")
      .gte("replied_at", since.toISOString())
      .order("replied_at", { ascending: false });
    if (error) throw new Error(`listRepliedSince failed: ${error.message}`);
    return (data ?? []).map(fromRow);
  }

  async listWatchlistRows(since: Date): Promise<WatchlistRow[]> {
    const { data, error } = await this.client
      .from("prospecting_candidates")
      .select("author_handle, author_follower_count, status, opportunity_score")
      .gte("discovered_at", since.toISOString())
      .not("author_handle", "is", null)
      .order("discovered_at", { ascending: false })
      .limit(2000);
    if (error) throw new Error(`listWatchlistRows failed: ${error.message}`);
    return (data ?? []).map((r) => ({
      authorHandle: (r.author_handle as string | null) ?? null,
      authorFollowerCount: (r.author_follower_count as number | null) ?? null,
      status: String(r.status ?? ""),
      opportunityScore: Number(r.opportunity_score ?? 0),
    }));
  }

  async listScreenedOut(since: Date, limit: number): Promise<ProspectingCandidate[]> {
    const { data, error } = await this.client
      .from("prospecting_candidates")
      .select()
      .eq("status", "not_relevant")
      .eq("skip_reason", SCREENED_OUT_REASON)
      .gte("updated_at", since.toISOString())
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`listScreenedOut failed: ${error.message}`);
    return (data ?? []).map(fromRow);
  }

  async listByStatus(statuses: ProspectingStatus[], limit = 50): Promise<ProspectingCandidate[]> {
    const { data, error } = await this.client
      .from("prospecting_candidates")
      .select()
      .in("status", statuses)
      .order("opportunity_score", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`listByStatus failed: ${error.message}`);
    return (data ?? []).map(fromRow);
  }

  async getById(id: string): Promise<ProspectingCandidate | null> {
    const { data, error } = await this.client.from("prospecting_candidates").select().eq("id", id).maybeSingle();
    if (error) throw new Error(`getById failed: ${error.message}`);
    return data ? fromRow(data) : null;
  }

  async markShown(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.client
      .from("prospecting_candidates")
      .update({ status: "shown", shown_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .in("id", ids)
      .eq("status", "new");
    if (error) throw new Error(`markShown failed: ${error.message}`);
  }

  async updateStatus(
    id: string,
    status: ProspectingStatus,
    fields?: Partial<
      Pick<
        ProspectingCandidate,
        "openedAt" | "draftReply" | "draftOptions" | "postedStyle" | "finalReply" | "replyMentionsFillbook" | "replyUsedLink" | "repliedAt" | "skipReason"
      >
    > & { breakdownPatch?: Record<string, string> },
  ): Promise<void> {
    const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (fields?.openedAt !== undefined) update.opened_at = fields.openedAt;
    if (fields?.draftReply !== undefined) update.draft_reply = fields.draftReply;
    if (fields?.finalReply !== undefined) update.final_reply = fields.finalReply;
    if (fields?.replyMentionsFillbook !== undefined) update.reply_mentions_fillbook = fields.replyMentionsFillbook;
    if (fields?.replyUsedLink !== undefined) update.reply_used_link = fields.replyUsedLink;
    if (fields?.repliedAt !== undefined) update.replied_at = fields.repliedAt;
    if (fields?.skipReason !== undefined) update.skip_reason = fields.skipReason;
    if (fields?.draftOptions !== undefined || fields?.postedStyle !== undefined || fields?.breakdownPatch !== undefined) {
      // Merge into the existing score_breakdown JSON so the scoring keys survive.
      const { data: current, error: readError } = await this.client.from("prospecting_candidates").select("score_breakdown").eq("id", id).maybeSingle();
      if (readError) throw new Error(`updateStatus breakdown read failed: ${readError.message}`);
      const merged: Record<string, unknown> = { ...((current?.score_breakdown as Record<string, unknown> | null) ?? {}) };
      if (fields.draftOptions !== undefined) merged[DRAFT_OPTIONS_KEY] = fields.draftOptions === null ? undefined : JSON.stringify(fields.draftOptions);
      if (fields.postedStyle !== undefined) merged[POSTED_STYLE_KEY] = fields.postedStyle === null ? undefined : fields.postedStyle;
      if (fields.breakdownPatch !== undefined) Object.assign(merged, fields.breakdownPatch);
      update.score_breakdown = merged;
    }
    const { error } = await this.client.from("prospecting_candidates").update(update).eq("id", id);
    if (error) throw new Error(`updateStatus failed: ${error.message}`);
  }

  async hasPriorOutreach(platform: string, authorExternalId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("prospecting_outreach")
      .select("id")
      .eq("platform", platform)
      .eq("author_external_id", authorExternalId)
      .maybeSingle();
    if (error) throw new Error(`hasPriorOutreach failed: ${error.message}`);
    return data !== null;
  }

  async recordOutreach(platform: string, authorExternalId: string, authorHandle: string | null): Promise<void> {
    const { data: existing, error: selectError } = await this.client
      .from("prospecting_outreach")
      .select("id, reply_count")
      .eq("platform", platform)
      .eq("author_external_id", authorExternalId)
      .maybeSingle();
    if (selectError) throw new Error(`recordOutreach select failed: ${selectError.message}`);

    const now = new Date().toISOString();
    if (existing) {
      const { error } = await this.client
        .from("prospecting_outreach")
        .update({ last_replied_at: now, reply_count: (existing.reply_count as number) + 1 })
        .eq("id", existing.id);
      if (error) throw new Error(`recordOutreach update failed: ${error.message}`);
      return;
    }
    const { error } = await this.client.from("prospecting_outreach").insert({
      platform,
      author_external_id: authorExternalId,
      author_handle: authorHandle,
      first_replied_at: now,
      last_replied_at: now,
      reply_count: 1,
    });
    // A unique-constraint race here just means another request recorded the
    // same outreach a moment earlier -- not a real failure.
    if (error && error.code !== "23505") throw new Error(`recordOutreach insert failed: ${error.message}`);
  }

  async expireStale(olderThan: Date): Promise<number> {
    const { data, error } = await this.client
      .from("prospecting_candidates")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .in("status", ["new", "shown", "drafting", "ready"])
      .lt("discovered_at", olderThan.toISOString())
      .select("id");
    if (error) throw new Error(`expireStale failed: ${error.message}`);
    return (data ?? []).length;
  }
}
