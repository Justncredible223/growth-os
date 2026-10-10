import type { SupabaseClient } from "@supabase/supabase-js";
import { createLlmClient, type LlmClient } from "../content/llmClient.js";
import { draftWithRetries } from "../content/xReplyGuardrails.js";
import { recordCostEvent } from "../cost/costTracking.js";
import { authorizeLiveHostSpeechAndAudit, LiveHostSpeechRejectedError, type AuditSink } from "../firewall/externalWriteFirewall.js";
import { loadGroundingContext } from "../inbound/inboundHandlers.js";
import { BrandConstitution } from "../knowledge/brandConstitution.js";
import { SupabaseBrandConstitutionRepository } from "../knowledge/supabaseRepositories.js";
import { errorMessage } from "../lib/errorMessage.js";
import { createYoutubeLiveChatAdapter, type YoutubeLiveChatAdapter } from "../signals/adapters/youtubeLiveChatAdapter.js";
import { FALLBACK_AUTHOR_NAME, checkSpokenLine, mentionsFillbook, safeAuthorName, screenIncomingMessage } from "./liveHostGuardrails.js";
import { LIVE_HOST_NAME, LIVE_HOST_SEGMENTS, nextSegment } from "./liveHostPersona.js";
import { draftLiveLine, type ChatMessageForDraft, type LiveHostGrounding, type LiveLineDraft, type RecentExchange } from "./liveHostWriter.js";
import type {
  IncomingChatMessage,
  LiveHostCard,
  LiveHostMessage,
  LiveHostMood,
  LiveHostSession,
  LiveHostSettings,
  LiveHostUtterance,
} from "./types.js";

export class LiveHostActionError extends Error {}

/** The worker is shown as offline when its last tick is older than this. It ticks every few seconds while running. */
export const WORKER_OFFLINE_AFTER_MS = 45_000;
/** A session whose worker has been silent this long is closed, so a crashed worker never leaves a "live" session behind. */
export const SESSION_ABANDONED_AFTER_MS = 5 * 60_000;
/** Chat messages answered together in one spoken line. */
export const MAX_MESSAGES_PER_LINE = 3;
/** A message nobody got to within this long is skipped: answering it later reads as a non sequitur. */
export const MESSAGE_STALE_AFTER_MS = 90_000;
/** With more than this many waiting, the host answers the newest and lets the rest go, instead of always replying to chat from minutes ago. */
export const BACKLOG_LIMIT = 6;
/** Fillbook may be mentioned in at most this many of the last PROMO_WINDOW lines, unless a viewer asks. */
export const PROMO_MAX_MENTIONS = 1;
export const PROMO_WINDOW = 6;
/** The explicit "what Fillbook is" segment runs at most this often, and never in a session's first minutes. */
export const FILLBOOK_SPOT_EVERY_MS = 12 * 60_000;
export const FILLBOOK_SPOT_NOT_BEFORE_MS = 4 * 60_000;
/** Welcomes for viewers who just joined are spaced at least this far apart, so arrivals never crowd out the show. */
export const JOIN_WELCOME_EVERY_MS = 40_000;
/** Names said in one welcome; anyone beyond that is welcomed as "and N more". */
export const JOIN_WELCOME_MAX_NAMES = 3;
export const JOIN_WELCOME_SEGMENT = "join_welcome";
const JOIN_WELCOME_TITLE = "New Arrivals";
/** Most messages taken from the worker in one tick; a flood is trimmed, newest kept. */
const MAX_INCOMING_PER_TICK = 40;
const RECENT_EXCHANGES = 12;
const FEED_LIMIT = 60;

/** The cost_events context tag every Live Host model call is recorded under. */
export const LIVE_HOST_COST_ENDPOINT = "live-host-line";

/**
 * What the Live Host itself has spent today (UTC day). The daily budget is the host's own: the rest of Growth OS
 * (campaign runs, drafts, research) has its own limits, and a busy day there must not silence a stream.
 */
export async function getLiveHostSpendTodayUsd(client: SupabaseClient, now: Date = new Date()): Promise<number> {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const { data, error } = await client.from("cost_events").select("cost_usd, context").gte("created_at", startOfToday);
  if (error) throw new Error(`getLiveHostSpendTodayUsd failed: ${error.message}`);
  return ((data ?? []) as Array<{ cost_usd: number | null; context: { endpoint?: unknown } | null }>)
    .filter((row) => row.context?.endpoint === LIVE_HOST_COST_ENDPOINT)
    .reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
}

const TABLES = /(live_host_settings|live_host_sessions|live_host_messages|live_host_utterances)/;
/** True for the error Supabase returns before migration 0049 is applied. */
export function isMissingLiveHostTables(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TABLES.test(message) && /(does not exist|schema cache|PGRST205|42P01)/i.test(message);
}

interface SettingsRow {
  desired_state: "on" | "off";
  youtube_video_id: string | null;
  tiktok_chat_enabled: boolean;
  tiktok_username: string | null;
  idle_seconds: number;
  daily_budget_usd: number | string;
  updated_at: string;
}
interface SessionRow {
  id: string;
  status: "live" | "ended";
  started_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  last_heartbeat_at: string;
  youtube_live_chat_id: string | null;
  youtube_page_token: string | null;
  youtube_next_poll_at: string | null;
  last_utterance_at: string | null;
  last_segment: string | null;
}
interface MessageRow {
  id: string;
  session_id: string;
  platform: "youtube" | "tiktok";
  external_id: string;
  author_name: string;
  body: string;
  received_at: string;
  status: LiveHostMessage["status"];
  status_reason: string | null;
  utterance_id: string | null;
}
interface UtteranceRow {
  id: string;
  session_id: string;
  kind: "reply" | "segment";
  segment: string | null;
  spoken_text: string;
  mood: string;
  card: LiveHostCard | null;
  mentions_fillbook: boolean;
  status: LiveHostUtterance["status"];
  created_at: string;
  spoken_at: string | null;
}

