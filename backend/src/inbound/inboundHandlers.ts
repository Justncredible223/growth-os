import { loadInboundStyleExamples } from "./inboundStyleExamples.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BrandConstitution } from "../knowledge/brandConstitution.js";
import { SupabaseBrandConstitutionRepository } from "../knowledge/supabaseRepositories.js";
import { createRecordedLlmClient } from "../cost/recordedLlmClient.js";
import { estimateCostUsd } from "../cost/costTracking.js";
import { draftInboundResponse, INBOUND_TRACKABLE_LINK, type InboundDraftContext } from "./inboundResponseWriter.js";
import { draftWithRetries } from "../content/xReplyGuardrails.js";
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

export class InboundActionError extends Error {}

const ACTIVE_STATUSES: InboundStatus[] = ["new", "needs_response", "draft_ready", "follow_up", "review_needed"];
const OVERDUE_HOURS = 48;

export interface InboundListItem extends InboundEngagement {
  creatorHandle: string | null;
  creatorCategory: string | null;
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

  return rows.map((row) => ({
    ...row,
    creatorHandle: row.creatorId ? (creatorById.get(row.creatorId)?.handle ?? null) : null,
    creatorCategory: row.creatorId ? (creatorById.get(row.creatorId)?.category ?? null) : null,
  }));
}

export interface InboundSummary {
  needsResponse: number;
  followUp: number;
  repeatEngagers: number;
  overdue: number;
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

  return {
    needsResponse: active.filter((r) => isUnresolved(r.status)).length,
    followUp: active.filter((r) => r.status === "follow_up").length,
    repeatEngagers: active.filter((r) => r.isRepeatEngager).length,
    overdue: active.filter((r) => isUnresolved(r.status) && new Date(r.observedAt).getTime() < cutoff).length,
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
    throw new InboundActionError("This post is from Fillbook's own account, so it is not inbound engagement and was dismissed instead of drafted.");
  }

  const { brandRulesSummary, verifiedKnowledgeSummary } = await loadGroundingContext(client);
  const llmClient = createRecordedLlmClient(client, { step: "inbound-draft", tier: "owner", context: { inboundEngagementId: id } });

  const draftContext: InboundDraftContext = {
    platform: row.platform,
    authorHandle: row.authorHandle,
    messageText: row.body,
    inResponseToText: row.inResponseToText,
    isRepeatEngager: row.isRepeatEngager,
    priorInteractionCount: await repo.countPriorFromAuthor(row.platform, row.authorExternalId ?? ""),
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
    throw new InboundActionError(`Draft rejected -- ${hardReason}. Try drafting again.`);
  }
  const draft = accepted;

  // Swaps the model's static placeholder link for a real per-engagement
  // short link (see trackableLinks.ts) -- same per-reply attribution this
  // session added to Prospecting. A no-op when usesLink is false.
  const finalReply = draft.usesLink
    ? substituteTrackableLink(draft.reply, INBOUND_TRACKABLE_LINK, buildTrackableReplyLink(`inbound:${id}`, "inbound", id))
    : draft.reply;

  await repo.updateStatus(id, "draft_ready", { draftResponse: finalReply, draftUsesLink: draft.usesLink });
  return { ...row, status: "draft_ready", draftResponse: finalReply, draftUsesLink: draft.usesLink };
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
  if (!(await repo.getById(id))) throw new InboundActionError(`No inbound_engagements row with id "${id}"`);
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
  if (!(await repo.getById(id))) throw new InboundActionError(`No inbound_engagements row with id "${id}"`);
  await repo.updateStatus(id, "closed", note?.trim() ? { respondedNote: note.trim() } : undefined);
}

/**
 * Manually triggers a wider-window inbound pull (ignores the stored
 * cursor) -- the "we found unanswered replies during a manual review"
 * recovery path. New items land as 'review_needed', not
 * 'needs_response': see ingestInboundMentions's doc comment for why.
 * Anything already tracked is left completely untouched.
 */
export async function runBacklogRecovery(client: SupabaseClient): Promise<{ fetched: number; inserted: number; skippedExisting: number }> {
  await recordSyncAttempt(client, "x_inbound");
  try {
    const adapter = createXSignalAdapter(client);
    const userId = await adapter.resolveOwnUserId();
    const repo = new SupabaseInboundRepository(client);
    const cursorStore = new SupabaseIngestionCursorStore(client);
    const result = await ingestInboundMentions(
      { adapter, repo, findCreatorIdByHandle: (handle) => findCreatorIdByHandle(client, handle) },
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
