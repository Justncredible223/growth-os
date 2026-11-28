import { replyTagProblem, tagGateOpen, tagNote, taggableHandles } from "./prospectingTagging.js";
import { RECOVERY_REPLY_COOLDOWN_MS, computeReplyPacing, type ReplyPacing } from "./prospectingPacing.js";
import { RECOVERY_DRAFT_NOTE, loadRecoveryState, namesFillbook, type RecoveryState } from "./prospectingRecovery.js";
import { MENTION_BUDGET_DRAFT_NOTE, computeMentionBudget } from "./prospectingMentionBudget.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRecordedLlmClient } from "../cost/recordedLlmClient.js";
import { loadGroundingContext } from "../inbound/inboundHandlers.js";
import { AUTHOR_COOLDOWN_DAYS, authorKeyOf, selectDailyWorkingSet } from "./prospectingDailySelection.js";
import { STALE_EXPIRY_DAYS } from "./prospectingEligibility.js";
import { checkRelevanceCheap, draftProspectingReply, PROSPECTING_TRACKABLE_LINK, type ProspectingDraftContext, type ProspectingDraftResult } from "./prospectingReplyWriter.js";
import { checkReplyGuardrails, checkReplySoftStyle, checkShowcaseShown, draftWithRetries } from "../content/xReplyGuardrails.js";
import { buildTrackableReplyLink, substituteTrackableLink } from "../content/trackableLinks.js";
import { paragraphizeReply } from "../content/replySpacing.js";
import { isReplyWorthyPost, isTooSmallToBeWorthIt } from "./prospectingRelevance.js";
import { logLensProblem, unsupportedFactProblem } from "./prospectingReplyChecks.js";
import { LOG_LENS_RECENT_WINDOW } from "./prospectingReplyChecks.js";
import { REPLY_CHECK_F5_KEY, ReplyCheckLog, f5Result, logReplyChecks, postCheckResults, replyChecksPatch, type CheckResult, type OptionCheck } from "./prospectingReplyCheckLog.js";
import { isSeedCreator } from "./prospectingWatchlist.js";
import { matchPostedStyle, optionSoftProblem, postMentionsFillbook, type DraftOption } from "./prospectingDraftOptions.js";
import { loadStyleExamples, type StyleExample } from "./prospectingStyleExamples.js";
import { discoveryLabelForKey, replyClassForKey } from "./prospectingTopics.js";
import { SHOWCASE_IDS, SHOWCASE_NONE } from "../content/fillbookShowcase.js";
import { SupabaseProspectingRepository } from "./supabaseProspectingRepository.js";
import { FREE_FILTER_REASON, MAYBE_REASONS, OWNER_OVERRIDE_AT_KEY, OWNER_OVERRIDE_KEY, OWNER_OVERRIDE_VISIBLE_MS, ProspectingWriteConflictError, SCREENED_OUT_AT_DRAFT_REASON, type ProspectingCandidate, type ProspectingRepository, type ProspectingStatus } from "./types.js";

/** Thrown from inside the draft-retry loop when the model says the post is irrelevant, so the loop stops without retrying. */
class ProspectingIrrelevantSignal extends Error {}

export class ProspectingActionError extends Error {}

/** The request is well formed but the row is not in a state the action accepts (maps to HTTP 409). */
export class ProspectingConflictError extends ProspectingActionError {}

/** Added to the drafter's user message when the owner chose to reply to a post the relevance screen turned away. */
export const OWNER_OVERRIDE_DRAFT_NOTE =
  "The owner has chosen to reply to this post themselves, even though an automatic screen thought it a weak fit. Write the best reply you can under every rule above. If it is a poor fit, still write a short, specific, harmless reply rather than declining, and set isRelevant to true.";

/** Added to the drafter's user message for a hand-picked creator: the owner wants to be seen replying to them, so a post that is not strictly about futures is still worth a reply. */
export const TRUSTED_CREATOR_DRAFT_NOTE =
  "The author is a hand-picked futures creator the owner wants to reply to, so this post is relevant even when it is not strictly about futures or trading rules. Reply to what they actually said, in a specific and harmless way, under every rule above. Do not force a futures or Fillbook mention, and set isRelevant to true.";

/** True for a card the owner pulled out of the Maybe list and that is still inside its 24-hour visibility window. */
export function isOwnerOverrideActive(row: ProspectingCandidate, now: Date): boolean {
  if (row.scoreBreakdown?.[OWNER_OVERRIDE_KEY] !== "true") return false;
  const at = Date.parse(row.scoreBreakdown[OWNER_OVERRIDE_AT_KEY] ?? "");
  return Number.isFinite(at) && now.getTime() - at < OWNER_OVERRIDE_VISIBLE_MS;
}

/**
 * Optional seams so the handlers can be exercised without a live Supabase
 * client or LLM: production callers pass nothing and get the real
 * repository + LLM-backed drafter; tests pass an in-memory repository and
 * a canned drafter. Nothing about the human-only posting boundary changes
 * -- neither seam can send anything anywhere.
 */
export interface ProspectingHandlerDeps {
  repo?: ProspectingRepository;
  drafter?: (context: ProspectingDraftContext, brandRulesSummary: string, verifiedKnowledgeSummary: string) => Promise<ProspectingDraftResult>;
  loadGrounding?: (client: SupabaseClient) => Promise<{ brandRulesSummary: string; verifiedKnowledgeSummary: string }>;
  /** Cheap (MODEL_HAIKU) relevance precheck -- see prospectingReplyWriter.ts's checkRelevanceCheap. Overridable so tests never make a live LLM call. */
  cheapRelevanceCheck?: (context: ProspectingDraftContext) => Promise<boolean>;
  /** Recent owner-edited replies for tone examples. Overridable so tests never touch the database. */
  loadStyleExamples?: (client: SupabaseClient) => Promise<StyleExample[]>;
  /** Recovery-mode state (prospectingRecovery.ts). Overridable so tests never touch the database. */
  loadRecovery?: (client: SupabaseClient, now: Date) => Promise<RecoveryState>;
  /** Overrides FILLBOOK_OPTION_ENABLED. Tests only. */
  fillbookOptionEnabled?: boolean;
}