function toSettings(row: SettingsRow): LiveHostSettings {
  return {
    desiredState: row.desired_state,
    youtubeVideoId: row.youtube_video_id,
    tiktokChatEnabled: row.tiktok_chat_enabled,
    tiktokUsername: row.tiktok_username,
    idleSeconds: row.idle_seconds,
    dailyBudgetUsd: Number(row.daily_budget_usd),
    updatedAt: row.updated_at,
  };
}
function toSession(row: SessionRow): LiveHostSession {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endedReason: row.ended_reason,
    lastHeartbeatAt: row.last_heartbeat_at,
    youtubeLiveChatId: row.youtube_live_chat_id,
    youtubePageToken: row.youtube_page_token,
    youtubeNextPollAt: row.youtube_next_poll_at,
    lastUtteranceAt: row.last_utterance_at,
    lastSegment: row.last_segment,
  };
}
function toMessage(row: MessageRow): LiveHostMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    platform: row.platform,
    externalId: row.external_id,
    authorName: row.author_name,
    body: row.body,
    receivedAt: row.received_at,
    status: row.status,
    statusReason: row.status_reason,
    utteranceId: row.utterance_id,
  };
}
function toUtterance(row: UtteranceRow): LiveHostUtterance {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    segment: row.segment,
    spokenText: row.spoken_text,
    mood: row.mood as LiveHostMood,
    card: row.card,
    mentionsFillbook: row.mentions_fillbook,
    status: row.status,
    createdAt: row.created_at,
    spokenAt: row.spoken_at,
  };
}

async function loadSettings(client: SupabaseClient): Promise<LiveHostSettings> {
  const { data, error } = await client.from("live_host_settings").select("*").eq("id", true).maybeSingle();
  if (error) throw new Error(`load live_host_settings failed: ${error.message}`);
  if (!data) throw new Error("live_host_settings has no row (relation live_host_settings does not exist or migration 0049 was not applied)");
  return toSettings(data as SettingsRow);
}

async function loadSystemPaused(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client.from("system_settings").select("paused").eq("id", true).maybeSingle();
  // Fail closed: if the pause flag cannot be read, behave as paused. The host staying quiet is always safe.
  if (error) return true;
  return (data as { paused?: boolean } | null)?.paused ?? false;
}

async function loadLiveSession(client: SupabaseClient): Promise<LiveHostSession | null> {
  const { data, error } = await client.from("live_host_sessions").select("*").eq("status", "live").order("started_at", { ascending: false }).limit(1);
  if (error) throw new Error(`load live_host_sessions failed: ${error.message}`);
  const row = ((data ?? []) as SessionRow[])[0];
  return row ? toSession(row) : null;
}

async function endSession(client: SupabaseClient, sessionId: string, reason: string, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const { error } = await client.from("live_host_sessions").update({ status: "ended", ended_at: nowIso, ended_reason: reason }).eq("id", sessionId);
  if (error) throw new Error(`end live_host_sessions failed: ${error.message}`);
  // Nothing queued may be spoken after the session ends.
  await client.from("live_host_utterances").update({ status: "dropped" }).eq("session_id", sessionId).eq("status", "queued");
  await client.from("live_host_messages").update({ status: "skipped", status_reason: "stream ended" }).eq("session_id", sessionId).eq("status", "pending");
}

function supabaseAuditSink(client: SupabaseClient): AuditSink {
  return async (record) => {
    // Best effort, like the other sinks: before migration 0049 the class is not in the check constraint yet, and
    // live_host_utterances is itself the full record of what was said.
    await client.from("audit_logs").insert({
      action_name: record.actionName,
      action_class: record.actionClass,
      outcome: record.outcome,
      reason: record.reason,
      context: record.context,
      created_at: record.timestamp,
    });
  };
}

// ---------------------------------------------------------------------------
// Owner actions (app token only)
// ---------------------------------------------------------------------------

/** The owner's switch. Turning it off ends the live session at once, so the firewall stops allowing speech before the worker even hears about it. */
export async function setLiveHostDesiredState(client: SupabaseClient, desired: "on" | "off", now: Date = new Date()): Promise<LiveHostSettings> {
  const { error } = await client.from("live_host_settings").update({ desired_state: desired, updated_at: now.toISOString() }).eq("id", true);
  if (error) throw new Error(`update live_host_settings failed: ${error.message}`);
  if (desired === "off") {
    const session = await loadLiveSession(client);
    if (session) await endSession(client, session.id, "switched off by owner", now);
  }
  return loadSettings(client);
}

export interface LiveHostSettingsPatch {
  youtubeVideoId?: string | null;
  tiktokChatEnabled?: boolean;
  tiktokUsername?: string | null;
  idleSeconds?: number;
  dailyBudgetUsd?: number;
}

/** Accepts a bare id or any common YouTube URL (watch?v=, youtu.be/, /live/, /shorts/). Null when nothing id-shaped is found. */
export function parseYoutubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const match = /(?:[?&]v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(trimmed);
  return match?.[1] ?? null;
}

