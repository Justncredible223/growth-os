import { replyTagProblem, tagGateOpen, tagNote, taggableHandles } from "./prospectingTagging.js";
import { RECOVERY_REPLY_COOLDOWN_MS, computeReplyPacing, type ReplyPacing } from "./prospectingPacing.js";
import { RECOVERY_DRAFT_NOTE, loadRecoveryState, namesFillbook, type RecoveryState } from "./prospectingRecovery.js";
import { MENTION_BUDGET_DRAFT_NOTE, computeMentionBudget } from "./prospectingMentionBudget.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRecordedLlmClient } from "../cost/recordedLlmClient.js";
import { loadGroundingContext } from "../inbound/inboundHandlers.js";
import { selectDailyWorkingSet } from "./prospectingDailySelection.js";
import { STALE_EXPIRY_DAYS } from "./prospectingEligibility.js";
import { checkRelevanceCheap, draftProspectingReply, PROSPECTING_TRACKABLE_LINK, type ProspectingDraftContext, type ProspectingDraftResult } from "./prospectingReplyWriter.js";
import { checkReplyGuardrails, checkReplySoftStyle, checkShowcaseShown, draftWithRetries } from "../content/xReplyGuardrails.js";
import { buildTrackableReplyLink, substituteTrackableLink } from "../content/trackableLinks.js";
import { isReplyWorthyPost, isTooSmallToBeWorthIt } from "./prospectingRelevance.js";
import { matchPostedStyle, optionSoftProblem, postMentionsFillbook, type DraftOption } from "./prospectingDraftOptions.js";
import { loadStyleExamples, type StyleExample } from "./prospectingStyleExamples.js";
import { discoveryLabelForKey, replyClassForKey } from "./prospectingTopics.js";
import { SHOWCASE_IDS, SHOWCASE_NONE } from "../content/fillbookShowcase.js";
import { SupabaseProspectingRepository } from "./supabaseProspectingRepository.js";
import { OWNER_OVERRIDE_AT_KEY, OWNER_OVERRIDE_KEY, OWNER_OVERRIDE_VISIBLE_MS, SCREENED_OUT_REASON, type ProspectingCandidate, type ProspectingRepository } from "./types.js";

/** Thrown from inside the draft-retry loop when the model says the post is irrelevant, so the loop stops without retrying. */
class ProspectingIrrelevantSignal extends Error {}

export class ProspectingActionError extends Error {}

/** The request is well formed but the row is not in a state the action accepts (maps to HTTP 409). */
export class ProspectingConflictError extends ProspectingActionError {}