/**
 * Whether a cold reply may offer option C, the one that names Fillbook. OFF since 2026-11-04 (owner: follow the X playbook, and the
 * ChatGPT + Gemini + Claude check agreed): viewers who mute us get -58.8 and our replies rarely reach non-followers anyway, so a cold
 * reply never names Fillbook. The code stays so it can be switched back on after the 2026-11-21 review.
 */
export const FILLBOOK_OPTION_ENABLED = false;

function repoFor(client: SupabaseClient, deps: ProspectingHandlerDeps): ProspectingRepository {
  return deps.repo ?? new SupabaseProspectingRepository(client);
}

/** Enriches a candidate with its human-readable topic label and reply class for the JSON response -- keeps discovery_query as the stable stored key while still giving the app something to display. */
export function toProspectingJson(candidate: ProspectingCandidate) {
  return {
    ...candidate,
    discoveryLabel: discoveryLabelForKey(candidate.discoveryQuery),
    replyClass: replyClassForKey(candidate.discoveryQuery),
  };
}

const NON_TERMINAL_STATUSES = ["new", "shown", "drafting", "ready"] as const;
const TERMINAL_STATUSES: readonly string[] = ["replied", "skipped", "not_relevant", "already_handled", "expired"];

/**
 * Why today's set looks the way it does -- added 2026-09-07 alongside the
 * freshness-decay/72h-cutoff changes specifically so an empty or small
 * daily set is never ambiguous. Before this existed, "Queue is clear" and
 * "everything's just too old right now" were indistinguishable from the
 * API response alone -- this makes that difference inspectable (and
 * testable) instead of silent. Counts are additive: totalConsidered ===
 * selected + deferred + belowQualityBar + tooOldForToday.
 */
export interface ProspectingSelectionDiagnostics {
  /** Every non-terminal (new/shown/drafting/ready) candidate examined this call, before any filtering. */
  totalConsidered: number;
  selected: number;
  /** Cleared the quality bar but lost to the one-per-author rule or the daily cap -- real backlog, not discarded. */
  deferred: number;
  /** Did not clear MIN_DAILY_SET_SCORE using today's freshness-adjusted effective score. */
  belowQualityBar: number;
  /** Excluded purely for being older than the 12h freshness cutoff -- see prospectingFreshness.ts. */
  tooOldForToday: number;
}

/**
 * DISCOVER -> FILTER -> RANK already happened upstream (prospectingSearch.ts
 * / prospectingScoring.ts). This is SELECT DAILY WORKING SET: expires
 * anything that's sat unactioned past STALE_EXPIRY_DAYS, re-ranks the
 * remaining non-terminal pool, and returns only today's capped, deduped
 * working set (see prospectingDailySelection.ts) -- never the full
 * accumulated backlog. Only rows actually selected today get marked
 * 'shown'; everything else stays exactly as it was (a 'new' row not
 * selected today is still 'new' tomorrow -- real backlog, not lost).
 *
 * Real, confirmed bug this closes (2026-09-07): the zero-cost relevance
 * gate in prospectingRelevance.ts previously only ran when the owner
 * tapped Draft reply on a candidate that had ALREADY been shown as an
 * actionable card (e.g. a crypto-only post like "$USELESS locked in the
 * profits... a 15% move in less than 2h" surfaced under a genuine-sounding
 * topic label). X's own search for a topic query is not a precise filter
 * (see prospectingSearch.ts), so off-topic results routinely make it into
 * the backlog; this is the one place every non-terminal candidate passes
 * through before ever becoming visible, so the gate is applied here too,
 * before daily selection -- an irrelevant candidate is moved straight to
 * 'not_relevant' (the same terminal status the owner's own "Irrelevant"
 * button sets, so the post itself is preserved, still visible in
 * Prospecting history, never deleted) and excluded from both the returned
 * candidates and the diagnostics below, exactly like it was never
 * discovered. This runs on every call (idempotent, $0, no LLM), so it also
 * retroactively sweeps any already-discovered irrelevant backlog the next
 * time the queue is fetched.
 */
/** A post the AI relevance screen turned away, shown read-only in the app's "Maybe" list so the owner can judge whether the screen is too strict. */
export interface ProspectingMaybeItem {
  id: string;
  authorHandle: string | null;
  postText: string;
  postUrl: string;
  score: number;
  /** When the screen turned it away (ISO). */
  at: string;
}

export const MAYBE_WINDOW_DAYS = 7;
export const MAYBE_MAX_ITEMS = 15;

/** Model-screen rejections of the last 7 days, newest first, up to 15. Never throws: the Maybe list must not break the queue. */
export async function listScreenedOutPosts(repo: ProspectingRepository, now: Date = new Date()): Promise<ProspectingMaybeItem[]> {
  if (!repo.listScreenedOut) return [];
  try {
    const rows = await repo.listScreenedOut(new Date(now.getTime() - MAYBE_WINDOW_DAYS * 24 * 60 * 60 * 1000), MAYBE_MAX_ITEMS);
    return rows.slice(0, MAYBE_MAX_ITEMS).map((c) => ({ id: c.id, authorHandle: c.authorHandle, postText: c.postText, postUrl: c.postUrl, score: c.opportunityScore, at: c.updatedAt }));
  } catch {
    return [];
  }
}

