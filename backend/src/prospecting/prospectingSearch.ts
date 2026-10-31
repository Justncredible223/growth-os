import type { SupabaseClient } from "@supabase/supabase-js";
import type { XSignalAdapter } from "../signals/adapters/xAdapter.js";
import { X_SEARCH_COST_PER_READ_USD, recordXSearchCostEvent } from "../cost/costTracking.js";
import { PROSPECTING_TOPICS, topicsInSearchOrder, type ProspectingTopic } from "./prospectingTopics.js";
import { isReplyWorthyBase, isReplyWorthyPost, isSalesFunnelOrEmptyPost, isTooSmallToBeWorthIt, whyNotReplyWorthy, withCryptoExclusions } from "./prospectingRelevance.js";
import { scoreProspectingCandidate } from "./prospectingScoring.js";
import {
  DAILY_SEARCH_BUDGET_USD,
  DAILY_SEARCH_CAP,
  RESULTS_PER_QUERY,
  VET_MAX_PER_RUN,
  currentRunSlot,
  evaluateMonthlyBudget,
  evaluateQueueCapacity,
  planSearchBreadth,
  runSlotsPerDay,
  selectPrioritizedTopicsForRun,
} from "./prospectingEligibility.js";
import { MAX_AGE_FOR_DAILY_SELECTION_MS, isEligibleForDailySelection } from "./prospectingFreshness.js";
import { MIN_DAILY_SET_SCORE, selectDailyWorkingSet } from "./prospectingDailySelection.js";
import { MIN_WATCHLIST_SIZE, PROSPECTING_SEED_CREATORS, isSeedCreator, WATCHLIST_LOOKBACK_DAYS, buildWatchlist, chunkWatchlist, parseHandleList, watchlistQuery } from "./prospectingWatchlist.js";
import type { ProspectingRepository } from "./types.js";

export interface ProspectingRunResult {
  skipped: boolean;
  skipReason?: string;
  topicsSearched: string[];
  postsRead: number;
  newCandidates: number;
  excludedAsSpam: number;
  /**
   * Rejected by prospectingRelevance.ts's isPlausiblyTradingRelated before
   * ever being stored -- real, confirmed problem (2026-09-28 owner report:
   * 70-80% of stored candidates were getting swept to 'not_relevant'):
   * this same $0 regex gate already ran at queue-read time
   * (prospectingHandlers.ts's listProspectingQueue), but never at
   * discovery/insert time here, so every crypto/prop-firm-ad/stock-
   * newsletter post a broad topic query like "drawdown" or "risk
   * management" pulled in got written to prospecting_candidates first and
   * only reclassified as not_relevant the next time the queue was
   * fetched. Checking it here instead means that noise is never written
   * at all.
   */
  excludedAsIrrelevant: number;
  costUsd: number;
  /** Candidates already waiting in today's working set when this run started (null when the run stopped before counting). */
  selectableBefore?: number | null;
  /** Candidates in today's working set when the run ended. */
  selectableAfter?: number | null;
  /** X search requests this run made (one per topic searched). */
  searchRequests?: number;
  /** New posts the cheap model relevance check turned away before they could reach the queue. */
  screenedOut?: number;
  /** How many of this run's X requests read the creator watchlist instead of searching topics. */
  creatorRequests?: number;
}

/** Rows scanned to count what is waiting. Was QUEUE_FULL_THRESHOLD + 1; the selectable count needs the whole backlog (the queue endpoint reads up to 500). */
const BACKLOG_SCAN_LIMIT = 200;

