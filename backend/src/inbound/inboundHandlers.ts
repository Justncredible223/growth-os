import { loadInboundStyleExamples } from "./inboundStyleExamples.js";
import { buildInboundThread, formatThread } from "./inboundThread.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BrandConstitution } from "../knowledge/brandConstitution.js";
import { SupabaseBrandConstitutionRepository } from "../knowledge/supabaseRepositories.js";
import { createRecordedLlmClient } from "../cost/recordedLlmClient.js";
import { estimateCostUsd } from "../cost/costTracking.js";
import { draftInboundResponse, INBOUND_TRACKABLE_LINK, type InboundDraftContext } from "./inboundResponseWriter.js";
import { draftWithRetries } from "../content/xReplyGuardrails.js";
import { paragraphizeReply } from "../content/replySpacing.js";
import { assessInboundDraft } from "./inboundDraftPolicy.js";
import { OWN_ACCOUNT_NOTE, closeOwnAccountItems, isOwnAccountRow, type OwnAccountIdentity } from "./ownAccount.js";
import { buildTrackableReplyLink, substituteTrackableLink } from "../content/trackableLinks.js";
import { SupabaseInboundRepository } from "./supabaseInboundRepository.js";
import { ingestInboundMentions } from "./inboundIngestion.js";
import { createXSignalAdapter } from "../signals/adapters/xAdapter.js";
import { SupabaseIngestionCursorStore } from "../signals/adapters/ingestionCursorStore.js";
import { findCreatorIdByHandle } from "../creators/supabaseCreatorRepository.js";
import { recordSyncAttempt, recordSyncSuccess, recordSyncFailure } from "../lib/integrationHealth.js";
import { errorMessage } from "../lib/errorMessage.js";
import type { InboundEngagement, InboundRepository, InboundStatus } from "./types.js";
import { SupabaseProspectingRepository } from "../prospecting/supabaseProspectingRepository.js";

export class InboundActionError extends Error {}

/** The row exists but is not in a state the action accepts (HTTP 409). P0 2026-11-15. */
export class InboundConflictError extends InboundActionError {}

/** The draft guardrail turned every attempt away (HTTP 422): the owner can try again. */
export class InboundDraftRejectedError extends InboundActionError {}

/** Statuses still waiting on the owner. Responded and closed are finished. */
export const OPEN_INBOUND_STATUSES: readonly string[] = ["new", "needs_response", "draft_ready", "follow_up", "review_needed"];

const ACTIVE_STATUSES: InboundStatus[] = ["new", "needs_response", "draft_ready", "follow_up", "review_needed"];
const OVERDUE_HOURS = 48;

export interface InboundListItem extends InboundEngagement {
  creatorHandle: string | null;
  creatorCategory: string | null;
  /** The text of our post this item replies to, from x_own_posts (null when it is not one of our stored posts). */
  repliedToText?: string | null;
  /** A follow-up flagged more than FOLLOW_UP_DUE_HOURS ago. */
  followUpDue?: boolean;
  /** This item's author shows the burst pattern (advisory label on the person; see automatedBurstAuthors). */
  possiblyAutomated?: boolean;
}

/**
 * Queue-load read that can never show or count a self-authored item: the safety-net cleanup runs first (best
 * effort; a failed write must not take the queue down), and the result is filtered again in memory regardless.
 */
async function listExcludingOwnAccount(repo: InboundRepository, statuses: InboundStatus[], own: OwnAccountIdentity = {}): Promise<InboundEngagement[]> {
  try {
    await closeOwnAccountItems(repo, own);
  } catch {
    // Best effort -- the in-memory filter below still hides the rows.
  }
  const rows = await repo.listByStatus(statuses);
  return rows.filter((row) => !isOwnAccountRow(row, own));
}

/**
 * Default view is the active queue (everything not yet resolved) --
 * matching the core requirement that nothing should require the owner to
 * remember to go looking for it. `includeResolved` exists for the
 * Content Library-style "everything, including history" view, not as
 * the default.
 */