export async function listProspectingQueue(
  client: SupabaseClient,
  now: Date = new Date(),
  deps: ProspectingHandlerDeps = {},
): Promise<{ candidates: ProspectingCandidate[]; diagnostics: ProspectingSelectionDiagnostics; pacing: ReplyPacing; recovery: RecoveryState; maybe: ProspectingMaybeItem[] }> {
  const repo = repoFor(client, deps);

  const staleCutoff = new Date(now.getTime() - STALE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  await repo.expireStale(staleCutoff);

  const nonTerminal = await repo.listByStatus([...NON_TERMINAL_STATUSES], 500);
  // Owner-chosen cards (Draft anyway on a Maybe post) skip the free spam gates, the freshness window and the score floor for 24 hours.
  const overridden = nonTerminal.filter((row) => isOwnerOverrideActive(row, now));
  const overriddenIds = new Set(overridden.map((row) => row.id));
  const irrelevantIds = nonTerminal.filter((row) => !overriddenIds.has(row.id)).filter((row) => !isReplyWorthyPost(row.postText, { trustedAuthor: isSeedCreator(row.authorHandle), authorHandle: row.authorHandle, authorName: row.authorName }) || isTooSmallToBeWorthIt(row.authorFollowerCount)).map((row) => row.id);
  if (irrelevantIds.length > 0) {
    // One failed update must not fail the whole queue read (P1 2026-11-15); the next read retries it.
    await Promise.allSettled(irrelevantIds.map((id) => repo.updateStatus(id, "not_relevant", { skipReason: FREE_FILTER_REASON, onlyFrom: [...NON_TERMINAL_STATUSES] })));
  }
  const eligible = irrelevantIds.length > 0 ? nonTerminal.filter((row) => !irrelevantIds.includes(row.id)) : nonTerminal;
  const recovery = await (deps.loadRecovery ?? loadRecoveryState)(client, now);
  // Accounts the owner replied to recently sit out, so the queue shows other people. A lookup failure never blocks the queue.
  let cooldownAuthorKeys: Set<string> = new Set();
  try {
    const recent = await repo.listRepliedSince(new Date(now.getTime() - AUTHOR_COOLDOWN_DAYS * 24 * 60 * 60 * 1000));
    cooldownAuthorKeys = new Set(recent.map((r) => authorKeyOf(r)));
  } catch {
    cooldownAuthorKeys = new Set();
  }
  const selection = selectDailyWorkingSet(eligible.filter((row) => !overriddenIds.has(row.id)), now, { cooldownAuthorKeys });
  const { deferred, belowQualityBar } = selection;
  let { selected, tooOldForToday } = selection;
  if (recovery.active && recovery.maxPostAgeHours !== null) {
    // Recovery mode: only posts fresh enough that a reply can still be seen. Older ones count as too old for today.
    const cutoff = now.getTime() - recovery.maxPostAgeHours * 60 * 60 * 1000;
    const fresh = (c: ProspectingCandidate) => c.postCreatedAt !== null && new Date(c.postCreatedAt).getTime() >= cutoff;
    tooOldForToday = [...tooOldForToday, ...selected.filter((c) => !fresh(c))];
    selected = selected.filter(fresh);
  }
  selected = [...overridden, ...selected];

  // A post past the reply window is removed, not kept as backlog (owner 2026-11-08: a comment on an old post will not be seen, so it cannot
  // build traction). Status "expired" is terminal and the post is never re-discovered (upsertIfNew skips anything already on file).
  // Owner-chosen cards (Draft anyway) are exempt: they are held for 24 hours on purpose.
  const pastWindowIds = tooOldForToday.filter((c) => !overriddenIds.has(c.id)).map((c) => c.id);
  if (pastWindowIds.length > 0) {
    try {
      await Promise.all(pastWindowIds.map((id) => repo.updateStatus(id, "expired", { onlyFrom: [...NON_TERMINAL_STATUSES] })));
    } catch {
      // Never block the queue on cleanup; the next load tries again.
    }
  }

  const newIds = selected.filter((c) => c.status === "new").map((c) => c.id);
  await repo.markShown(newIds);
  const candidates = selected.map((c) => (newIds.includes(c.id) ? { ...c, status: "shown" as const } : c));

  // Two days back covers the rolling 24h cap plus the cooldown after the newest reply.
  const recentReplies = await repo.listRepliedSince(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));
  const pacing = computeReplyPacing(recentReplies.map((c) => c.repliedAt), now, recovery.dailyCap ?? undefined, recovery.active ? RECOVERY_REPLY_COOLDOWN_MS : undefined);

  const maybe = await listScreenedOutPosts(repo, now);

  return {
    candidates,
    pacing,
    recovery,
    maybe,
    diagnostics: {
      totalConsidered: eligible.length,
      selected: selected.length,
      deferred: deferred.length,
      belowQualityBar: belowQualityBar.length,
      tooOldForToday: tooOldForToday.length,
    },
  };
}

export async function listProspectingHistory(client: SupabaseClient, limit = 100, deps: ProspectingHandlerDeps = {}): Promise<ProspectingCandidate[]> {
  const repo = repoFor(client, deps);
  return repo.listByStatus(["replied", "skipped", "not_relevant", "already_handled", "expired"], limit);
}

/**
 * Option C (the Fillbook option, 2026-10-25): returned only when it is allowed, names Fillbook, picks one vetted view, has no link and
 * passes the same hard guardrails as the other options (banned phrases, unverified or profit claims, dashes, length). Anything else
 * drops it quietly; it must never cost the owner options A and B.
 */
