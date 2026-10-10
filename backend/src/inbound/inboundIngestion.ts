import type { XMention, XSignalAdapter } from "../signals/adapters/xAdapter.js";
import type { IngestionCursorStore } from "../signals/adapters/ingestionCursorStore.js";
import type { InboundRepository, NewInboundEngagement } from "./types.js";
import { classifyPriority } from "./inboundClassifier.js";

/** Own cursor, deliberately separate from xIngestion.ts's "x_mention" cursor -- this pipeline classifies/stores every mention differently and must not skip one the other pipeline already consumed, or vice versa. */
export const INBOUND_CURSOR_SOURCE = "x_mention_inbound";

export interface IngestInboundDeps {
  adapter: Pick<XSignalAdapter, "fetchOwnMentions">;
  repo: InboundRepository;
  /** Resolves a handle to a tracked creator's id, if any -- links relationship context without this module depending on the creators module's repository shape. */
  findCreatorIdByHandle: (handle: string) => Promise<string | null>;
  /**
   * True if we've already replied to this X user id via Prospecting
   * (prospecting_outreach table) -- optional so existing callers/tests
   * that predate Prospecting keep working unchanged. Closes the loop the
   * Prospecting audit flagged: without this, someone we cold-replied to
   * would show up here as a first-time stranger even though we already
   * reached out.
   */
  hasProspectingOutreach?: (authorExternalId: string) => Promise<boolean>;
}

export interface IngestInboundResult {
  fetched: number;
  inserted: number;
  skippedExisting: number;
}

/**
 * Pulls @FillbookHQ's mentions and turns each new one into a real,
 * triaged inbound_engagements row -- the step that never existed before
 * this (every mention previously became an undifferentiated Opportunity
 * Engine signal, see docs/PROGRESS_LEDGER.md's audit). `backlogRecovery`
 * ignores the stored cursor (re-fetches the same recent window X's API
 * gives back, up to 50) and changes the terminal status for genuinely
 * new rows: forward sync has no ambiguity (this is the first time we've
 * ever seen the message, so "needs_response" is simply true), but a
 * backlog pass is reconstructing PAST state with no way to know whether
 * the owner already handled it outside this system -- those land as
 * "review_needed" rather than assuming either answered or unanswered.
 * Already-recorded rows are left untouched either way (see
 * InboundRepository.upsertIfNew) -- backlog recovery can never overwrite
 * an item the owner already triaged.
 */
export async function ingestInboundMentions(
  deps: IngestInboundDeps,
  cursorStore: IngestionCursorStore,
  userId: string,
  now: Date = new Date(),
  backlogRecovery = false,
): Promise<IngestInboundResult> {
  const sinceId = backlogRecovery ? undefined : ((await cursorStore.load(INBOUND_CURSOR_SOURCE)) ?? undefined);
  const mentions = await deps.adapter.fetchOwnMentions(userId, sinceId, now);
  let inserted = 0;
  let skippedExisting = 0;

  for (const mention of mentions) {
    const row = await buildRow(deps, userId, mention, backlogRecovery, now);
    const result = await deps.repo.upsertIfNew(row);
    if (result.created) inserted++;
    else skippedExisting++;
  }

  if (mentions.length > 0 && !backlogRecovery) {
    await cursorStore.save(INBOUND_CURSOR_SOURCE, mentions[0]!.id);
  }

  return { fetched: mentions.length, inserted, skippedExisting };
}

async function buildRow(
  deps: IngestInboundDeps,
  ourUserId: string,
  mention: XMention,
  backlogRecovery: boolean,
  now: Date,
): Promise<NewInboundEngagement> {
  const isDirectReplyToUs = mention.inReplyToUserId === ourUserId;
  const isQuotePost = mention.referencedTweets.some((r) => r.type === "quoted");

  const priorCount = mention.authorId ? await deps.repo.countPriorFromAuthor("x", mention.authorId) : 0;
  const creatorId = mention.authorHandle ? await deps.findCreatorIdByHandle(mention.authorHandle) : null;
  const priorProspectingOutreach =
    mention.authorId && deps.hasProspectingOutreach ? await deps.hasProspectingOutreach(mention.authorId) : false;
  const hasExistingRelationship = priorCount > 0 || creatorId !== null || priorProspectingOutreach;

  const priority = classifyPriority({
    text: mention.text,
    isDirectReplyToUs,
    isQuotePost,
    hasExistingRelationship,
  });

  const status = priority === "low_value" ? "closed" : backlogRecovery ? "review_needed" : "needs_response";

  return {
    platform: "x",
    externalId: mention.id,
    conversationId: mention.conversationId,
    inReplyToExternalId: mention.referencedTweets.find((r) => r.type === "replied_to")?.id ?? null,
    authorHandle: mention.authorHandle,
    authorExternalId: mention.authorId,
    creatorId,
    body: mention.text,
    inResponseToText: null, // Would need a second API call per mention to fetch the parent tweet's text -- not fetched yet, see docs/INBOUND_ENGAGEMENT.md's limitations.
    publicMetrics: mention.publicMetrics ?? {},
    priority,
    status,
    draftResponse: null,
    draftUsesLink: null,
    respondedAt: null,
    respondedNote: null,
    isRepeatEngager: priorCount > 0,
    observedAt: (mention.createdAt ?? now).toISOString(),
    sourceReference: `https://x.com/i/web/status/${mention.id}`,
  };
}