/** Added to the drafter's user message when the owner chose to reply to a post the relevance screen turned away. */
export const OWNER_OVERRIDE_DRAFT_NOTE =
  "The owner has chosen to reply to this post themselves, even though an automatic screen thought it a weak fit. Write the best reply you can under every rule above. If it is a poor fit, still write a short, specific, harmless reply rather than declining, and set isRelevant to true.";

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
}

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
  const irrelevantIds = nonTerminal.filter((row) => !overriddenIds.has(row.id)).filter((row) => !isReplyWorthyPost(row.postText) || isTooSmallToBeWorthIt(row.authorFollowerCount)).map((row) => row.id);
  if (irrelevantIds.length > 0) {
    await Promise.all(irrelevantIds.map((id) => repo.updateStatus(id, "not_relevant")));
  }
  const eligible = irrelevantIds.length > 0 ? nonTerminal.filter((row) => !irrelevantIds.includes(row.id)) : nonTerminal;
  const recovery = await (deps.loadRecovery ?? loadRecoveryState)(client, now);
  const selection = selectDailyWorkingSet(eligible.filter((row) => !overriddenIds.has(row.id)), now);
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
  if (row.status !== "not_relevant" || row.skipReason !== SCREENED_OUT_REASON || Date.parse(row.updatedAt) < since) {
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

  if (!ownerOverride && !isReplyWorthyPost(row.postText)) {
    await repo.updateStatus(id, "not_relevant");
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
  if (!ownerOverride && !(await cheapRelevanceCheck(draftContext))) {
    await repo.updateStatus(id, "not_relevant");
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
  if (recovery.active) draftContext.recoveryNote = RECOVERY_DRAFT_NOTE;
  // Mention budget: once recent posted replies name Fillbook too often, this one must leave it out (same effect as recovery mode).
  const mentionBudget = computeMentionBudget(await repo.listRepliedSince(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  if (!recovery.active && mentionBudget.exhausted) draftContext.recoveryNote = MENTION_BUDGET_DRAFT_NOTE;
  const mustOmitFillbook = recovery.active || mentionBudget.exhausted;
  // Option C (the Fillbook option) is offered unless recovery mode or the mention budget says to leave Fillbook out.
  draftContext.fillbookOption = !mustOmitFillbook;
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
        throw new ProspectingIrrelevantSignal();
      }
      if (candidate.helpfulReply !== undefined) {
        const options: DraftOption[] = [
          { style: "sharp", text: candidate.reply },
          { style: "helpful", text: candidate.helpfulReply },
        ];
        const hardFor = (option: DraftOption): string | null =>
          checkReplyGuardrails(option.text, false)?.reason ??
          replyTagProblem(option.text, allowedTags) ??
          (candidate.usesLink ? "declares a link; cold replies never include one" : null) ??
          (mustOmitFillbook && namesFillbook(option.text)
            ? recovery.active
              ? "names Fillbook while recovery mode is on -- leave the product out entirely"
              : "names Fillbook but recent replies already pitch it too often -- leave the product out entirely"
            : null) ??
          (!postInvitesFillbook && namesFillbook(option.text) ? "names Fillbook in a cold reply -- the post did not ask about it, so leave the product out" : null);
        const verdicts = options.map((o) => ({ option: o, hard: hardFor(o), soft: optionSoftProblem(o.style, o.text) }));
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
      return {
        hard:
          checkReplyGuardrails(candidate.reply, candidate.usesLink)?.reason ??
          replyTagProblem(candidate.reply, allowedTags) ??
          (mustOmitFillbook && namesFillbook(candidate.reply)
            ? recovery.active
              ? "names Fillbook while recovery mode is on -- leave the product out entirely"
              : "names Fillbook but recent replies already pitch it too often -- leave the product out entirely"
            : null),
        soft: (checkReplySoftStyle(candidate.reply) ?? checkShowcaseShown(candidate.reply, candidate.showcase))?.reason ?? null,
      };
    },
  }).catch(async (err) => {
    if (err instanceof ProspectingIrrelevantSignal) {
      await repo.updateStatus(id, "not_relevant");
      throw new ProspectingActionError("Not eligible for drafting -- the model judged this post isn't genuinely relevant to futures/trading.");
    }
    throw err;
  });
  if (!accepted && !bestPartial) {
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

  // Swaps the model's static placeholder link for a real per-candidate
  // short link (see trackableLinks.ts) -- closes the "per-reply link
  // attribution isn't real yet" gap. A no-op when usesLink is false (the
  // common case), since the placeholder never appears in the reply then.
  const finalReply = draft.usesLink
    ? substituteTrackableLink(draft.reply, PROSPECTING_TRACKABLE_LINK, buildTrackableReplyLink(`prospecting:${id}`, "prospecting", id))
    : draft.reply;

  // draftReply is always the first option's text so older app builds (which only know draftReply) keep working.
  await repo.updateStatus(id, "ready", {
    draftReply: options ? options[0]!.text : finalReply,
    ...(options ? { draftOptions: options } : {}),
    replyMentionsFillbook: options ? options.some((o) => o.style === "fillbook") || draft.mentionsFillbook : draft.mentionsFillbook,
    replyUsedLink: draft.usesLink,
    ...(ownerOverride ? { breakdownPatch: { [OWNER_OVERRIDE_KEY]: "true", [OWNER_OVERRIDE_AT_KEY]: new Date().toISOString() } } : {}),
  });

  const updated = await repo.getById(id);
  if (!updated) throw new ProspectingActionError(`Row "${id}" vanished after drafting`);
  return updated;
}

/** Records that the owner tapped "Copy + Open <platform>" -- doesn't change status, just timestamps it for staleness/analytics. */
export async function markProspectingOpened(client: SupabaseClient, id: string, deps: ProspectingHandlerDeps = {}): Promise<void> {
  const repo = repoFor(client, deps);
  const row = await repo.getById(id);
  if (!row) throw new ProspectingActionError(`No prospecting_candidates row with id "${id}"`);
  await repo.updateStatus(id, row.status, { openedAt: new Date().toISOString() });
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
export async function markProspectingReplied(
  client: SupabaseClient,
  id: string,
  finalReply: string | undefined,
  mentionsFillbook: boolean | undefined,
  usedLink: boolean | undefined,
  deps: ProspectingHandlerDeps = {},
): Promise<ProspectingCandidate> {
  const repo = repoFor(client, deps);
  const row = await repo.getById(id);
  if (!row) throw new ProspectingActionError(`No prospecting_candidates row with id "${id}"`);

  const now = new Date().toISOString();
  // Record which style was actually posted: no finalReply means the app posted the draft as it was (the first option).
  const postedText = finalReply && finalReply.trim() ? finalReply : row.draftReply;
  await repo.updateStatus(id, "replied", {
    repliedAt: now,
    postedStyle: matchPostedStyle(postedText, row.draftOptions, row.draftReply),
    finalReply: finalReply && finalReply !== row.draftReply ? finalReply : undefined,
    replyMentionsFillbook: mentionsFillbook ?? row.replyMentionsFillbook ?? undefined,
    replyUsedLink: usedLink ?? row.replyUsedLink ?? undefined,
  });

  if (row.authorExternalId) {
    await repo.recordOutreach(row.platform, row.authorExternalId, row.authorHandle);
  }

  const updated = await repo.getById(id);
  if (!updated) throw new ProspectingActionError(`Row "${id}" vanished after marking replied`);
  return updated;
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