export function acceptedFillbookOption(candidate: ProspectingDraftResult, allowed: boolean): DraftOption | null {
  const text = candidate.fillbookReply?.trim();
  if (!allowed || !text) return null;
  if (!namesFillbook(text)) return null;
  if (candidate.usesLink || !candidate.showcase || candidate.showcase === SHOWCASE_NONE || !SHOWCASE_IDS.includes(candidate.showcase)) return null;
  if (checkReplyGuardrails(text, false)) return null;
  if (optionSoftProblem("fillbook", text)) return null;
  return { style: "fillbook", text };
}

/**
 * Drafts exactly one reply for a human to review/edit/copy themselves --
 * same no-send guarantee as draftResponseForInbound. Persists the draft
 * and the model's own mentionsFillbook/usesLink flags (checked, not
 * assumed) so the app can show "this reply mentions Fillbook" honestly
 * before the owner even reads it. The candidate's own platform selects
 * the prompt profile.
 *
 * Three relevance gates, cheapest first, close a real, confirmed problem:
 * Prospecting surfacing content with zero connection to futures/trading,
 * AND paying for a full MODEL_SONNET drafting call every time content that
 * slipped past the free filter turned out not to be relevant anyway.
 * (1) prospectingRelevance.ts's mechanical, $0 regex pre-filter runs first
 * -- an obviously irrelevant candidate never reaches the LLM at all;
 * (2) checkRelevanceCheap (prospectingReplyWriter.ts), a MODEL_HAIKU-only
 * relevance question with no reply drafted, catches content that slips
 * past the regex without paying for a full draft; (3) the drafter's own
 * isRelevant flag is a final, independent check on the actual drafted
 * content for anything that still slips through. Any gate failing moves
 * the candidate to 'not_relevant' (the same terminal status the owner's
 * own "Irrelevant" button sets) and throws before any draft is persisted
 * or returned -- the owner never sees a draft that says the post is
 * unrelated.
 */
export async function draftProspectingCandidateReply(client: SupabaseClient, id: string, deps: ProspectingHandlerDeps = {}): Promise<ProspectingCandidate> {
  return draftCandidateCore(client, id, deps, false);
}

/**
 * "Draft anyway" (owner request 2026-10-26): the owner pulls a post out of the Maybe list that the AI relevance screen turned away.
 * Only a model-screen rejection of the last MAYBE_WINDOW_DAYS days is accepted. The two model relevance gates (cheap precheck and the
 * drafter's isRelevant) and the free regex pre-filter are skipped because the owner has judged the post; every other drafting rule
 * (voice rules, no link, no Fillbook in cold replies, recovery and mention-budget rules, claims, dashes, 280 characters, retries,
 * cost recording and the daily LLM ceiling) runs exactly as for a normal draft. Nothing is changed until a draft has been accepted:
 * on any failure the row stays in the Maybe list untouched. On success it becomes a normal 'ready' card marked owner_override.
 */
export async function draftScreenedOutPost(client: SupabaseClient, id: string, deps: ProspectingHandlerDeps = {}, now: Date = new Date()): Promise<ProspectingCandidate> {
  const repo = repoFor(client, deps);
  const row = await repo.getById(id);
  if (!row) throw new ProspectingActionError(`No prospecting_candidates row with id "${id}"`);
  // A double tap or retry after success: hand back the card that exists.
  if (row.status === "ready" && row.draftReply && row.scoreBreakdown?.[OWNER_OVERRIDE_KEY] === "true") return row;
  const since = now.getTime() - MAYBE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (row.status !== "not_relevant" || !MAYBE_REASONS.includes(row.skipReason ?? "") || Date.parse(row.updatedAt) < since) {
    throw new ProspectingConflictError("Only a post the AI screen turned away in the last 7 days can be drafted anyway.");
  }
  return draftCandidateCore(client, id, deps, true, row);
}