export async function updateLiveHostSettings(client: SupabaseClient, patch: LiveHostSettingsPatch, now: Date = new Date()): Promise<LiveHostSettings> {
  const update: Record<string, unknown> = { updated_at: now.toISOString() };
  if (patch.youtubeVideoId !== undefined) {
    if (patch.youtubeVideoId === null || patch.youtubeVideoId.trim() === "") {
      update.youtube_video_id = null;
    } else {
      const id = parseYoutubeVideoId(patch.youtubeVideoId);
      if (!id) throw new LiveHostActionError("That does not look like a YouTube video link or id.");
      update.youtube_video_id = id;
    }
  }
  if (patch.tiktokChatEnabled !== undefined) update.tiktok_chat_enabled = patch.tiktokChatEnabled === true;
  if (patch.tiktokUsername !== undefined) {
    const username = patch.tiktokUsername?.trim().replace(/^@/, "") ?? "";
    if (username && !/^[A-Za-z0-9._]{2,24}$/.test(username)) throw new LiveHostActionError("That does not look like a TikTok username.");
    update.tiktok_username = username || null;
  }
  if (patch.idleSeconds !== undefined) {
    if (!Number.isInteger(patch.idleSeconds) || patch.idleSeconds < 15 || patch.idleSeconds > 600) throw new LiveHostActionError("Quiet time must be between 15 and 600 seconds.");
    update.idle_seconds = patch.idleSeconds;
  }
  if (patch.dailyBudgetUsd !== undefined) {
    if (!Number.isFinite(patch.dailyBudgetUsd) || patch.dailyBudgetUsd < 0 || patch.dailyBudgetUsd > 100) throw new LiveHostActionError("Daily budget must be between 0 and 100 dollars.");
    update.daily_budget_usd = patch.dailyBudgetUsd;
  }
  const { error } = await client.from("live_host_settings").update(update).eq("id", true);
  if (error) throw new Error(`update live_host_settings failed: ${error.message}`);
  // A different video means a different chat: forget the old chat id and page position.
  if (update.youtube_video_id !== undefined) {
    await client.from("live_host_sessions").update({ youtube_live_chat_id: null, youtube_page_token: null, youtube_next_poll_at: null }).eq("status", "live");
  }
  return loadSettings(client);
}

// ---------------------------------------------------------------------------
// Status (what the Live Host tab shows)
// ---------------------------------------------------------------------------

export interface LiveHostFeedItem {
  type: "message" | "utterance";
  id: string;
  at: string;
  platform: string | null;
  authorName: string | null;
  text: string;
  status: string;
  statusReason: string | null;
  kind: string | null;
  segment: string | null;
  mentionsFillbook: boolean;
}

export interface LiveHostStatus {
  /** False until migration 0049 is applied. */
  configured: boolean;
  hostName: string;
  settings: LiveHostSettings | null;
  systemPaused: boolean;
  session: {
    id: string;
    startedAt: string;
    lastHeartbeatAt: string;
    workerOnline: boolean;
    messagesSeen: number;
    messagesAnswered: number;
    messagesPending: number;
    messagesBlocked: number;
    linesSpoken: number;
    fillbookMentions: number;
  } | null;
  lastSession: { id: string; startedAt: string; endedAt: string | null; endedReason: string | null } | null;
  todaySpendUsd: number;
  budgetReached: boolean;
  /** Newest first: chat messages and the host's lines, interleaved. */
  feed: LiveHostFeedItem[];
}