export interface ProspectingRunDeps {
  adapter: XSignalAdapter;
  repo: ProspectingRepository;
  client: SupabaseClient;
  /** Sum of cost_events.cost_usd for event_type IN ('llm_call','x_search_read') this calendar month -- same "real recorded spend, not estimate" contract as autoDraftEligibility. */
  getMonthSpendUsd: () => Promise<number>;
  /**
   * Same system_settings.paused gate already used by autoDraftStep.ts and
   * buildXFeedPostStepDeps.ts, applied here too -- runProspectingSearch has
   * exactly one caller anywhere in this codebase (growth-pulse.ts's
   * scheduled x_prospecting step; there is no owner-triggered "search now"
   * endpoint), so checking this unconditionally, first, before even the
   * monthly-budget/queue-capacity checks, closes the gap where a paused
   * system still spent real X-search cost 3x/day. Optional and defaults to
   * "not paused" so existing tests that never cared about pause behavior
   * don't need to start passing a dep they have no opinion about.
   */
  isPaused?: () => Promise<boolean>;
  now?: Date;
  /**
   * The cheap model relevance check (about $0.001 a post), run on the best new posts BEFORE they can reach the queue, so everything
   * the owner is shown is already vetted (2026-10-24: the owner was tapping Search now four or five times to get one post that
   * was futures prop-firm or own-capital relevant). Returns false to turn a post away. Optional; omitted means no screening.
   * A thrown error counts as relevant: a failed check must never hide a post.
   */
  screenRelevance?: (post: { postText: string; discoveryQuery: string; authorHandle: string | null }) => Promise<boolean>;
  /** How many X search requests have been recorded today (Arizona day). Omitted means no daily limit is applied. */
  getTodaySearchCount?: () => Promise<number>;
  /** X search dollars recorded today (Arizona day): the real daily limit (DAILY_SEARCH_BUDGET_USD). Omitted means no daily spend limit is applied. */
  getTodaySearchSpendUsd?: () => Promise<number>;
  /** The query strings of the X searches made in the last RECENT_QUERY_WINDOW_MS. A topic search whose query is among them is not repeated (2026-10-28). */
  getRecentSearchQueries?: () => Promise<Set<string>>;
  /**
   * Overrides which run-index's topic slice gets searched, bypassing the
   * normal day/schedule-slot rotation. Used by the owner-triggered manual
   * "search now" path (api/ingest.ts?source=x_prospecting) so a manual run
   * doesn't just re-search whatever the next scheduled slot would already
   * cover -- the scheduled caller (growth-pulse.ts) never passes this, so
   * its rotation is completely unaffected.
   */
  runIndexOverride?: number;
  /** Added to the run index so refills made between the scheduled slots start from a different topic than the last search (does not make the run a manual one). */
  runIndexOffset?: number;
  /** Creator handles always on the watchlist (no @), on top of PROSPECTING_SEED_CREATORS and the PROSPECTING_WATCHLIST_HANDLES environment variable. */
  watchlistSeeds?: readonly string[];
  /** Whether authors with merely vetted posts join the watchlist (default true); production turns it off so only seeds and replied-to creators remain. */
  watchlistIncludeVetted?: boolean;
  /** Whether the creator watchlist is read at all (default true). Production turns it off (2026-10-27): its streams were forex, crypto and news accounts, nearly all dropped, so the whole budget goes to topic searches. */
  watchlistEnabled?: boolean;
  /** Production reads only the hand-picked PROSPECTING_SEED_CREATORS (2026-10-30): no replied-to or environment-variable handles, which brought in noise accounts. */
  watchlistSeedsOnly?: boolean;
}

/**
 * A topic search already made this recently is not made again. X's recent search returns the same newest posts for the same query, so a
 * repeat read the same ~10 posts (all duplicates) and cost the same $0.05; three repeats in 14 seconds were seen on 2026-10-29.
 */
export const RECENT_QUERY_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Topics searched together in one X request (OR-ed): one near-empty request per narrow topic was burning the daily limit (2026-10-25). */
export const TOPICS_PER_QUERY = 4;
/** X allows 512 characters in a query; the wrapper (futures anchors, exclusions, -is:retweet -is:reply lang:en) takes about 270. */
const MAX_GROUPED_QUERY_CHARS = 180;

/** One X query that finds any of these topics: each topic's own query in parentheses, OR-ed, as many as fit. */
export function groupedTopicQuery(topics: ProspectingTopic[]): { query: string; used: ProspectingTopic[] } {
  const used: ProspectingTopic[] = [];
  let query = "";
  for (const topic of topics) {
    const next = query ? `${query} OR (${topic.query})` : `(${topic.query})`;
    if (next.length > MAX_GROUPED_QUERY_CHARS && used.length > 0) break;
    query = next;
    used.push(topic);
  }
  return { query, used };
}

/** Phrases a topic's query asks for: its quoted phrases, else its bare words. Lower-cased. */
function topicTerms(topic: ProspectingTopic): string[] {
  const quoted = [...topic.query.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.toLowerCase());
  if (quoted.length > 0) return quoted;
  return topic.query.replace(/[()]/g, " ").split(/\s+/).filter((w) => w && !/^(OR|AND)$/i.test(w)).map((w) => w.toLowerCase());
}