async function draftCandidateCore(
  client: SupabaseClient,
  id: string,
  deps: ProspectingHandlerDeps,
  ownerOverride: boolean,
  preloaded?: ProspectingCandidate,
): Promise<ProspectingCandidate> {
  const repo = repoFor(client, deps);
  const row = preloaded ?? (await repo.getById(id));
  if (!row) throw new ProspectingActionError(`No prospecting_candidates row with id "${id}"`);

  // Never pay for the same post twice (2026-10-14 cost cut). The app only offers "Draft reply" on a card with no
  // draft, so a second call here is a double tap or a stale client: hand back the draft that already exists. A card the
  // owner has already closed out is refused outright. Both return before any relevance check or model call.
  if (!ownerOverride && row.status === "ready" && row.draftReply) return row;
  if (!ownerOverride && TERMINAL_STATUSES.includes(row.status)) {
    throw new ProspectingActionError(`Not drafting -- this candidate is already ${row.status.replace("_", " ")}.`);
  }

  // APP-PR364-CONCURRENCY-1128: every write that ends a draft only lands while the row is still in a status a draft may start from, so a
  // draft still running can never undo a reply, skip or expiry the owner made meanwhile (or, for Draft anyway, a change to the Maybe row).
  const draftFrom: ProspectingStatus[] = ownerOverride ? ["not_relevant"] : [...NON_TERMINAL_STATUSES];
  const gateOpts = { trustedAuthor: isSeedCreator(row.authorHandle), authorHandle: row.authorHandle, authorName: row.authorName };
  // APP-DEFECT-1128: F1 to F5 outcomes are recorded (codes only) so the reply checks can be measured.
  const postChecks = postCheckResults(row.postText, gateOpts, ownerOverride);
  const checkLog = new ReplyCheckLog(ownerOverride, postChecks.f3, postChecks.f4, postChecks.gateReason);
  if (!ownerOverride && !isReplyWorthyPost(row.postText, gateOpts)) {
    const record = checkLog.build("gate_at_draft");
    logReplyChecks(record, id);
    await repo.updateStatus(id, "not_relevant", { skipReason: FREE_FILTER_REASON, breakdownPatch: replyChecksPatch(record), onlyFrom: draftFrom }).catch(ignoreWriteConflict);
    throw new ProspectingActionError(
      "Not eligible for drafting -- this post isn't about futures trading, prop-firm trading or trading discipline, or it's a newsletter/article rather than a conversation.",
    );
  }

  const draftContext: ProspectingDraftContext = {
    platform: row.platform,
    authorHandle: row.authorHandle,
    postText: row.postText,
    discoveryQuery: row.discoveryQuery,
  };

  const cheapRelevanceCheck =
    deps.cheapRelevanceCheck ??
    ((context: ProspectingDraftContext) => {
      const llmClient = createRecordedLlmClient(client, { step: "prospecting-relevance-check", tier: "owner", context: { prospectingCandidateId: id }, eventType: "prospecting_llm_call" });
      return checkRelevanceCheap(llmClient, context);
    });

  // Second, cheap (MODEL_HAIKU) relevance gate -- runs before the expensive
  // drafting call below so a post that clears the free regex filter but
  // isn't actually relevant gets rejected without paying for a full draft.
  const trustedCreator = isSeedCreator(row.authorHandle);
  // P2 2026-11-15: a watchlist creator gets the same checks as everyone else (trustedCreator no longer skips them).
  if (!ownerOverride && !(await cheapRelevanceCheck(draftContext))) {
    // Kept reachable from Maybe: an AI judgement the owner can overrule with Draft anyway.
    const record = checkLog.build("irrelevant_at_draft");
    logReplyChecks(record, id);
    await repo.updateStatus(id, "not_relevant", { skipReason: SCREENED_OUT_AT_DRAFT_REASON, breakdownPatch: replyChecksPatch(record), onlyFrom: draftFrom }).catch(ignoreWriteConflict);
    throw new ProspectingActionError("Not eligible for drafting -- a quick relevance check judged this post isn't genuinely relevant to futures/trading.");
  }

  const { brandRulesSummary, verifiedKnowledgeSummary } = await (deps.loadGrounding ?? loadGroundingContext)(client);
  const drafter =
    deps.drafter ??
    ((context: ProspectingDraftContext, brandRules: string, knowledge: string) => {
      const llmClient = createRecordedLlmClient(client, { step: "prospecting-draft", tier: "owner", context: { prospectingCandidateId: id }, eventType: "prospecting_llm_call" });
      return draftProspectingReply(llmClient, context, brandRules, knowledge);
    });

  draftContext.styleExamples = await (deps.loadStyleExamples ?? loadStyleExamples)(client);
  // Recovery mode: the draft must not name Fillbook at all while X is limiting the account's replies.
  const recovery = await (deps.loadRecovery ?? loadRecoveryState)(client, new Date());
  if (ownerOverride) draftContext.ownerOverrideNote = OWNER_OVERRIDE_DRAFT_NOTE;
  // P2 2026-11-15: no "treat as relevant" note for watchlist creators any more; the drafter judges their posts like any other.
  if (recovery.active) draftContext.recoveryNote = RECOVERY_DRAFT_NOTE;
  // Mention budget: once recent posted replies name Fillbook too often, this one must leave it out (same effect as recovery mode).
  const repliedThisWeek = await repo.listRepliedSince(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  const mentionBudget = computeMentionBudget(repliedThisWeek);
  // F1 (2026-11-21 audit): the most recent posted replies, newest first, so a new draft can be steered off a shape they all share.
  const recentReplyTexts = [...repliedThisWeek]
    .sort((a, b) => String(b.repliedAt ?? "").localeCompare(String(a.repliedAt ?? "")))
    .slice(0, LOG_LENS_RECENT_WINDOW)
    .map((c) => c.finalReply ?? c.draftReply ?? "");
  if (!recovery.active && mentionBudget.exhausted) draftContext.recoveryNote = MENTION_BUDGET_DRAFT_NOTE;
  const mustOmitFillbook = recovery.active || mentionBudget.exhausted;
  // Option C (the Fillbook option) is offered unless recovery mode or the mention budget says to leave Fillbook out.
  draftContext.fillbookOption = (deps.fillbookOptionEnabled ?? FILLBOOK_OPTION_ENABLED) && !mustOmitFillbook;
  // Occasional tag (about 1 draft in 5): only an account the post itself names. Closed otherwise, and replyTagProblem then rejects any @handle.
  const allowedTags = tagGateOpen(id) ? taggableHandles(row.postText, row.authorHandle) : [];
  if (allowedTags.length > 0) draftContext.tagNote = tagNote(allowedTags);
  // A draft with a real problem (banned phrase, link, unverified claim, dash, over X's length limit) is
  // regenerated with the reason fed back, up to MAX_DRAFT_ATTEMPTS, and never shown. A draft with only a
  // soft style tell ("most traders", a question tacked on the end, too many sentences) gets ONE retry and
  // is then shown as the best attempt, since the owner edits every reply anyway.
  //
  // Two-option mode (reply-style experiment): one model call returns a sharp reply (`reply`) and a helpful one
  // (`helpfulReply`). Each option is checked on its own; if one fails a hard check the whole call is retried with that
  // option named, and if the attempts run out with one option still clean, that single clean option is shown.
  let bestPartial: { candidate: ProspectingDraftResult; option: DraftOption } | null = null;
  const postInvitesFillbook = postMentionsFillbook(row.postText);
  const { draft: accepted, hardReason } = await draftWithRetries({
    generate: (retryFeedback) => drafter(retryFeedback ? { ...draftContext, retryFeedback } : draftContext, brandRulesSummary, verifiedKnowledgeSummary),
    assess: (candidate) => {
      // Third, independent relevance gate -- the model's own honest judgment,
      // for content that slipped past both the mechanical pre-filter and the
      // cheap Haiku check above (e.g. a post that uses real trading vocabulary
      // but in a fundamentally different, still-irrelevant context). Same
      // terminal status and no persisted draft as the earlier gates.
      if (!ownerOverride && !candidate.isRelevant) {
        checkLog.addAttempt(candidate, false, []);
        throw new ProspectingIrrelevantSignal();
      }
      // Same checks in the same order as before; each step is kept apart only so F1 and F2 can be recorded as pass, hit or not run.
      const factCheck = (text: string, guardReason: string | null): { reason: string | null; result: CheckResult } => {
        if (guardReason) return { reason: null, result: "not_run" };
        const reason = unsupportedFactProblem(text, row.postText);
        return { reason, result: reason ? "hit" : "pass" };
      };
      if (candidate.helpfulReply !== undefined) {
        const options: DraftOption[] = [
          { style: "sharp", text: candidate.reply },
          { style: "helpful", text: candidate.helpfulReply },
        ];
        const hardFor = (option: DraftOption): { reason: string | null; f2: CheckResult } => {
          const guard = checkReplyGuardrails(option.text, false)?.reason ?? null;
          const fact = factCheck(option.text, guard);
          const reason =
            guard ??
            fact.reason ??
            replyTagProblem(option.text, allowedTags) ??
            (candidate.usesLink ? "declares a link; cold replies never include one" : null) ??
            (mustOmitFillbook && namesFillbook(option.text)
              ? recovery.active
                ? "names Fillbook while recovery mode is on -- leave the product out entirely"
                : "names Fillbook but recent replies already pitch it too often -- leave the product out entirely"
              : null) ??
            (!postInvitesFillbook && namesFillbook(option.text) ? "names Fillbook in a cold reply -- the post did not ask about it, so leave the product out" : null);
          return { reason, f2: fact.result };
        };
        const softFor = (option: DraftOption): { reason: string | null; f1: CheckResult; otherSoft: boolean } => {
          const other = optionSoftProblem(option.style, option.text);
          if (other || option.style !== "helpful") return { reason: other, f1: "not_run", otherSoft: other !== null };
          const lens = logLensProblem(option.text, recentReplyTexts);
          return { reason: lens, f1: lens ? "hit" : "pass", otherSoft: false };
        };
        const checked = options.map((o) => ({ option: o, hardCheck: hardFor(o), softCheck: softFor(o) }));
        checkLog.addAttempt(
          candidate,
          true,
          checked.map(
            (c): OptionCheck => ({
              style: c.option.style === "sharp" ? "sharp" : "helpful",
              f1: c.softCheck.f1,
              f2: c.hardCheck.f2,
              otherHard: c.hardCheck.reason !== null && c.hardCheck.f2 !== "hit",
              otherSoft: c.softCheck.otherSoft,
            }),
          ),
        );
        const verdicts = checked.map((c) => ({ option: c.option, hard: c.hardCheck.reason, soft: c.softCheck.reason }));
        const label = (o: DraftOption) => (o.style === "sharp" ? "The sharp option" : "The helpful option");
        const badHard = verdicts.find((v) => v.hard);
        if (badHard) {
          const clean = verdicts.filter((v) => !v.hard);
          if (clean.length === 1) bestPartial = { candidate, option: clean[0]!.option };
          return { hard: `${label(badHard.option)} ${badHard.hard}`, soft: null, rejectedText: badHard.option.text };
        }
        const badSoft = verdicts.find((v) => v.soft);
        return badSoft ? { hard: null, soft: `${label(badSoft.option)} ${badSoft.soft}`, rejectedText: badSoft.option.text } : { hard: null, soft: null };
      }
      // Mechanical, $0 safety net -- catches banned generic phrases, an
      // unexplained link, and unverified performance/customer claims
      // regardless of what the model's own mentionsFillbook/usesLink flags
      // say. A hard violation is never persisted or shown to the owner.
      const guard = checkReplyGuardrails(candidate.reply, candidate.usesLink)?.reason ?? null;
      const fact = factCheck(candidate.reply, guard);
      const hard =
        guard ??
        fact.reason ??
        replyTagProblem(candidate.reply, allowedTags) ??
        (mustOmitFillbook && namesFillbook(candidate.reply)
          ? recovery.active
            ? "names Fillbook while recovery mode is on -- leave the product out entirely"
            : "names Fillbook but recent replies already pitch it too often -- leave the product out entirely"
          : null);
      const soft = (checkReplySoftStyle(candidate.reply) ?? checkShowcaseShown(candidate.reply, candidate.showcase))?.reason ?? null;
      checkLog.addAttempt(candidate, true, [{ style: "single", f1: "not_run", f2: fact.result, otherHard: hard !== null && fact.result !== "hit", otherSoft: soft !== null }]);
      return { hard, soft };
    },
  }).catch(async (err) => {
    if (err instanceof ProspectingIrrelevantSignal) {
      const record = checkLog.build("irrelevant_at_draft");
      logReplyChecks(record, id);
      await repo.updateStatus(id, "not_relevant", { skipReason: SCREENED_OUT_AT_DRAFT_REASON, breakdownPatch: replyChecksPatch(record), onlyFrom: draftFrom }).catch(ignoreWriteConflict);
      throw new ProspectingActionError("Not eligible for drafting -- the model judged this post isn't genuinely relevant to futures/trading.");
    }
    throw err;
  });
  if (!accepted && !bestPartial) {
    // Logged only: a rejected draft leaves the row untouched (draftScreenedOutPost promises the Maybe row is not changed on failure).
    logReplyChecks(checkLog.build("rejected_hard"), id);
    throw new ProspectingActionError(`Draft rejected -- ${hardReason}. Try drafting again.`);
  }
  const draft = accepted ?? bestPartial!.candidate;
  let options: DraftOption[] | null = null;
  if (accepted) {
    if (accepted.helpfulReply !== undefined) {
      options = [
        { style: "sharp", text: accepted.reply },
        { style: "helpful", text: accepted.helpfulReply },
      ];
      // Option C never blocks A and B: if it is missing, not allowed, names no vetted view, or fails a hard check, it is simply left out.
      const fillbook = acceptedFillbookOption(accepted, !mustOmitFillbook);
      if (fillbook) options.push(fillbook);
    }
  } else {
    options = [bestPartial!.option];
  }
  // Owner rule 2026-11-04: a two-part reply shows as two short paragraphs, not one run-on block. Whitespace only, after the checks.
  if (options) options = options.map((o) => ({ ...o, text: paragraphizeReply(o.text) }));

  // Swaps the model's static placeholder link for a real per-candidate
  // short link (see trackableLinks.ts) -- closes the "per-reply link
  // attribution isn't real yet" gap. A no-op when usesLink is false (the
  // common case), since the placeholder never appears in the reply then.
  const finalReply = paragraphizeReply(
    draft.usesLink
      ? substituteTrackableLink(draft.reply, PROSPECTING_TRACKABLE_LINK, buildTrackableReplyLink(`prospecting:${id}`, "prospecting", id))
      : draft.reply,
  );

  const shownRecord = accepted
    ? checkLog.build("shown_clean", accepted)
    : checkLog.build("shown_one_option", bestPartial!.candidate, [bestPartial!.option.style === "sharp" ? "sharp" : "helpful"]);
  const checkRecord = accepted && shownRecord.shownWithSoft ? { ...shownRecord, disposition: "shown_soft_flag" as const } : shownRecord;
  logReplyChecks(checkRecord, id);
  // draftReply is always the first option's text so older app builds (which only know draftReply) keep working.
  const saved = await repo
    .updateStatus(id, "ready", {
      draftReply: options ? options[0]!.text : finalReply,
      ...(options ? { draftOptions: options } : {}),
      replyMentionsFillbook: options ? options.some((o) => namesFillbook(o.text)) : namesFillbook(finalReply),
      replyUsedLink: draft.usesLink,
      breakdownPatch: {
        ...replyChecksPatch(checkRecord),
        ...(ownerOverride ? { [OWNER_OVERRIDE_KEY]: "true", [OWNER_OVERRIDE_AT_KEY]: new Date().toISOString() } : {}),
      },
      onlyFrom: draftFrom,
    })
    .catch((err) => {
      if (!(err instanceof ProspectingWriteConflictError)) throw err;
      // Nothing was written and nothing is redrafted automatically; handled below exactly like a write that did not land.
      return false;
    });
  if (saved === false) {
    // The row moved on while this draft was being written (replied, skipped, handled, filtered out, expired, another draft finished
    // first, or other writes kept landing at the same moment): keep what is stored. A card another draft already filled (a double tap)
    // is handed back as it is.
    logReplyChecks({ ...checkRecord, disposition: "discarded_row_changed" }, id);
    const current = await repo.getById(id);
    if (current && current.status === "ready" && current.draftReply) return current;
    // ProspectingActionError (HTTP 404), like the other "Not drafting" refusals, so the app shows this message.
    if (current && draftFrom.includes(current.status)) {
      throw new ProspectingActionError("Not drafting -- another change to this post was being saved at the same moment, so the draft was not saved. Try drafting again.");
    }
    throw new ProspectingActionError(
      `Not drafting -- this post changed while the draft was being written (it is now ${(current?.status ?? "gone").replace("_", " ")}), so the draft was not saved.`,
    );
  }

  const updated = await repo.getById(id);
  if (!updated) throw new ProspectingActionError(`Row "${id}" vanished after drafting`);
  return updated;
}

/** Records that the owner tapped "Copy + Open <platform>" -- doesn't change status, just timestamps it for staleness/analytics. */
export async function markProspectingOpened(client: SupabaseClient, id: string, deps: ProspectingHandlerDeps = {}): Promise<void> {
  const repo = repoFor(client, deps);
  const row = await repo.getById(id);
  if (!row) throw new ProspectingActionError(`No prospecting_candidates row with id "${id}"`);
  // Only while the status is still the one read, so this timestamp can never undo a reply or a fresh draft made meanwhile.
  await repo.updateStatus(id, row.status, { openedAt: new Date().toISOString(), onlyFrom: [row.status] });
}

/**
 * The one status a human, not this code, ever sets after actually posting
 * on the platform themselves -- mirrors markInboundResponded's contract
 * exactly (nothing here calls any X write endpoint; ExternalWriteFirewall
 * would reject it regardless). Also records outreach against the author IN
 * THE CANDIDATE'S OWN PLATFORM NAMESPACE so Inbound's
 * hasExistingRelationship check recognizes them if they reply back later
 * (see inboundIngestion.ts, which looks up outreach by platform).
 */
/** Statuses a post can be marked replied from. "expired" is included: a card can age out of the 12-hour window while the owner is posting. */
export const REPLIABLE_STATUSES: ProspectingStatus[] = ["new", "shown", "drafting", "ready", "expired"];

/** Thrown when the reply pacing says to wait (maps to HTTP 409 with reason "pacing"). */
export class ProspectingPacingError extends ProspectingConflictError {
  constructor(
    message: string,
    readonly nextReplyAt: string | null,
  ) {
    super(message);
  }
}

export interface MarkRepliedResult {
  candidate: ProspectingCandidate;
  /** False when the post was already marked replied: nothing was counted again and no refill should start. */
  recorded: boolean;
}

/**
 * Records a reply once (ChatGPT P0 2026-11-15): a second tap or a retry returns the row unchanged instead of counting outreach again and
 * starting another refill; skipped / not relevant / handled posts are refused; and the reply pacing (cooldown and daily cap) is enforced here,
 * not only shown in the app.
 */
export async function markProspectingRepliedOnce(
  client: SupabaseClient,
  id: string,
  finalReply: string | undefined,
  mentionsFillbook: boolean | undefined,
  usedLink: boolean | undefined,
  deps: ProspectingHandlerDeps = {},
  nowDate: Date = new Date(),
): Promise<MarkRepliedResult> {
  const repo = repoFor(client, deps);
  const row = await repo.getById(id);
  if (!row) throw new ProspectingActionError(`No prospecting_candidates row with id "${id}"`);
  if (row.status === "replied") return { candidate: row, recorded: false };
  if (!REPLIABLE_STATUSES.includes(row.status)) {
    throw new ProspectingConflictError(`This post is marked "${row.status}", so it can't be marked replied.`);
  }
  const recovery = await (deps.loadRecovery ?? loadRecoveryState)(client, nowDate);
  const recent = await repo.listRepliedSince(new Date(nowDate.getTime() - 2 * 24 * 60 * 60 * 1000));
  const pacing = computeReplyPacing(recent.map((c) => c.repliedAt), nowDate, recovery.dailyCap ?? undefined, recovery.active ? RECOVERY_REPLY_COOLDOWN_MS : undefined);
  if (pacing.reason) {
    throw new ProspectingPacingError(
      pacing.reason === "daily_cap" ? `Today's ${pacing.dailyCap} replies are done.` : `Wait ${pacing.cooldownMinutes} minutes between replies.`,
      pacing.nextReplyAt,
    );
  }

  const now = nowDate.toISOString();
  // Record which style was actually posted: no finalReply means the app posted the draft as it was (the first option).
  const postedText = finalReply && finalReply.trim() ? finalReply : row.draftReply;
  const postedFlag = postedText ? namesFillbook(postedText) : null;
  const moved = await repo.updateStatus(id, "replied", {
    repliedAt: now,
    postedStyle: matchPostedStyle(postedText, row.draftOptions, row.draftReply),
    finalReply: finalReply && finalReply !== row.draftReply ? finalReply : undefined,
    // F5 (2026-11-21 audit): the flag follows the text that was actually posted, after any edit, never a stale or model-set flag.
    replyMentionsFillbook: postedFlag ?? (mentionsFillbook ?? row.replyMentionsFillbook ?? undefined),
    replyUsedLink: usedLink ?? row.replyUsedLink ?? undefined,
    // APP-DEFECT-1128: whether F5 had to change the stored flag ("hit"), kept it ("pass"), or had no text to read ("not_run").
    breakdownPatch: { [REPLY_CHECK_F5_KEY]: f5Result(postedText, row.replyMentionsFillbook, postedFlag ?? false) },
    onlyFrom: REPLIABLE_STATUSES,
  }).catch((err) => {
    if (!(err instanceof ProspectingWriteConflictError)) throw err;
    // Nothing was written and nothing counted: the owner can tap Replied again.
    throw new ProspectingConflictError("Another change to this post was being saved at the same moment, so it was not marked replied. Try again.");
  });
  if (moved === false) {
    // Another tap got there first (or the row changed): report what is stored, count nothing twice.
    const current = await repo.getById(id);
    if (!current) throw new ProspectingActionError(`Row "${id}" vanished after marking replied`);
    if (current.status === "replied") return { candidate: current, recorded: false };
    throw new ProspectingConflictError(`This post is marked "${current.status}", so it can't be marked replied.`);
  }

  if (row.authorExternalId) {
    await repo.recordOutreach(row.platform, row.authorExternalId, row.authorHandle);
  }

  const updated = await repo.getById(id);
  if (!updated) throw new ProspectingActionError(`Row "${id}" vanished after marking replied`);
  return { candidate: updated, recorded: true };
}

/** Same as markProspectingRepliedOnce, returning only the row. */
export async function markProspectingReplied(
  client: SupabaseClient,
  id: string,
  finalReply: string | undefined,
  mentionsFillbook: boolean | undefined,
  usedLink: boolean | undefined,
  deps: ProspectingHandlerDeps = {},
): Promise<ProspectingCandidate> {
  return (await markProspectingRepliedOnce(client, id, finalReply, mentionsFillbook, usedLink, deps)).candidate;
}

export async function markProspectingSkipped(client: SupabaseClient, id: string, reason: string | undefined, deps: ProspectingHandlerDeps = {}): Promise<void> {
  const repo = repoFor(client, deps);
  const row = await repo.getById(id);
  if (!row) throw new ProspectingActionError(`No prospecting_candidates row with id "${id}"`);
  await repo.updateStatus(id, "skipped", { skipReason: reason ?? null });
}

export async function markProspectingNotRelevant(client: SupabaseClient, id: string, deps: ProspectingHandlerDeps = {}): Promise<void> {
  const repo = repoFor(client, deps);
  const row = await repo.getById(id);
  if (!row) throw new ProspectingActionError(`No prospecting_candidates row with id "${id}"`);
  await repo.updateStatus(id, "not_relevant");
}

export async function markProspectingAlreadyHandled(client: SupabaseClient, id: string, deps: ProspectingHandlerDeps = {}): Promise<void> {
  const repo = repoFor(client, deps);
  const row = await repo.getById(id);
  if (!row) throw new ProspectingActionError(`No prospecting_candidates row with id "${id}"`);
  await repo.updateStatus(id, "already_handled");
}

/** A not_relevant write at draft time that kept missing a concurrent write is skipped: the row stays as it is, and the next Draft tap runs the checks again. */
function ignoreWriteConflict(err: unknown): boolean {
  if (err instanceof ProspectingWriteConflictError) return false;
  throw err;
}
