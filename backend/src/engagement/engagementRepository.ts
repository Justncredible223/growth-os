import type { SupabaseClient } from "@supabase/supabase-js";
import { YOUTUBE_CACHE_MAX_AGE_DAYS, pacificDayKey, type PriorDoneAction } from "./policy.js";
import type {
  EngagementActionKind,
  EngagementActionRow,
  EngagementDid,
  EngagementDraft,
  EngagementItem,
  EngagementItemSource,
  EngagementItemStatus,
  EngagementPlatform,
  VideoMetadata,
  WatchlistEntry,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** True for the error Supabase returns before migration 0050 is applied (the tables do not exist yet). */
export function isMissingEngagementTables(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /engagement_(watchlist|items|actions|quota_ledger)/.test(message) && /(does not exist|schema cache|PGRST205|42P01)/i.test(message);
}

type Row = Record<string, any>;

function fail(what: string, error: { message: string }): never {
  throw new Error(`Engagement: ${what} failed: ${error.message}`);
}

export function itemFromRow(row: Row): EngagementItem {
  return {
    id: row.id,
    platform: row.platform,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    thumbnailUrl: row.thumbnail_url ?? null,
    description: row.description ?? null,
    topComments: Array.isArray(row.top_comments) ? row.top_comments : [],
    stats: row.stats ?? null,
    source: row.source,
    status: row.status,
    drafts: Array.isArray(row.drafts) ? row.drafts : [],
    skipReason: row.skip_reason ?? null,
    fetchedAt: row.fetched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function actionFromRow(row: Row): EngagementActionRow {
  return {
    id: row.id,
    itemId: row.item_id ?? null,
    platform: row.platform,
    externalId: row.external_id,
    creatorId: row.creator_id,
    creatorName: row.creator_name ?? null,
    kind: row.kind,
    did: row.did ?? null,
    draftId: row.draft_id ?? null,
    draftText: row.draft_text ?? null,
    finalText: row.final_text ?? null,
    gotReply: row.got_reply ?? null,
    profileVisits: row.profile_visits ?? null,
    outcomeNote: row.outcome_note ?? null,
    createdAt: row.created_at,
  };
}

// ---- items -------------------------------------------------------------------------------------------------

export async function getItem(client: SupabaseClient, id: string): Promise<EngagementItem | null> {
  const { data, error } = await client.from("engagement_items").select("*").eq("id", id).maybeSingle();
  if (error) fail("item lookup", error);
  return data ? itemFromRow(data as Row) : null;
}

export async function findItemByVideo(client: SupabaseClient, platform: EngagementPlatform, externalId: string): Promise<EngagementItem | null> {
  const { data, error } = await client.from("engagement_items").select("*").eq("platform", platform).eq("external_id", externalId).maybeSingle();
  if (error) fail("item lookup", error);
  return data ? itemFromRow(data as Row) : null;
}

export async function insertItem(client: SupabaseClient, meta: VideoMetadata, source: EngagementItemSource, now: Date): Promise<EngagementItem> {
  const iso = now.toISOString();
  const { data, error } = await client
    .from("engagement_items")
    .insert({
      platform: meta.platform,
      external_id: meta.externalId,
      url: meta.url,
      title: meta.title,
      creator_id: meta.creatorId,
      creator_name: meta.creatorName,
      thumbnail_url: meta.thumbnailUrl,
      description: meta.description,
      stats: meta.stats,
      source,
      status: "new",
      fetched_at: iso,
      created_at: iso,
      updated_at: iso,
    })
    .select()
    .single();
  if (error) fail("item insert", error);
  return itemFromRow(data as Row);
}

export async function listQueue(client: SupabaseClient, limit = 60): Promise<EngagementItem[]> {
  const { data, error } = await client
    .from("engagement_items")
    .select("*")
    .in("status", ["new", "drafted"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) fail("queue lookup", error);
  return ((data ?? []) as Row[]).map(itemFromRow);
}

export async function countPending(client: SupabaseClient): Promise<number> {
  return (await listQueue(client, 500)).length;
}

export async function updateItem(client: SupabaseClient, id: string, patch: Partial<{ status: EngagementItemStatus; drafts: EngagementDraft[]; topComments: string[]; skipReason: string | null }>, now: Date): Promise<void> {
  const row: Row = { updated_at: now.toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.drafts !== undefined) row.drafts = patch.drafts;
  if (patch.topComments !== undefined) row.top_comments = patch.topComments;
  if (patch.skipReason !== undefined) row.skip_reason = patch.skipReason;
  const { error } = await client.from("engagement_items").update(row).eq("id", id);
  if (error) fail("item update", error);
}

// ---- actions (audit log) -----------------------------------------------------------------------------------

export interface NewAction {
  itemId: string | null;
  platform: EngagementPlatform;
  externalId: string;
  creatorId: string;
  creatorName: string | null;
  kind: EngagementActionKind;
  did?: EngagementDid | null;
  draftId?: string | null;
  draftText?: string | null;
  finalText?: string | null;
}

export async function recordAction(client: SupabaseClient, action: NewAction, now: Date): Promise<EngagementActionRow> {
  const { data, error } = await client
    .from("engagement_actions")
    .insert({
      item_id: action.itemId,
      platform: action.platform,
      external_id: action.externalId,
      creator_id: action.creatorId,
      creator_name: action.creatorName,
      kind: action.kind,
      did: action.did ?? null,
      draft_id: action.draftId ?? null,
      draft_text: action.draftText ?? null,
      final_text: action.finalText ?? null,
      created_at: now.toISOString(),
    })
    .select()
    .single();
  if (error) fail("audit log write", error);
  return actionFromRow(data as Row);
}

/** 'done' actions inside the longest window any guardrail looks at (the cooldown, at least 1 day). */
export async function loadRecentDoneActions(client: SupabaseClient, now: Date, windowDays: number): Promise<PriorDoneAction[]> {
  const since = new Date(now.getTime() - Math.max(windowDays, 1) * DAY_MS).toISOString();
  const { data, error } = await client
    .from("engagement_actions")
    .select("platform, creator_id, created_at")
    .eq("kind", "done")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) fail("recent actions lookup", error);
  return ((data ?? []) as Row[]).map((r) => ({ platform: r.platform, creatorId: r.creator_id, createdAt: r.created_at }));
}

/** True when the owner already marked this video done or skipped it, so discovery never resurfaces it. */
export async function isVideoHandled(client: SupabaseClient, platform: EngagementPlatform, externalId: string): Promise<boolean> {
  const { data, error } = await client
    .from("engagement_actions")
    .select("id")
    .eq("platform", platform)
    .eq("external_id", externalId)
    .in("kind", ["done", "skipped"])
    .limit(1);
  if (error) fail("handled lookup", error);
  return ((data ?? []) as Row[]).length > 0;
}

/**
 * The last `limit` comment texts, newest first: every draft shown plus every text the owner posted, so a new draft
 * is compared against what has been written AND what has gone out.
 */
export async function loadRecentCommentTexts(client: SupabaseClient, limit: number): Promise<string[]> {
  const texts: Array<{ at: string; text: string }> = [];

  const { data: items, error: itemError } = await client
    .from("engagement_items")
    .select("drafts, updated_at")
    .in("status", ["drafted", "done", "skipped"])
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (itemError) fail("recent drafts lookup", itemError);
  for (const row of (items ?? []) as Row[]) {
    for (const d of Array.isArray(row.drafts) ? row.drafts : []) {
      if (d && typeof d.text === "string") texts.push({ at: row.updated_at, text: d.text });
    }
  }

  const { data: actions, error: actionError } = await client
    .from("engagement_actions")
    .select("final_text, created_at")
    .eq("kind", "done")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (actionError) fail("recent posted lookup", actionError);
  for (const row of (actions ?? []) as Row[]) {
    if (typeof row.final_text === "string" && row.final_text.length > 0) texts.push({ at: row.created_at, text: row.final_text });
  }

  return texts
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit)
    .map((t) => t.text);
}

export async function getAction(client: SupabaseClient, id: string): Promise<EngagementActionRow | null> {
  const { data, error } = await client.from("engagement_actions").select("*").eq("id", id).maybeSingle();
  if (error) fail("action lookup", error);
  return data ? actionFromRow(data as Row) : null;
}

export async function logOutcome(
  client: SupabaseClient,
  id: string,
  outcome: { gotReply: boolean | null; profileVisits: number | null; note: string | null },
  now: Date,
): Promise<void> {
  const { error } = await client
    .from("engagement_actions")
    .update({ got_reply: outcome.gotReply, profile_visits: outcome.profileVisits, outcome_note: outcome.note, outcome_logged_at: now.toISOString() })
    .eq("id", id);
  if (error) fail("outcome update", error);
}

export async function listActionsSince(client: SupabaseClient, sinceIso: string): Promise<EngagementActionRow[]> {
  const { data, error } = await client.from("engagement_actions").select("*").gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(5000);
  if (error) fail("stats lookup", error);
  return ((data ?? []) as Row[]).map(actionFromRow);
}

// ---- watchlist ----------------------------------------------------------------------------------------------

function watchFromRow(row: Row): WatchlistEntry {
  return { id: row.id, kind: row.kind, value: row.value, label: row.label ?? null, active: row.active !== false, createdAt: row.created_at };
}

export async function listWatchlist(client: SupabaseClient): Promise<WatchlistEntry[]> {
  const { data, error } = await client.from("engagement_watchlist").select("*").order("created_at", { ascending: true }).limit(200);
  if (error) fail("watchlist lookup", error);
  return ((data ?? []) as Row[]).map(watchFromRow);
}

export async function addWatchlistEntry(client: SupabaseClient, kind: "channel" | "query", value: string, label: string | null, now: Date): Promise<WatchlistEntry> {
  const { data: existing, error: lookupError } = await client.from("engagement_watchlist").select("*").eq("kind", kind).eq("value", value).maybeSingle();
  if (lookupError) fail("watchlist lookup", lookupError);
  if (existing) {
    const { error } = await client.from("engagement_watchlist").update({ active: true, label }).eq("id", (existing as Row).id);
    if (error) fail("watchlist update", error);
    return watchFromRow({ ...(existing as Row), active: true, label });
  }
  const { data, error } = await client.from("engagement_watchlist").insert({ kind, value, label, active: true, created_at: now.toISOString() }).select().single();
  if (error) fail("watchlist insert", error);
  return watchFromRow(data as Row);
}

export async function removeWatchlistEntry(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("engagement_watchlist").delete().eq("id", id);
  if (error) fail("watchlist delete", error);
}

// ---- quota ledger -------------------------------------------------------------------------------------------

export async function quotaUsedToday(client: SupabaseClient, now: Date): Promise<number> {
  const { data, error } = await client.from("engagement_quota_ledger").select("units").eq("day", pacificDayKey(now));
  if (error) fail("quota lookup", error);
  return ((data ?? []) as Row[]).reduce((sum, r) => sum + Number(r.units ?? 0), 0);
}

export async function recordQuotaUnits(client: SupabaseClient, endpoint: string, units: number, now: Date): Promise<void> {
  const { error } = await client.from("engagement_quota_ledger").insert({ day: pacificDayKey(now), endpoint, units, created_at: now.toISOString() });
  if (error) fail("quota write", error);
}

// ---- retention ----------------------------------------------------------------------------------------------

/**
 * YouTube API Developer Policies: cached API data may not be kept past 30 days without a refresh. Deletes queue rows
 * (metadata, statistics, comment snippets) older than that, drops the creator names kept on old YouTube audit rows
 * (the ids, the owner's own text and timestamps stay), and trims the quota ledger.
 */
export async function purgeStaleCache(client: SupabaseClient, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - YOUTUBE_CACHE_MAX_AGE_DAYS * DAY_MS).toISOString();
  const items = await client.from("engagement_items").delete().eq("platform", "youtube").lt("fetched_at", cutoff);
  if (items.error) fail("cache purge", items.error);
  const names = await client.from("engagement_actions").update({ creator_name: null }).eq("platform", "youtube").lt("created_at", cutoff);
  if (names.error) fail("audit name purge", names.error);
  const ledger = await client.from("engagement_quota_ledger").delete().lt("created_at", cutoff);
  if (ledger.error) fail("ledger purge", ledger.error);
}