/** Which topic of a grouped search a post matched: the first whose phrases appear in it, else the group's first (scoring and the "why it surfaced" label use it). */
export function topicForPost(group: ProspectingTopic[], postText: string): ProspectingTopic {
  const text = postText.toLowerCase();
  return group.find((t) => topicTerms(t).some((term) => text.includes(term))) ?? group[0]!;
}

/**
 * The Prospecting discovery step: searches a rotating slice of
 * PROSPECTING_TOPICS, scores and dedupes results, and inserts genuinely
 * new candidates. Read-only against X (search only, no write path exists
 * anywhere in XSignalAdapter) and purely additive against Supabase --
 * never modifies or re-surfaces a candidate that's already been shown,
 * replied to, skipped, or marked not-relevant (upsertIfNew is a no-op for
 * any (platform, externalId) already on file).
 */
export async function runProspectingSearch(deps: ProspectingRunDeps): Promise<ProspectingRunResult> {
  const now = deps.now ?? new Date();

  if (await (deps.isPaused?.() ?? Promise.resolve(false))) {
    return { skipped: true, skipReason: "system_paused", topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0 };
  }

  const monthSpend = await deps.getMonthSpendUsd();
  const budgetCheck = evaluateMonthlyBudget(monthSpend);
  if (!budgetCheck.eligible) {
    return { skipped: true, skipReason: budgetCheck.reason, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0 };
  }

  // Same non-terminal pool prospectingDailySelection.ts draws "today's set"
  // from -- QUEUE_FULL_THRESHOLD is derived from that pool's real target.
  // Only candidates still within the reply window (MAX_AGE_FOR_DAILY_SELECTION_MS) count toward capacity:
  // stale candidates that daily selection will reject anyway must not block
  // new fresh searches (deadlock: queue counted as full, but nothing shown).
  const backlog = await deps.repo.listByStatus(["new", "shown", "drafting", "ready"], BACKLOG_SCAN_LIMIT);
  const freshBacklogCount = backlog.filter((c) => isEligibleForDailySelection(c.postCreatedAt, now)).length;
  const queueCheck = evaluateQueueCapacity(freshBacklogCount);
  if (!queueCheck.eligible) {
    return { skipped: true, skipReason: queueCheck.reason, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0 };
  }

  // How many of the waiting candidates the owner would actually be shown right now (same gate + selection the queue
  // endpoint applies). Scheduled and refill runs skip when the buffer is already met; an owner-tapped "search now"
  // (runIndexOverride) always searches, and keeps going until it finds one more usable post.
  const countSelectable = async (): Promise<number> => {
    const rows = await deps.repo.listByStatus(["new", "shown", "drafting", "ready"], BACKLOG_SCAN_LIMIT);
    return selectDailyWorkingSet(
      rows.filter((c) => isReplyWorthyPost(c.postText, { trustedAuthor: isSeedCreator(c.authorHandle) }) && !isTooSmallToBeWorthIt(c.authorFollowerCount)),
      now,
    ).selected.length;
  };
  const selectable = await countSelectable();
  const isManual = deps.runIndexOverride !== undefined;
  const breadth = planSearchBreadth(selectable, isManual);
  if (breadth.skip) {
    return { skipped: true, skipReason: breadth.reason, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0, selectableBefore: selectable };
  }

  // Combines the calendar day with which of the daily run slots (see
  // backend/src/config/scheduleConfig.ts's X prospecting schedule -- 08:00/
  // 13:00/18:00 America/Phoenix by default) this invocation is so the
  // rotation advances once per run instead of once per day -- same
  // topic-list cycling behavior as before the 3x/day split, just
  // finer-grained.
  const dayIndex = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
  const runIndex = (deps.runIndexOverride ?? dayIndex * runSlotsPerDay() + currentRunSlot(now)) + (deps.runIndexOffset ?? 0);
  // The creator watchlist (2026-10-25): futures creators whose posts were already vetted, read with one `from:` search. Built from the
  // database, so a failed read just means no watchlist this run.
  let watchGroups: string[][] = [];
  try {
    const seeds = deps.watchlistSeeds ?? (deps.watchlistSeedsOnly ? [...PROSPECTING_SEED_CREATORS] : [...PROSPECTING_SEED_CREATORS, ...parseHandleList(process.env.PROSPECTING_WATCHLIST_HANDLES)]);
    const rows = !deps.watchlistSeedsOnly && deps.repo.listWatchlistRows ? await deps.repo.listWatchlistRows(new Date(now.getTime() - WATCHLIST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)) : [];
    const watchlist = buildWatchlist(rows, seeds, deps.watchlistIncludeVetted ?? true);
    if ((deps.watchlistEnabled ?? true) && watchlist.length >= MIN_WATCHLIST_SIZE) watchGroups = chunkWatchlist(watchlist.map((w) => w.handle));
  } catch {
    watchGroups = [];
  }

  // breadth.maxTopics is how many X requests this run may make. With a watchlist, every other request (the first, the third) reads the
  // creators and the rest search topics; each topic request covers up to TOPICS_PER_QUERY topics.
  type PlannedRequest = { kind: "creators"; handles: string[] } | { kind: "topics"; group: ProspectingTopic[]; anchored: boolean };
  const isCreatorSlot = (i: number) => watchGroups.length > 0 && i % 2 === 0;
  const topicSlots = Array.from({ length: breadth.maxTopics }, (_, i) => i).filter((i) => !isCreatorSlot(i)).length;
  // Plan more topic groups than the run needs, drop the ones whose exact query was just searched, and keep the first few that are left. When
  // every group was searched recently the run makes no topic request at all (and spends nothing).
  let recentQueries = new Set<string>();
  try {
    recentQueries = deps.getRecentSearchQueries ? await deps.getRecentSearchQueries() : recentQueries;
  } catch {
    recentQueries = new Set();
  }
  // The next slices of the same rotation (run index + 1, + 2, ...) are the next topics in line, so the first slice is exactly what this run searched before.
  const candidateTopics: ProspectingTopic[] = [];
  for (let ahead = 0; ahead < 4; ahead++) {
    for (const topic of selectPrioritizedTopicsForRun(topicsInSearchOrder(), runIndex + ahead, topicSlots * TOPICS_PER_QUERY)) {
      if (!candidateTopics.some((t) => t.key === topic.key)) candidateTopics.push(topic);
    }
  }
  // Groups never mix topics that need the futures anchor with topics that do not (their X requests are built differently); the two kinds
  // of group alternate so each run tries both.
  const freshGroupsOf = (topics: ProspectingTopic[]): ProspectingTopic[][] => {
    const out: ProspectingTopic[][] = [];
    for (let i = 0; i < topics.length; i += TOPICS_PER_QUERY) {
      const group = topics.slice(i, i + TOPICS_PER_QUERY);
      if (!recentQueries.has(groupedTopicQuery(group).query)) out.push(group);
    }
    return out;
  };
  const anchoredFresh = freshGroupsOf(candidateTopics.filter((t) => !t.unanchored));
  const unanchoredFresh = freshGroupsOf(candidateTopics.filter((t) => t.unanchored));
  const freshGroups: Array<{ group: ProspectingTopic[]; anchored: boolean }> = [];
  for (let i = 0; freshGroups.length < topicSlots && (i < anchoredFresh.length || i < unanchoredFresh.length); i++) {
    if (anchoredFresh[i]) freshGroups.push({ group: anchoredFresh[i]!, anchored: true });
    if (freshGroups.length < topicSlots && unanchoredFresh[i]) freshGroups.push({ group: unanchoredFresh[i]!, anchored: false });
  }
  const plan: PlannedRequest[] = [];
  let creatorSeen = 0;
  let topicSeen = 0;
  for (let i = 0; i < breadth.maxTopics; i++) {
    if (isCreatorSlot(i)) {
      plan.push({ kind: "creators", handles: watchGroups[(runIndex + creatorSeen) % watchGroups.length]! });
      creatorSeen++;
    } else {
      const fresh = freshGroups[topicSeen];
      topicSeen++;
      if (fresh) plan.push({ kind: "topics", group: fresh.group, anchored: fresh.anchored });
    }
  }

  if (plan.length === 0) {
    return { skipped: true, skipReason: `searched_recently (every topic search for this run was already made in the last ${RECENT_QUERY_WINDOW_MS / 3_600_000} hours; a repeat reads the same posts)`, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0, selectableBefore: selectable };
  }

  let searchedToday = deps.getTodaySearchCount ? await deps.getTodaySearchCount() : 0;
  if (deps.getTodaySearchCount && searchedToday >= DAILY_SEARCH_CAP) {
    return { skipped: true, skipReason: `daily_search_cap (${searchedToday} searches today, the limit is ${DAILY_SEARCH_CAP})`, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0, selectableBefore: selectable };
  }

  let spentToday = deps.getTodaySearchSpendUsd ? await deps.getTodaySearchSpendUsd() : 0;
  if (deps.getTodaySearchSpendUsd && spentToday >= DAILY_SEARCH_BUDGET_USD) {
    return { skipped: true, skipReason: `daily_search_budget ($${spentToday.toFixed(2)} spent on searches today, the limit is $${DAILY_SEARCH_BUDGET_USD.toFixed(2)})`, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0, selectableBefore: selectable };
  }

  let postsRead = 0;
  let newCandidates = 0;
  let excludedAsSpam = 0;
  let excludedAsIrrelevant = 0;
  let screenedOut = 0;
  let screenedChecked = 0;
  let costUsd = 0;
  let searchRequests = 0;
  let creatorRequests = 0;
  let selectableNow = selectable;
  const searched: string[] = [];
  const priorOutreachCache = new Map<string, boolean>();

  // One grouped request at a time, stopping as soon as enough usable posts are waiting.
  for (const request of plan) {
    if (deps.getTodaySearchCount && searchedToday >= DAILY_SEARCH_CAP) break;
    if (deps.getTodaySearchSpendUsd && spentToday >= DAILY_SEARCH_BUDGET_USD) break;
    // Bounded discovery-time freshness (2026-09-07 review): X's recent-search
    // endpoint supports a real start_time filter (see xAdapter.ts's own doc
    // comment), so this asks X itself to never return anything older than
    // the same window prospectingFreshness.ts enforces at selection
    // time -- catching staleness at the source instead of only filtering it
    // out after paying to read it. A sparse topic returning fewer (or zero)
    // results under this bound is the correct, intended outcome.
    const fromWatchlist = request.kind === "creators";
    const grouped = request.kind === "topics" ? groupedTopicQuery(request.group) : null;
    const groupTopics = grouped?.used ?? [];
    const groupQuery = request.kind === "creators" ? watchlistQuery(request.handles) : grouped!.query;
    // A creator request reads the people, so the crypto and options exclusions and the futures anchor are left off (the same free and model
    // gates below still decide every post); a topic request carries them.
    const results = await deps.adapter.searchRecentPosts(request.kind === "creators" ? groupQuery : withCryptoExclusions(groupQuery, { futuresAnchor: request.anchored }), RESULTS_PER_QUERY, now, MAX_AGE_FOR_DAILY_SELECTION_MS);
    searchRequests++;
    if (fromWatchlist) creatorRequests++;
    searchedToday++;
    searched.push(...(fromWatchlist ? ["watchlist"] : groupTopics.map((t) => t.key)));
    postsRead += results.length;
    const requestCost = results.length * X_SEARCH_COST_PER_READ_USD;
    costUsd += requestCost;
    spentToday += requestCost;

    // What happened to each post of this request (2026-10-25): recorded on the same cost event, so it can be read back with
    // GET /api/summary?view=prospecting-runs and nobody has to guess where posts die.
    const funnel = { gate: {} as Record<string, number>, inserted: 0, duplicates: 0, screened: 0, screenedOut: 0, samples: [] as Array<{ t: string; why: string; a: string | null }>, kept: [] as string[] };
    const brief = (text: string) => text.replace(/\s+/g, " ").slice(0, 110);
    const drop = (why: string, post: { text: string; authorHandle?: string | null }) => {
      funnel.gate[why] = (funnel.gate[why] ?? 0) + 1;
      if (funnel.samples.length < 10) funnel.samples.push({ t: brief(post.text), why, a: post.authorHandle ?? null });
    };
    try {

      const created: Array<{ id: string; postText: string; discoveryQuery: string; authorHandle: string | null; score: number }> = [];
      for (const post of results) {
        // A watched creator's post is matched to the best topic by its words, else to the general futures-trader topic.
        const topic = fromWatchlist ? topicForPost([...PROSPECTING_TOPICS.filter((t) => t.key === "futures_trader"), ...PROSPECTING_TOPICS], post.text) : topicForPost(groupTopics, post.text);
        // Same $0 mechanical gate applied at queue-read time
        // (prospectingHandlers.ts's listProspectingQueue) -- checked here too
        // so an obviously off-topic post (crypto, options, forex, stocks, prop-firm referral spam,
        // newsletters, AI-trading-agent hype) is never written to prospecting_candidates in the first place.
        const trusted = isSeedCreator(post.authorHandle);
        if (!isReplyWorthyBase(post.text, { trustedAuthor: trusted }) || isTooSmallToBeWorthIt(post.authorFollowerCount)) {
          excludedAsIrrelevant++;
          drop(isTooSmallToBeWorthIt(post.authorFollowerCount) ? "small_author" : (whyNotReplyWorthy(post.text, { trustedAuthor: trusted }) ?? "other"), post);
          continue;
        }

        let previouslyEngaged = false;
        if (post.authorId) {
          if (priorOutreachCache.has(post.authorId)) {
            previouslyEngaged = priorOutreachCache.get(post.authorId)!;
          } else {
            previouslyEngaged = await deps.repo.hasPriorOutreach("x", post.authorId);
            priorOutreachCache.set(post.authorId, previouslyEngaged);
          }
        }

        const scoreResult = scoreProspectingCandidate({
          topic,
          postText: post.text,
          postCreatedAt: post.createdAt,
          publicMetrics: post.publicMetrics,
          authorFollowerCount: post.authorFollowerCount,
          authorVerified: post.authorVerified,
          previouslyEngaged,
          fromWatchlist,
          now,
        });

        if (scoreResult.excluded) {
          excludedAsSpam++;
          drop("spam", post);
          continue;
        }
        // Sales funnels (academy / course / signal seller / "DM me" / CFD-broker promo / hashtag- or link-only posts) are counted
        // with spam: they are the same kind of post, and they never reach the queue.
        if (isSalesFunnelOrEmptyPost(post.text)) {
          excludedAsSpam++;
          drop("sales_funnel", post);
          continue;
        }

        const { id, created: isNew } = await deps.repo.upsertIfNew({
          platform: "x",
          externalId: post.id,
          discoveryQuery: topic.key,
          authorHandle: post.authorHandle,
          authorExternalId: post.authorId,
          authorName: post.authorName,
          authorFollowerCount: post.authorFollowerCount,
          authorVerified: post.authorVerified,
          postText: post.text,
          postUrl: `https://x.com/i/web/status/${post.id}`,
          postCreatedAt: post.createdAt ? post.createdAt.toISOString() : null,
          publicMetrics: post.publicMetrics ?? {},
          opportunityScore: scoreResult.score,
          scoreBreakdown: scoreResult.breakdown,
          creatorCandidate: (post.authorFollowerCount ?? 0) >= 2000,
          discoveredAt: now.toISOString(),
        });
        if (!isNew) funnel.duplicates++;
        if (isNew) {
          funnel.inserted++;
          if (funnel.kept.length < 4) funnel.kept.push(brief(post.text));
          newCandidates++;
          created.push({ id, postText: post.text, discoveryQuery: topic.key, authorHandle: post.authorHandle, score: scoreResult.score });
        }
      }

      // Screen the best new posts with the cheap model check before they can be shown. Only posts that could clear the daily quality
      // bar are worth the call; a turned-away post is stored as not_relevant (so it is never found and screened twice).
      if (deps.screenRelevance) {
        const candidates = created.filter((c) => c.score >= MIN_DAILY_SET_SCORE).sort((a, b) => b.score - a.score);
        for (const c of candidates) {
          // A hand-picked creator's post needs no model check: the author is the evidence.
          if (isSeedCreator(c.authorHandle)) continue;
          if (screenedChecked >= VET_MAX_PER_RUN) break;
          screenedChecked++;
          funnel.screened++;
          let relevant = true;
          try {
            relevant = await deps.screenRelevance({ postText: c.postText, discoveryQuery: c.discoveryQuery, authorHandle: c.authorHandle });
          } catch {
            relevant = true; // a failed check never hides a post
          }
          if (!relevant) {
            await deps.repo.updateStatus(c.id, "not_relevant", { skipReason: "screened_out_at_discovery" });
            screenedOut++;
            funnel.screenedOut++;
            drop("model_screen", { text: c.postText, authorHandle: c.authorHandle });
          }
        }
      }

    } finally {
      await recordXSearchCostEvent(deps.client, results.length, {
        ...(fromWatchlist ? { watchlist: true, creators: request.kind === "creators" ? request.handles.length : 0 } : { topics: groupTopics.map((t) => t.key) }),
        query: groupQuery,
        read: results.length,
        funnel,
      });
    }

    selectableNow = await countSelectable();
    if (selectableNow >= breadth.target) break;
  }

  return {
    skipped: false,
    topicsSearched: searched,
    postsRead,
    newCandidates,
    excludedAsSpam,
    excludedAsIrrelevant,
    costUsd,
    selectableBefore: selectable,
    selectableAfter: selectableNow,
    searchRequests,
    screenedOut,
    creatorRequests,
  };
}
