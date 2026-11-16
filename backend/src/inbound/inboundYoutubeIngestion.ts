import type { YoutubeComment, YoutubeCommentAdapter } from "../signals/adapters/youtubeAdapter.js";
import type { IngestionCursorStore } from "../signals/adapters/ingestionCursorStore.js";
import type { InboundRepository, NewInboundEngagement } from "./types.js";
import { classifyPriority } from "./inboundClassifier.js";

/** Per-video cursor namespace, since (unlike X's single-account mentions) there can be many videos, each needing its own "what have we already seen" pointer. */
export function youtubeCommentCursorKey(videoId: string): string {
  return `youtube_comment:${videoId}`;
}

export interface IngestInboundYoutubeDeps {
  adapter: YoutubeCommentAdapter;
  repo: InboundRepository;
}

/** Pages of 50 comments one video's sync may read before it stops and warns. */
export const YOUTUBE_MAX_PAGES = 5;

export interface IngestInboundYoutubeResult {
  /** True when the read stopped at YOUTUBE_MAX_PAGES without reaching the stored cursor (the caller raises a warning). */
  truncated?: boolean;
  fetched: number;
  inserted: number;
  skippedExisting: number;
}

/**
 * Pulls one video's recent top-level comments and turns each new one into
 * a real, triaged inbound_engagements row -- the YouTube equivalent of
 * inboundIngestion.ts's ingestInboundMentions, reusing the exact same
 * repository/classifier/status-machine so Inbound's queue, drafting, and
 * "mark responded" flow all work identically regardless of platform.
 *
 * Only top-level comments are fetched (see YoutubeCommentAdapter's own
 * doc comment) -- a reply-to-a-reply thread would need a second API call
 * per thread (comments.list?parentId=), not done in this first version.
 * `isDirectReplyToUs`/`isQuotePost` are therefore always false here; a
 * comment still gets a real priority from classifyPriority based on its
 * text and whether the commenter has engaged before.
 *
 * commentThreads.list has no since-id filter (see fetchTopLevelComments),
 * so "what's new" is computed client-side: comments arrive newest-first,
 * and this stops consuming the list as soon as it reaches the id stored
 * as this video's cursor from the previous run.
 */
export async function ingestInboundYoutubeComments(
  deps: IngestInboundYoutubeDeps,
  cursorStore: IngestionCursorStore,
  videoId: string,
  now: Date = new Date(),
): Promise<IngestInboundYoutubeResult> {
  const cursorKey = youtubeCommentCursorKey(videoId);
  const sinceId = await cursorStore.load(cursorKey);
  // P0 2026-11-15: follow the pages until the stored cursor shows up (one page used to be read, so a burst of more than 50 comments
  // between runs lost the older ones). An adapter without paging (tests, older fakes) reads one page as before.
  let comments: YoutubeComment[];
  let truncated = false;
  const paged = (deps.adapter as { fetchTopLevelCommentsPage?: (v: string, t?: string) => Promise<{ comments: YoutubeComment[]; nextPageToken?: string }> }).fetchTopLevelCommentsPage;
  if (sinceId && paged) {
    comments = [];
    let token: string | undefined;
    for (let page = 0; page < YOUTUBE_MAX_PAGES; page++) {
      const r = await paged.call(deps.adapter, videoId, token);
      comments.push(...r.comments);
      token = r.nextPageToken;
      if (!token || r.comments.some((c) => c.id === sinceId)) break;
    }
    truncated = Boolean(token) && !comments.some((c) => c.id === sinceId);
  } else {
    comments = await deps.adapter.fetchTopLevelComments(videoId);
  }

  const newComments = sinceId ? takeUntilSeen(comments, sinceId) : comments;

  let inserted = 0;
  let skippedExisting = 0;
  for (const comment of newComments) {
    const row = await buildRow(deps, videoId, comment, now);
    const result = await deps.repo.upsertIfNew(row);
    if (result.created) inserted++;
    else skippedExisting++;
  }

  if (comments.length > 0) {
    await cursorStore.save(cursorKey, comments[0]!.id);
  }

  return { ...(truncated ? { truncated: true } : {}), fetched: newComments.length, inserted, skippedExisting };
}

/** Comments arrive newest-first; keeps everything before the previously-seen id, matching X ingestion's since_id semantics without an API-level since filter. Returns the whole list unseen (i.e. all of it is "new") if the cursor id isn't found in this page at all -- either it scrolled off a 50-item page between runs, or this is stale/reset; either way, the safer default is treating what's visible now as new rather than silently dropping it. */
function takeUntilSeen(comments: YoutubeComment[], sinceId: string): YoutubeComment[] {
  const seenIndex = comments.findIndex((c) => c.id === sinceId);
  return seenIndex === -1 ? comments : comments.slice(0, seenIndex);
}

async function buildRow(
  deps: IngestInboundYoutubeDeps,
  videoId: string,
  comment: YoutubeComment,
  now: Date,
): Promise<NewInboundEngagement> {
  const priorCount = comment.authorChannelId ? await deps.repo.countPriorFromAuthor("youtube", comment.authorChannelId) : 0;
  // YouTube comments have no @handle to look a tracked creator up by --
  // authorDisplayName is a free-text display name, not a stable
  // identifier, so this deliberately never resolves a creatorId for a
  // YouTube comment rather than risking a false match on a common name.
  const creatorId = null;
  const hasExistingRelationship = priorCount > 0 || creatorId !== null;

  const priority = classifyPriority({
    text: comment.text,
    isDirectReplyToUs: false,
    isQuotePost: false,
    hasExistingRelationship,
  });

  const status = priority === "low_value" ? "closed" : "needs_response";

  return {
    platform: "youtube",
    externalId: comment.id,
    conversationId: comment.id,
    inReplyToExternalId: null,
    authorHandle: comment.authorDisplayName,
    authorExternalId: comment.authorChannelId,
    creatorId,
    body: comment.text,
    // YouTube's own video title isn't fetched here (a second API call per
    // video, not needed for v1) -- draftInboundResponse already handles a
    // null inResponseToText the same way X's own mentions frequently do.
    inResponseToText: null,
    publicMetrics: {},
    priority,
    status,
    draftResponse: null,
    draftUsesLink: null,
    respondedAt: null,
    respondedNote: null,
    isRepeatEngager: priorCount > 0,
    observedAt: (comment.publishedAt ?? now).toISOString(),
    // &lc= is YouTube's own real deep-link format for scrolling straight
    // to a specific comment -- confirmed real, not invented.
    sourceReference: `https://www.youtube.com/watch?v=${videoId}&lc=${comment.id}`,
  };
}