export async function listInbound(client: SupabaseClient, includeResolved = false): Promise<InboundListItem[]> {
  const statuses: InboundStatus[] = includeResolved
    ? ["new", "needs_response", "draft_ready", "responded", "follow_up", "review_needed", "closed"]
    : ACTIVE_STATUSES;
  const repo = new SupabaseInboundRepository(client);
  const rows = await listExcludingOwnAccount(repo, statuses);

  const creatorIds = [...new Set(rows.map((r) => r.creatorId).filter((id): id is string => id !== null))];
  const creatorById = new Map<string, { handle: string; category: string }>();
  if (creatorIds.length > 0) {
    const { data } = await client.from("creators").select("id, handle, category").in("id", creatorIds);
    for (const row of (data ?? []) as Array<{ id: string; handle: string; category: string }>) {
      creatorById.set(row.id, { handle: row.handle, category: row.category });
    }
  }

  // P1 2026-11-15: show the post each reply answers before any draft exists, from our own stored posts (x_own_posts; no X read).
  const parentIds = [...new Set(rows.map((r) => r.inReplyToExternalId).filter((id): id is string => Boolean(id)))];
  const parentText = new Map<string, string>();
  if (parentIds.length > 0) {
    const { data } = await client.from("x_own_posts").select("tweet_id, text").in("tweet_id", parentIds);
    for (const p of (data ?? []) as Array<{ tweet_id: string; text: string }>) parentText.set(p.tweet_id, p.text);
  }

  // Advisory label per person; an author we have answered in a conversation before is never labelled.
  const burst = automatedBurstAuthors(rows);
  for (const key of [...burst]) {
    const [platform, authorId] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const answered = await repo.countAnsweredFromAuthor(platform, authorId, null).catch(() => 0);
    if (answered > 0) burst.delete(key);
  }

  return sortInboundQueue(rows).map((row) => ({
    ...row,
    creatorHandle: row.creatorId ? (creatorById.get(row.creatorId)?.handle ?? null) : null,
    creatorCategory: row.creatorId ? (creatorById.get(row.creatorId)?.category ?? null) : null,
    repliedToText: row.inReplyToExternalId ? (parentText.get(row.inReplyToExternalId) ?? null) : null,
    followUpDue: isFollowUpDue(row, new Date()),
    possiblyAutomated: row.authorExternalId ? burst.has(`${row.platform}:${row.authorExternalId}`) : false,
  }));
}

export interface InboundSummary {
  needsResponse: number;
  /** How many different people those unresolved items come from (8 replies from one account is 1 person). P1 2026-11-15. */
  people: number;
  followUp: number;
  /** Follow-ups flagged more than FOLLOW_UP_DUE_HOURS ago: they come back to the top of the queue. */
  followUpDue: number;
  repeatEngagers: number;
  overdue: number;
}

/** A follow-up comes back to the top of the queue this long after it was flagged (P1 2026-11-15: they used to sit forever). */
export const FOLLOW_UP_DUE_HOURS = 48;

/**
 * "Possibly automated activity" (P2, ChatGPT 2026-11-15): an author with at least 4 qualifying messages in 24 hours -- each under 200
 * characters, not a question -- and no conversation we have answered with them. Other messages from the same author may be longer or ask
 * questions; at least 4 must qualify. It is advisory only: it labels the person, never closes, hides, reorders or restricts anything, and
 * never calls any single message automated.
 */