export async function getLiveHostStatus(client: SupabaseClient, now: Date = new Date()): Promise<LiveHostStatus> {
  let settings: LiveHostSettings;
  try {
    settings = await loadSettings(client);
  } catch (err) {
    if (isMissingLiveHostTables(err)) {
      return { configured: false, hostName: LIVE_HOST_NAME, settings: null, systemPaused: false, session: null, lastSession: null, todaySpendUsd: 0, budgetReached: false, feed: [] };
    }
    throw err;
  }
  const [systemPaused, live, todaySpendUsd] = await Promise.all([loadSystemPaused(client), loadLiveSession(client), getLiveHostSpendTodayUsd(client, now)]);

  let feedSessionId = live?.id ?? null;
  let lastSession: LiveHostStatus["lastSession"] = null;
  if (!live) {
    const { data } = await client.from("live_host_sessions").select("id, started_at, ended_at, ended_reason").eq("status", "ended").order("started_at", { ascending: false }).limit(1);
    const row = ((data ?? []) as Array<{ id: string; started_at: string; ended_at: string | null; ended_reason: string | null }>)[0];
    if (row) {
      lastSession = { id: row.id, startedAt: row.started_at, endedAt: row.ended_at, endedReason: row.ended_reason };
      feedSessionId = row.id;
    }
  }

  let messages: LiveHostMessage[] = [];
  let utterances: LiveHostUtterance[] = [];
  if (feedSessionId) {
    const [messageResult, utteranceResult] = await Promise.all([
      client.from("live_host_messages").select("*").eq("session_id", feedSessionId).order("received_at", { ascending: false }).limit(500),
      client.from("live_host_utterances").select("*").eq("session_id", feedSessionId).order("created_at", { ascending: false }).limit(500),
    ]);
    if (messageResult.error) throw new Error(`load live_host_messages failed: ${messageResult.error.message}`);
    if (utteranceResult.error) throw new Error(`load live_host_utterances failed: ${utteranceResult.error.message}`);
    messages = ((messageResult.data ?? []) as MessageRow[]).map(toMessage);
    utterances = ((utteranceResult.data ?? []) as UtteranceRow[]).map(toUtterance);
  }

  const feed: LiveHostFeedItem[] = [
    ...messages.map<LiveHostFeedItem>((m) => ({
      type: "message",
      id: m.id,
      at: m.receivedAt,
      platform: m.platform,
      authorName: m.authorName,
      text: m.body,
      status: m.status,
      statusReason: m.statusReason,
      kind: null,
      segment: null,
      mentionsFillbook: false,
    })),
    ...utterances.map<LiveHostFeedItem>((u) => ({
      type: "utterance",
      id: u.id,
      at: u.spokenAt ?? u.createdAt,
      platform: null,
      authorName: LIVE_HOST_NAME,
      text: u.spokenText,
      status: u.status,
      statusReason: null,
      kind: u.kind,
      segment: u.segment,
      mentionsFillbook: u.mentionsFillbook,
    })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, FEED_LIMIT);

  const spoken = utterances.filter((u) => u.status === "spoken");
  return {
    configured: true,
    hostName: LIVE_HOST_NAME,
    settings,
    systemPaused,
    session: live
      ? {
          id: live.id,
          startedAt: live.startedAt,
          lastHeartbeatAt: live.lastHeartbeatAt,
          workerOnline: now.getTime() - new Date(live.lastHeartbeatAt).getTime() < WORKER_OFFLINE_AFTER_MS,
          messagesSeen: messages.length,
          messagesAnswered: messages.filter((m) => m.status === "answered").length,
          messagesPending: messages.filter((m) => m.status === "pending").length,
          messagesBlocked: messages.filter((m) => m.status === "blocked").length,
          linesSpoken: spoken.length,
          fillbookMentions: spoken.filter((u) => u.mentionsFillbook).length,
        }
      : null,
    lastSession,
    todaySpendUsd,
    budgetReached: settings.dailyBudgetUsd > 0 ? todaySpendUsd >= settings.dailyBudgetUsd : true,
    feed,
  };
}

// ---------------------------------------------------------------------------
// Worker tick
// ---------------------------------------------------------------------------

export interface TickInput {
  /** Chat the worker read itself (TikTok). YouTube chat is read here on the server. */
  messages?: IncomingChatMessage[];
  /** True while the worker is still speaking the previous line: ingest chat, but do not draft another yet. */
  busy?: boolean;
  /**
   * Where the worker is streaming. The website is only said out loud when this is "youtube" and TikTok chat is
   * off; anything else (TikTok, both, or not stated) points to the link in the bio, because TikTok treats
   * directing viewers off-platform as a LIVE violation.
   */
  platform?: string;
  workerInfo?: Record<string, unknown>;
  /**
   * Viewers who joined since the worker last had a welcome confirmed (TikTok only: YouTube does not say who
   * joins). Raw display names; they are cleaned here before anything is said. Never stored.
   */
  joins?: Array<{ name?: unknown }>;
}

export interface TickUtterance {
  id: string;
  kind: "reply" | "segment";
  segmentTitle: string | null;
  spokenText: string;
  mood: LiveHostMood;
  tiltLevel: number | null;
  card: LiveHostCard | null;
  /** The chat messages this line answers, for the on-screen chat bubble. Names and text are already cleaned. */
  replyingTo: Array<{ platform: string; authorName: string; body: string }>;
}

export interface TickResult {
  /** What the worker should be doing. "off" means stop streaming and stay idle. */
  desired: "on" | "off";
  reason: string | null;
  sessionId: string | null;
  tiktok: { chatEnabled: boolean; username: string | null };
  /** The next line to speak, or null when there is nothing to say this tick. */
  utterance: TickUtterance | null;
  note: string | null;
  /** True when the joins sent with this tick were used or deliberately dropped: the worker clears its list. */
  joinsWelcomed?: boolean;
}

export interface TickDeps {
  now?: Date;
  llmClient?: LlmClient;
  youtube?: YoutubeLiveChatAdapter | null;
  grounding?: LiveHostGrounding;
  auditSink?: AuditSink;
}

function offResult(settings: LiveHostSettings | null, reason: string): TickResult {
  return {
    desired: "off",
    reason,
    sessionId: null,
    tiktok: { chatEnabled: settings?.tiktokChatEnabled ?? false, username: settings?.tiktokUsername ?? null },
    utterance: null,
    note: null,
  };
}

async function storeIncoming(client: SupabaseClient, sessionId: string, incoming: IncomingChatMessage[], now: Date): Promise<void> {
  const batch = incoming
    .filter((m) => (m.platform === "youtube" || m.platform === "tiktok") && typeof m.externalId === "string" && m.externalId.length > 0 && typeof m.body === "string")
    .slice(-MAX_INCOMING_PER_TICK);
  if (batch.length === 0) return;

  const rows = batch.map((m) => {
    const screening = screenIncomingMessage(m.body);
    return {
      session_id: sessionId,
      platform: m.platform,
      external_id: m.externalId.slice(0, 200),
      // Only the cleaned name and text are ever stored, shown or spoken.
      author_name: safeAuthorName(typeof m.authorName === "string" ? m.authorName : ""),
      body: screening.cleanBody,
      received_at: m.receivedAt && !Number.isNaN(Date.parse(m.receivedAt)) ? new Date(m.receivedAt).toISOString() : now.toISOString(),
      status: screening.blockedReason ? "blocked" : "pending",
      status_reason: screening.blockedReason,
    };
  });

  // Skip ids already stored (a reconnecting reader replays recent chat). The unique index is the backstop.
  const { data: existing } = await client.from("live_host_messages").select("platform, external_id").in("external_id", rows.map((r) => r.external_id));
  const seen = new Set(((existing ?? []) as Array<{ platform: string; external_id: string }>).map((r) => `${r.platform}:${r.external_id}`));
  const fresh = rows.filter((r) => !seen.has(`${r.platform}:${r.external_id}`));
  if (fresh.length === 0) return;
  const { error } = await client.from("live_host_messages").upsert(fresh, { onConflict: "platform,external_id", ignoreDuplicates: true });
  if (error) throw new Error(`insert live_host_messages failed: ${error.message}`);
}

async function pollYoutubeChat(client: SupabaseClient, session: LiveHostSession, settings: LiveHostSettings, adapter: YoutubeLiveChatAdapter, now: Date): Promise<string | null> {
  if (!settings.youtubeVideoId) return null;
  if (session.youtubeNextPollAt && new Date(session.youtubeNextPollAt).getTime() > now.getTime()) return null;
  try {
    let chatId = session.youtubeLiveChatId;
    if (!chatId) {
      chatId = await adapter.resolveLiveChatId(settings.youtubeVideoId);
      if (!chatId) {
        // Not live yet (or chat is off). Look again in a while rather than on every tick.
        await client.from("live_host_sessions").update({ youtube_next_poll_at: new Date(now.getTime() + 30_000).toISOString() }).eq("id", session.id);
        return "YouTube chat is not available yet for that video";
      }
    }
    const firstPage = !session.youtubePageToken;
    const page = await adapter.fetchMessages(chatId, session.youtubePageToken ?? null);
    await client
      .from("live_host_sessions")
      .update({ youtube_live_chat_id: chatId, youtube_page_token: page.nextPageToken, youtube_next_poll_at: new Date(now.getTime() + page.pollAfterMs).toISOString() })
      .eq("id", session.id);
    // The first page is chat history from before the host started. Answering it would be answering the past.
    if (!firstPage) {
      await storeIncoming(
        client,
        session.id,
        page.messages.map((m) => ({ platform: "youtube" as const, externalId: m.id, authorName: m.authorDisplayName, body: m.text, receivedAt: m.publishedAt ?? undefined })),
        now,
      );
    }
    return null;
  } catch (err) {
    await client.from("live_host_sessions").update({ youtube_next_poll_at: new Date(now.getTime() + 60_000).toISOString() }).eq("id", session.id);
    return `YouTube chat read failed: ${errorMessage(err)}`;
  }
}

/** Viewer asked about the product, the site or what the stream is for: a Fillbook mention is the honest answer. */
export function viewerAskedAboutFillbook(body: string): boolean {
  return /fill-?book|\bjournal(?:ing|s)?\b|\bwhat (?:is|'s) this\b|\bwhat app\b|\bwhich app\b|\bthe app\b|\bwebsite\b|\blink\b|\bsign ?up\b|\bprice\b|\bpricing\b|\bhow much\b|\bcost\b|\bfree trial\b/i.test(body.replace(/\[link\]/g, " "));
}

/**
 * One worker heartbeat. Does everything that needs the server's keys and rules: reads the switch, opens or
 * closes the session, takes in chat, and, when there is something to say and the previous line is finished,
 * drafts ONE line, runs it through the guardrails and the firewall, stores it and hands it back to be spoken.
 */
export async function runLiveHostTick(client: SupabaseClient, input: TickInput = {}, deps: TickDeps = {}): Promise<TickResult> {
  // Cost rows are written in the background while drafting. On a serverless host anything still in flight when
  // the response is sent can be lost, and the daily budget depends on these rows, so wait for them.
  const costWrites: Array<Promise<unknown>> = [];
  try {
    return await runTick(client, input, deps, costWrites);
  } finally {
    await Promise.allSettled(costWrites);
  }
}

async function runTick(client: SupabaseClient, input: TickInput, deps: TickDeps, costWrites: Array<Promise<unknown>>): Promise<TickResult> {
  const now = deps.now ?? new Date();
  const settings = await loadSettings(client);
  const systemPaused = await loadSystemPaused(client);
  let session = await loadLiveSession(client);

  if (settings.desiredState !== "on" || systemPaused) {
    if (session) await endSession(client, session.id, systemPaused ? "system paused" : "switched off by owner", now);
    return offResult(settings, systemPaused ? "The system is paused." : "The Live Host is switched off.");
  }

  if (session && now.getTime() - new Date(session.lastHeartbeatAt).getTime() > SESSION_ABANDONED_AFTER_MS) {
    await endSession(client, session.id, "worker stopped responding", now);
    session = null;
  }
  if (!session) {
    const { data, error } = await client
      .from("live_host_sessions")
      .insert({ status: "live", started_at: now.toISOString(), last_heartbeat_at: now.toISOString(), worker_info: input.workerInfo ?? {} })
      .select("*")
      .single();
    if (error) throw new Error(`create live_host_sessions failed: ${error.message}`);
    session = toSession(data as SessionRow);
  } else {
    await client.from("live_host_sessions").update({ last_heartbeat_at: now.toISOString(), worker_info: input.workerInfo ?? {} }).eq("id", session.id);
  }

  const base: TickResult = {
    desired: "on",
    reason: null,
    sessionId: session.id,
    tiktok: { chatEnabled: settings.tiktokChatEnabled, username: settings.tiktokUsername },
    utterance: null,
    note: null,
  };

  // Take in chat first, even while the host is mid-sentence, so nothing typed is lost.
  if (settings.tiktokChatEnabled && input.messages?.length) {
    await storeIncoming(client, session.id, input.messages.filter((m) => m.platform === "tiktok"), now);
  }
  const youtube = deps.youtube === undefined ? createYoutubeLiveChatAdapter() : deps.youtube;
  if (youtube) base.note = await pollYoutubeChat(client, session, settings, youtube, now);

  if (input.busy) return base;

  // A line already drafted but not yet confirmed spoken is handed out again rather than drafting a second one.
  const { data: queuedRows, error: queuedError } = await client.from("live_host_utterances").select("*").eq("session_id", session.id).eq("status", "queued").order("created_at", { ascending: true }).limit(1);
  if (queuedError) return { ...base, note: `Could not check for a waiting line: ${queuedError.message}` };
  const queued = ((queuedRows ?? []) as UtteranceRow[])[0];
  if (queued) {
    const { data: answered } = await client.from("live_host_messages").select("*").eq("utterance_id", queued.id);
    return { ...base, utterance: toTickUtterance(toUtterance(queued), ((answered ?? []) as MessageRow[]).map(toMessage), null) };
  }

  const todaySpend = await getLiveHostSpendTodayUsd(client, now);
  if (todaySpend >= settings.dailyBudgetUsd) {
    return { ...base, note: `Daily budget reached ($${todaySpend.toFixed(2)} of $${settings.dailyBudgetUsd.toFixed(2)}). The host is staying quiet.` };
  }

  // Pending chat, oldest first. Anything that waited too long is skipped rather than answered out of context.
  const { data: pendingRows, error: pendingError } = await client.from("live_host_messages").select("*").eq("session_id", session.id).eq("status", "pending").order("received_at", { ascending: true }).limit(50);
  if (pendingError) throw new Error(`load pending live_host_messages failed: ${pendingError.message}`);
  const pendingAll = ((pendingRows ?? []) as MessageRow[]).map(toMessage);
  const staleCutoff = now.getTime() - MESSAGE_STALE_AFTER_MS;
  const stale = pendingAll.filter((m) => new Date(m.receivedAt).getTime() < staleCutoff);
  if (stale.length > 0) {
    await client.from("live_host_messages").update({ status: "skipped", status_reason: "waited too long" }).in("id", stale.map((m) => m.id));
  }
  let pending = pendingAll.filter((m) => new Date(m.receivedAt).getTime() >= staleCutoff);
  if (pending.length > BACKLOG_LIMIT) {
    const passedOver = pending.slice(0, pending.length - MAX_MESSAGES_PER_LINE);
    await client.from("live_host_messages").update({ status: "skipped", status_reason: "chat moved on" }).in("id", passedOver.map((m) => m.id));
    pending = pending.slice(-MAX_MESSAGES_PER_LINE);
  }
  const batch = pending.slice(0, MAX_MESSAGES_PER_LINE);

  // Recent lines: the host's memory for this stream, and the basis for rationing Fillbook mentions.
  const { data: recentRows } = await client.from("live_host_utterances").select("*").eq("session_id", session.id).neq("status", "dropped").order("created_at", { ascending: false }).limit(RECENT_EXCHANGES);
  const recentUtterances = ((recentRows ?? []) as UtteranceRow[]).map(toUtterance);
  const recentMentions = recentUtterances.slice(0, PROMO_WINDOW).filter((u) => u.mentionsFillbook).length;
  const askedDirectly = batch.some((m) => viewerAskedAboutFillbook(m.body));
  const { data: mentionRows } = await client.from("live_host_utterances").select("created_at").eq("session_id", session.id).eq("mentions_fillbook", true).neq("status", "dropped").order("created_at", { ascending: false }).limit(1);
  const lastMentionAt = ((mentionRows ?? []) as Array<{ created_at: string }>)[0]?.created_at;
  const sinceLastMentionMs = lastMentionAt ? now.getTime() - new Date(lastMentionAt).getTime() : Number.POSITIVE_INFINITY;
  const sessionAgeMs = now.getTime() - new Date(session.startedAt).getTime();

  // People who just joined are welcomed by name, but only when nobody is waiting on an answer (and never
  // mid-sentence: this point is only reached when the worker is not speaking). Names are cleaned first, and a
  // name that is not safe to say is simply counted among "the others".
  const rawJoins = settings.tiktokChatEnabled && Array.isArray(input.joins) ? input.joins : [];
  const cleanJoiners = [...new Set(rawJoins.map((join) => safeAuthorName(typeof join?.name === "string" ? join.name : "")))];
  const namedJoiners = cleanJoiners.filter((name) => name !== FALLBACK_AUTHOR_NAME).slice(0, JOIN_WELCOME_MAX_NAMES);
  const otherJoiners = Math.max(0, rawJoins.length - namedJoiners.length);
  const lastWelcome = recentUtterances.find((u) => u.segment === JOIN_WELCOME_SEGMENT);
  const welcomeDue = !lastWelcome || now.getTime() - new Date(lastWelcome.createdAt).getTime() >= JOIN_WELCOME_EVERY_MS;
  const joinWelcome = batch.length === 0 && namedJoiners.length > 0 && welcomeDue;
  // Once a welcome is attempted the worker's list is cleared whatever happens, so a failed draft is never retried
  // on every tick.
  if (joinWelcome) base.joinsWelcomed = true;

  let segment = null;
  if (batch.length === 0 && !joinWelcome) {
    const quietSince = session.lastUtteranceAt ? new Date(session.lastUtteranceAt).getTime() : 0;
    if (now.getTime() - quietSince < settings.idleSeconds * 1000) return base;
    const spotDue = sessionAgeMs >= FILLBOOK_SPOT_NOT_BEFORE_MS && sinceLastMentionMs >= FILLBOOK_SPOT_EVERY_MS;
    segment = nextSegment(session.lastSegment, spotDue);
  }
  const fillbookMentionAllowed = askedDirectly || segment?.isFillbookSpot === true || recentMentions < PROMO_MAX_MENTIONS;
  // TikTok chat on means the stream is on TikTok, where sending viewers off-platform is a LIVE violation.
  const linkInBio = settings.tiktokChatEnabled || input.platform !== "youtube";
  const previousLine = recentUtterances[0]?.spokenText ?? null;

  // Who has spoken before in this session, to welcome first-timers by name.
  const authorCounts = new Map<string, number>();
  if (batch.length > 0) {
    const { data: priorRows } = await client.from("live_host_messages").select("author_name, platform, id").eq("session_id", session.id).in("author_name", [...new Set(batch.map((m) => m.authorName))]);
    for (const row of (priorRows ?? []) as Array<{ author_name: string; platform: string }>) {
      const key = `${row.platform}:${row.author_name}`;
      authorCounts.set(key, (authorCounts.get(key) ?? 0) + 1);
    }
  }
  const messagesForDraft: ChatMessageForDraft[] = batch.map((m) => ({
    id: m.id,
    platform: m.platform,
    authorName: m.authorName,
    body: m.body,
    isFirstMessage: (authorCounts.get(`${m.platform}:${m.authorName}`) ?? 1) <= 1,
  }));

  const recent = await buildRecentExchanges(client, recentUtterances);
  const grounding = deps.grounding ?? (await loadGroundingContext(client));
  const sessionId = session.id;
  const llmClient =
    deps.llmClient ??
    createLlmClient(process.env, (usage) => {
      costWrites.push(recordCostEvent(client, usage, { liveHostSessionId: sessionId, endpoint: LIVE_HOST_COST_ENDPOINT }));
    });
  const brandConstitution = new BrandConstitution(new SupabaseBrandConstitutionRepository(client));

  // The brand-rule check needs the database, so each candidate's verdict is worked out as it is generated and
  // read back by the (synchronous) assess step.
  const verdicts = new Map<LiveLineDraft, string | null>();
  let accepted: LiveLineDraft | null;
  let hardReason: string | null;
  try {
    const result = await draftWithRetries<LiveLineDraft>({
      generate: async (retryFeedback) => {
        const draft = await draftLiveLine(llmClient, { messages: messagesForDraft, segment, recent, fillbookMentionAllowed, viewersWaiting: pending.length, linkInBio, joiners: joinWelcome ? namedJoiners : undefined, otherJoiners: joinWelcome ? otherJoiners : undefined, retryFeedback }, grounding);
        let problem = draft.reply.length === 0 && batch.length > 0 ? null : checkSpokenLine(draft.reply, { fillbookMentionAllowed, websiteMentionAllowed: !linkInBio, previousLine });
        if (!problem && draft.reply.length > 0) {
          const violations = await brandConstitution.checkVocabulary(draft.reply);
          if (violations[0]) problem = `breaks a brand rule (uses "${violations[0].matchedPhrase}")`;
        }
        if (!problem && draft.card && [draft.card.title, ...draft.card.lines].some((text) => checkSpokenLine(text, { fillbookMentionAllowed: true, websiteMentionAllowed: !linkInBio }) !== null)) {
          problem = "has an on-screen card with text that fails the same checks as the spoken line";
        }
        verdicts.set(draft, problem);
        return draft;
      },
      assess: (draft) => ({ hard: verdicts.get(draft) ?? null, soft: null }),
    });
    accepted = result.draft;
    hardReason = result.hardReason;
  } catch (err) {
    // A model outage or timeout must not take the stream down: say nothing this tick. A failed segment waits out
    // the quiet time before the next try; a failed reply is retried on the next tick while the viewer is waiting.
    if (segment) await backOffSegment(client, session.id, segment.id, now);
    return { ...base, note: `Could not draft a line: ${errorMessage(err)}` };
  }

  if (!accepted) {
    // Every attempt failed a check. The messages are closed out so the host does not loop on them.
    if (batch.length > 0) {
      await client.from("live_host_messages").update({ status: "skipped", status_reason: `no safe reply (${hardReason ?? "unknown"})`.slice(0, 200) }).in("id", batch.map((m) => m.id));
    }
    // Without this a segment that keeps failing would be redrafted on every 3-second tick, three model calls a
    // time. Treat it as said: wait out the quiet time, then move on to the next segment.
    if (segment) await backOffSegment(client, session.id, segment.id, now);
    return { ...base, note: `No line passed the checks: ${hardReason ?? "unknown"}` };
  }

  // The model chose to say nothing (everything in the batch was spam or bait).
  if (accepted.reply.length === 0) {
    if (batch.length > 0) {
      const reasons = new Map(accepted.skippedMessages.map((s) => [s.id, s.reason]));
      for (const m of batch) {
        await client.from("live_host_messages").update({ status: "skipped", status_reason: reasons.get(m.id) ?? "not answered" }).eq("id", m.id);
      }
    }
    return base;
  }

  // Drafting took seconds. The owner may have switched off, or paused the system, in that time: read the switch,
  // the pause flag and the session again now, so the firewall decides on what is true at this moment.
  const [settingsNow, pausedNow, sessionNow] = await Promise.all([loadSettings(client), loadSystemPaused(client), loadLiveSession(client)]);
  if (settingsNow.desiredState !== "on" || pausedNow || sessionNow?.id !== session.id) {
    return { ...offResult(settingsNow, pausedNow ? "The system is paused." : "The Live Host is switched off."), joinsWelcomed: base.joinsWelcomed };
  }

  // The firewall has the last word, on the values just read.
  try {
    await authorizeLiveHostSpeechAndAudit(
      { ownerSwitchedOn: settingsNow.desiredState === "on", systemPaused: pausedNow, sessionId: sessionNow.id, guardrailProblem: verdicts.get(accepted) ?? null, text: accepted.reply },
      deps.auditSink ?? supabaseAuditSink(client),
    );
  } catch (err) {
    if (err instanceof LiveHostSpeechRejectedError) return { ...base, note: err.message };
    throw err;
  }

  const lineMentionsFillbook = mentionsFillbook(accepted.reply);
  const { data: inserted, error: insertError } = await client
    .from("live_host_utterances")
    .insert({
      session_id: session.id,
      kind: segment || joinWelcome ? "segment" : "reply",
      segment: joinWelcome ? JOIN_WELCOME_SEGMENT : (segment?.id ?? null),
      spoken_text: accepted.reply,
      mood: accepted.mood,
      card: accepted.card,
      mentions_fillbook: lineMentionsFillbook,
      status: "queued",
      created_at: now.toISOString(),
    })
    .select("*")
    .single();
  if (insertError) throw new Error(`insert live_host_utterances failed: ${insertError.message}`);
  const utterance = toUtterance(inserted as UtteranceRow);

  const batchIds = new Set(batch.map((m) => m.id));
  const skippedReasons = new Map(accepted.skippedMessages.filter((s) => batchIds.has(s.id)).map((s) => [s.id, s.reason]));
  // A message is shown on stream as answered only if the model says it answered it. If the model named none
  // (it sometimes forgets), fall back to everything it did not skip. Anything left over is closed as skipped.
  const claimed = new Set(accepted.answeredMessageIds.filter((id) => batchIds.has(id) && !skippedReasons.has(id)));
  const answeredIds = batch.filter((m) => (claimed.size > 0 ? claimed.has(m.id) : !skippedReasons.has(m.id))).map((m) => m.id);
  for (const m of batch) {
    if (!answeredIds.includes(m.id) && !skippedReasons.has(m.id)) skippedReasons.set(m.id, "not answered");
  }
  if (answeredIds.length > 0) {
    await client.from("live_host_messages").update({ status: "answered", utterance_id: utterance.id }).in("id", answeredIds);
  }
  for (const [id, reason] of skippedReasons) {
    await client.from("live_host_messages").update({ status: "skipped", status_reason: reason }).eq("id", id);
  }
  await client
    .from("live_host_sessions")
    .update({ last_utterance_at: now.toISOString(), ...(segment ? { last_segment: segment.id } : {}) })
    .eq("id", session.id);

  return {
    ...base,
    utterance: toTickUtterance(utterance, batch.filter((m) => answeredIds.includes(m.id)), accepted.tiltLevel, joinWelcome ? JOIN_WELCOME_TITLE : (segment?.title ?? null)),
  };
}

/** A segment that could not be drafted counts as run: the quiet time restarts and the rotation moves on. */
async function backOffSegment(client: SupabaseClient, sessionId: string, segmentId: string, now: Date): Promise<void> {
  await client.from("live_host_sessions").update({ last_utterance_at: now.toISOString(), last_segment: segmentId }).eq("id", sessionId);
}

function toTickUtterance(utterance: LiveHostUtterance, answered: LiveHostMessage[], tiltLevel: number | null, segmentTitle: string | null = null): TickUtterance {
  return {
    id: utterance.id,
    kind: utterance.kind,
    // A line handed out a second time (the worker restarted mid-line) still gets its banner.
    segmentTitle: segmentTitle ?? (utterance.segment === JOIN_WELCOME_SEGMENT ? JOIN_WELCOME_TITLE : (LIVE_HOST_SEGMENTS.find((candidate) => candidate.id === utterance.segment)?.title ?? null)),
    spokenText: utterance.spokenText,
    mood: utterance.mood,
    tiltLevel,
    card: utterance.card,
    replyingTo: answered.map((m) => ({ platform: m.platform, authorName: m.authorName, body: m.body })),
  };
}

async function buildRecentExchanges(client: SupabaseClient, recentUtterances: LiveHostUtterance[]): Promise<RecentExchange[]> {
  if (recentUtterances.length === 0) return [];
  const { data } = await client.from("live_host_messages").select("*").in("utterance_id", recentUtterances.map((u) => u.id));
  const byUtterance = new Map<string, LiveHostMessage[]>();
  for (const row of ((data ?? []) as MessageRow[]).map(toMessage)) {
    if (!row.utteranceId) continue;
    byUtterance.set(row.utteranceId, [...(byUtterance.get(row.utteranceId) ?? []), row]);
  }
  const exchanges: RecentExchange[] = [];
  for (const utterance of [...recentUtterances].reverse()) {
    for (const message of byUtterance.get(utterance.id) ?? []) exchanges.push({ speaker: "viewer", name: message.authorName, text: message.body });
    exchanges.push({ speaker: "tilt", text: utterance.spokenText });
  }
  return exchanges;
}

/** The worker confirms a line was actually spoken on stream (or dropped because the stream stopped first). */
export async function markUtteranceSpoken(client: SupabaseClient, utteranceId: string, outcome: "spoken" | "dropped" = "spoken", now: Date = new Date()): Promise<void> {
  const { data, error } = await client
    .from("live_host_utterances")
    .update({ status: outcome, spoken_at: outcome === "spoken" ? now.toISOString() : null })
    .eq("id", utteranceId)
    .eq("status", "queued")
    .select("id, session_id");
  if (error) throw new Error(`update live_host_utterances failed: ${error.message}`);
  const row = ((data ?? []) as Array<{ id: string; session_id: string }>)[0];
  if (!row) throw new LiveHostActionError(`No queued live_host_utterances row with id "${utteranceId}"`);
  // Quiet time is measured from when the host finished speaking, not from when the line was drafted.
  await client.from("live_host_sessions").update({ last_utterance_at: now.toISOString() }).eq("id", row.session_id);
}