export const AUTOMATED_MIN_MESSAGES = 4;
export const AUTOMATED_WINDOW_HOURS = 24;
export const AUTOMATED_MAX_CHARS = 200;
export function qualifiesForAutomatedSignal(body: string): boolean {
  const text = body.replace(/^(?:@\w+\s+)+/, "").trim();
  return text.length < AUTOMATED_MAX_CHARS && !text.includes("?");
}
/** Author keys (platform:authorExternalId) whose recent messages make the burst pattern. Pure; answered authors are removed by the caller. */
export function automatedBurstAuthors(rows: Array<Pick<InboundEngagement, "platform" | "authorExternalId" | "body" | "observedAt">>): Set<string> {
  const byAuthor = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.authorExternalId || !qualifiesForAutomatedSignal(r.body)) continue;
    const key = `${r.platform}:${r.authorExternalId}`;
    byAuthor.set(key, [...(byAuthor.get(key) ?? []), Date.parse(r.observedAt)]);
  }
  const out = new Set<string>();
  const windowMs = AUTOMATED_WINDOW_HOURS * 60 * 60 * 1000;
  for (const [key, times] of byAuthor) {
    const sorted = times.filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
    for (let i = 0; i + AUTOMATED_MIN_MESSAGES - 1 < sorted.length; i++) {
      if (sorted[i + AUTOMATED_MIN_MESSAGES - 1]! - sorted[i]! <= windowMs) {
        out.add(key);
        break;
      }
    }
  }
  return out;
}

/** Queue order: due follow-ups, then direct replies, relationships, comments and mentions, newest first within each. */
const PRIORITY_RANK: Record<string, number> = { p1_direct_reply: 1, p2_relationship: 2, p3_comment: 3, p4_mention: 4, low_value: 5 };
export function isFollowUpDue(row: Pick<InboundEngagement, "status" | "updatedAt">, now: Date): boolean {
  return row.status === "follow_up" && Date.parse(row.updatedAt) < now.getTime() - FOLLOW_UP_DUE_HOURS * 60 * 60 * 1000;
}
export function sortInboundQueue<T extends Pick<InboundEngagement, "status" | "updatedAt" | "priority" | "observedAt">>(rows: T[], now: Date = new Date()): T[] {
  const rank = (r: T) => (isFollowUpDue(r, now) ? 0 : (PRIORITY_RANK[r.priority] ?? 9));
  return [...rows].sort((a, b) => rank(a) - rank(b) || Date.parse(b.observedAt) - Date.parse(a.observedAt));
}

/**
 * The counts the Command Center dashboard shows -- "4 need response, 2
 * follow-ups, 1 repeat engager, 0 overdue." `overdue` is needs_response
 * items sitting longer than OVERDUE_HOURS with no draft and no response
 * -- the one number specifically meant to make it hard to forget
 * something for days.
 *
 * `needsResponse` counts every status that is NOT `responded`/`closed`/
 * `follow_up` -- i.e. `new`, `needs_response`, `review_needed`, AND
 * `draft_ready`. Both gaps below were found by running this against real
 * production data, not by inspection:
 *
 * 1. `review_needed` was originally excluded -- a backlog-recovery pass
 *    landed 19 real mentions (including a genuine "I checked out your
 *    site and I think this is exactly what I need!") as `review_needed`,
 *    and the dashboard's attention count silently excluded every one.
 * 2. `draft_ready` was then also excluded -- generating a draft for one
 *    of those 19 dropped the visible count from 19 to 18, even though a
 *    draft sitting unsent is exactly the "drafted != responded" case
 *    this whole feature exists to keep distinct. A draft is progress,
 *    not resolution -- the owner still has to actually send it.
 *
 * Each status still renders as its own distinct label in the queue (see
 * inboundStatusLabel in the Android app) -- only this aggregate "needs my
 * attention" count treats all of them as equally unresolved, which they
 * are: none of the four represent an owner action having been taken yet.
 */
/** Pure aggregation, deliberately separated from the Supabase fetch so it's directly unit-testable -- this exact function has already had two real bugs found only by running it against live data (see the doc comment above). */
export function computeInboundSummary(active: InboundEngagement[], now: Date = new Date()): InboundSummary {
  const cutoff = now.getTime() - OVERDUE_HOURS * 60 * 60 * 1000;
  const isUnresolved = (status: string) =>
    status === "needs_response" || status === "new" || status === "review_needed" || status === "draft_ready";

  const unresolved = active.filter((r) => isUnresolved(r.status));
  return {
    needsResponse: unresolved.length,
    people: new Set(unresolved.map((r) => `${r.platform}:${r.authorExternalId ?? r.authorHandle ?? r.id}`)).size,
    followUp: active.filter((r) => r.status === "follow_up").length,
    followUpDue: active.filter((r) => isFollowUpDue(r, now)).length,
    repeatEngagers: active.filter((r) => r.isRepeatEngager).length,
    // review_needed rows come from a backlog pass and are old by nature, so they are not counted as overdue (P1 2026-11-15).
    overdue: unresolved.filter((r) => r.status !== "review_needed" && new Date(r.observedAt).getTime() < cutoff).length,
  };
}

export async function summarizeInbound(client: SupabaseClient): Promise<InboundSummary> {
  const repo = new SupabaseInboundRepository(client);
  const active = await listExcludingOwnAccount(repo, ACTIVE_STATUSES);
  return computeInboundSummary(active);
}

export async function loadGroundingContext(client: SupabaseClient): Promise<{ brandRulesSummary: string; verifiedKnowledgeSummary: string }> {
  const brandConstitution = new BrandConstitution(new SupabaseBrandConstitutionRepository(client));
  const activeRules = await brandConstitution.getActiveRules();
  const brandRulesSummary = activeRules.map((r) => `[${r.ruleType}] ${r.content}`).join("\n");

  const { data: knowledgeRows } = await client.from("knowledge_documents").select("title, content").eq("trust_level", "verified");
  const verifiedKnowledgeSummary = (knowledgeRows ?? [])
    .map((row: { title: string; content: string }) => `${row.title}: ${row.content}`)
    .join("\n");

  return { brandRulesSummary, verifiedKnowledgeSummary };
}

/**
 * Generates a draft and moves the row to 'draft_ready' -- deliberately a
 * DIFFERENT status than 'responded'. This function has no ability to
 * post anything anywhere; ExternalWriteFirewall would reject an
 * x.reply/x.post_tweet action regardless, but the more basic guarantee
 * is simpler than that -- there is no code here that calls any X write
 * endpoint at all.
 */
export async function draftResponseForInbound(client: SupabaseClient, id: string): Promise<InboundEngagement> {
  const repo = new SupabaseInboundRepository(client);
  const row = await repo.getById(id);
  if (!row) throw new InboundActionError(`No inbound_engagements row with id "${id}"`);
  // A post from our own account is never drafted for (it would be a reply to ourselves, and the model has called
  // our own giveaway an impersonation before). Dismiss it with the audit note instead.
  if (isOwnAccountRow(row)) {
    if (row.status !== "closed" && row.status !== "responded") await repo.updateStatus(id, "closed", { respondedNote: OWN_ACCOUNT_NOTE });
    throw new InboundConflictError("This post is from Fillbook's own account, so it is not inbound engagement and was dismissed instead of drafted.");
  }
  // P0 2026-11-15: a finished item is never drafted again (drafting used to flip a responded or closed item back to draft_ready).
  if (!OPEN_INBOUND_STATUSES.includes(row.status)) {
    throw new InboundConflictError(`This item is already ${row.status}, so it is not drafted again.`);
  }

  const { brandRulesSummary, verifiedKnowledgeSummary } = await loadGroundingContext(client);
  const llmClient = createRecordedLlmClient(client, { step: "inbound-draft", tier: "owner", context: { inboundEngagementId: id } });

  // Rebuild the conversation behind this reply (our posted replies, their earlier messages, the post we first replied to). Best
  // effort: with no earlier turns known the draft is written as before.
  let thread = "";
  try {
    thread = formatThread(await buildInboundThread(client, row));
  } catch {
    thread = "";
  }

  const draftContext: InboundDraftContext = {
    platform: row.platform,
    authorHandle: row.authorHandle,
    messageText: row.body,
    inResponseToText: row.inResponseToText ?? (thread || null),
    ...(thread ? { thread } : {}),
    isRepeatEngager: row.isRepeatEngager,
    // P1 2026-11-15: the count no longer includes this message itself.
    priorInteractionCount: Math.max(0, (await repo.countPriorFromAuthor(row.platform, row.authorExternalId ?? "")) - 1),
    // A Prospecting reply is only recorded once it was posted, so this is "we really replied to them before".
    priorProspectingReply:
      row.platform === "x" && row.authorExternalId
        ? await new SupabaseProspectingRepository(client).hasPriorOutreach("x", row.authorExternalId).catch(() => false)
        : false,
    styleExamples: await loadInboundStyleExamples(client),
  };

  // A draft with a real problem is regenerated with the reason fed back (up to MAX_DRAFT_ATTEMPTS) and
  // never shown; a draft with only a soft style tell gets one retry and is then shown as the best attempt.
  const { draft: accepted, hardReason } = await draftWithRetries({
    generate: (retryFeedback) =>
      draftInboundResponse(llmClient, retryFeedback ? { ...draftContext, retryFeedback } : draftContext, brandRulesSummary, verifiedKnowledgeSummary),
    // Mechanical, $0 safety net (see inboundDraftPolicy.ts and xReplyGuardrails.ts): link earned only by an explicit ask
    // (or a giveaway question, then only fillbookhq.com/giveaway), approved domains only, no false giveaway claims.
    assess: (candidate) => assessInboundDraft(candidate, { messageText: row.body, authorIsOwnAccount: false }),
  });
  if (!accepted) {
    throw new InboundDraftRejectedError(`Draft rejected -- ${hardReason}. Try drafting again.`);
  }
  const draft = accepted;

  // Swaps the model's static placeholder link for a real per-engagement
  // short link (see trackableLinks.ts) -- same per-reply attribution this
  // session added to Prospecting. A no-op when usesLink is false.
  const finalReply = paragraphizeReply(
    draft.usesLink
      ? substituteTrackableLink(draft.reply, INBOUND_TRACKABLE_LINK, buildTrackableReplyLink(`inbound:${id}`, "inbound", id))
      : draft.reply,
  );

  await repo.updateStatus(id, "draft_ready", { draftResponse: finalReply, draftUsesLink: draft.usesLink });
  // Keep the rebuilt thread on the row so the card shows it too (the app already displays inResponseToText).
  if (thread && !row.inResponseToText) await repo.setInResponseToText(id, thread);
  return { ...row, status: "draft_ready", draftResponse: finalReply, draftUsesLink: draft.usesLink, inResponseToText: row.inResponseToText ?? (thread || null) };
}

/**
 * The ONLY action that ever sets status='responded' -- an explicit,
 * human-triggered confirmation, never inferred from a draft existing.
 * X's API can't reliably confirm a reply was posted from this account
 * without an additional write-adjacent capability this app deliberately
 * doesn't have, so this is the safest available operator workflow: the
 * owner presses "Mark responded" after actually replying on X
 * themselves, same human-does-the-real-action pattern as Copy & Share.
 */
export async function markResponded(client: SupabaseClient, id: string, note?: string, finalResponse?: string): Promise<void> {
  const repo = new SupabaseInboundRepository(client);
  const row = await repo.getById(id);
  if (!row) throw new InboundActionError(`No inbound_engagements row with id "${id}"`);
  // P0 2026-11-15: a retry after a timeout (or a second tap) changes nothing, so respondedAt and the "resolved today" count stay right.
  if (row.status === "responded") return;
  if (!OPEN_INBOUND_STATUSES.includes(row.status)) {
    throw new InboundConflictError(`This item is already ${row.status}, so it can't be marked responded.`);
  }
  // Stored only when the owner actually changed the draft -- same rule as Prospecting's final_reply -- so it is a clean "AI draft vs. what I posted" signal.
  const edited = finalResponse?.trim();
  await repo.updateStatus(id, "responded", {
    respondedAt: new Date().toISOString(),
    respondedNote: note?.trim() || null,
    finalResponse: edited && edited !== row.draftResponse?.trim() ? edited : undefined,
  });
}

export async function markFollowUp(client: SupabaseClient, id: string): Promise<void> {
  const repo = new SupabaseInboundRepository(client);
  const row = await repo.getById(id);
  if (!row) throw new InboundActionError(`No inbound_engagements row with id "${id}"`);
  if (row.status === "follow_up") return;
  if (!OPEN_INBOUND_STATUSES.includes(row.status)) {
    throw new InboundConflictError(`This item is already ${row.status}, so it can't be flagged for follow-up.`);
  }
  await repo.updateStatus(id, "follow_up");
}

/**
 * `note` is optional and reuses the same `responded_note` column
 * `markResponded` writes to -- it's really "the human-readable reason for
 * this disposition," not specifically "note about a response." Keeping it
 * to one column instead of adding a second migration: a closed row's note
 * ("stale: 9 days old, generic opinion" / "superseded by <id> in the same
 * thread") means the same thing a responded row's note does -- context for
 * why the terminal status was reached, so a backlog-recovery batch is
 * still auditable after the fact instead of just disappearing.
 */
export async function closeInbound(client: SupabaseClient, id: string, note?: string): Promise<void> {
  const repo = new SupabaseInboundRepository(client);
  const row = await repo.getById(id);
  if (!row) throw new InboundActionError(`No inbound_engagements row with id "${id}"`);
  // Closing twice changes nothing; a responded item stays responded (closing it would hide that it was answered).
  if (row.status === "closed") return;
  if (row.status === "responded") throw new InboundConflictError("This item was already responded to, so it is not closed.");
  await repo.updateStatus(id, "closed", note?.trim() ? { respondedNote: note.trim() } : undefined);
}

/**
 * Manually triggers a wider-window inbound pull (ignores the stored
 * cursor) -- the "we found unanswered replies during a manual review"
 * recovery path. New items land as 'review_needed', not
 * 'needs_response': see ingestInboundMentions's doc comment for why.
 * Anything already tracked is left completely untouched.
 */
/** "Check for missed replies" runs at most once per this many minutes (P1 2026-11-15: it had no limit, about $0.05 a tap). */
export const BACKLOG_COOLDOWN_MINUTES = 60;
const BACKLOG_LAST_RUN_KEY = "inbound_backlog_last_run";

export async function runBacklogRecovery(client: SupabaseClient, now: Date = new Date()): Promise<{ fetched: number; inserted: number; skippedExisting: number }> {
  const cooldownStore = new SupabaseIngestionCursorStore(client);
  const last = await cooldownStore.load(BACKLOG_LAST_RUN_KEY).catch(() => null);
  if (last && now.getTime() - Date.parse(last) < BACKLOG_COOLDOWN_MINUTES * 60 * 1000) {
    const minutes = Math.ceil((Date.parse(last) + BACKLOG_COOLDOWN_MINUTES * 60 * 1000 - now.getTime()) / 60000);
    throw new InboundConflictError(`Missed replies were checked less than an hour ago. Try again in ${minutes} min.`);
  }
  await recordSyncAttempt(client, "x_inbound");
  try {
    await cooldownStore.save(BACKLOG_LAST_RUN_KEY, now.toISOString());
    const adapter = createXSignalAdapter(client);
    const userId = await adapter.resolveOwnUserId();
    const repo = new SupabaseInboundRepository(client);
    const cursorStore = new SupabaseIngestionCursorStore(client);
    const result = await ingestInboundMentions(
      {
        adapter,
        repo,
        findCreatorIdByHandle: (handle) => findCreatorIdByHandle(client, handle),
        // Same relationship input as the forward sync, so a recovered item gets the same priority it would have had.
        hasProspectingOutreach: (authorExternalId) => new SupabaseProspectingRepository(client).hasPriorOutreach("x", authorExternalId),
      },
      cursorStore,
      userId,
      new Date(),
      true,
    );
    await recordSyncSuccess(client, "x_inbound", `backlog recovery: ${result.inserted} new, ${result.skippedExisting} already tracked`);
    return result;
  } catch (err) {
    await recordSyncFailure(client, "x_inbound", errorMessage(err));
    throw err;
  }
}
