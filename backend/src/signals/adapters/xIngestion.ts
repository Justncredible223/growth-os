import type { SignalGraph } from "../signalGraph.js";
import type { Signal } from "../types.js";
import type { XSignalAdapter } from "./xAdapter.js";
import type { IngestionCursorStore } from "./ingestionCursorStore.js";

export const X_MENTION_CURSOR_SOURCE = "x_mention";
const CURSOR_SOURCE = X_MENTION_CURSOR_SOURCE;

/**
 * Pulls @FillbookHQ's recent mentions and feeds each one through
 * SignalGraph.ingest(). Topic is left null -- real topic classification
 * needs the AI provider key (Phase 6 blocker), so this doesn't guess at
 * keywords; clustering/velocity simply won't apply to these signals until
 * that's wired up. Nothing here is fabricated to look smarter than it is.
 *
 * Tracks a since_id cursor so repeated runs (manual trigger or cron)
 * don't re-ingest the same mentions as duplicate signal rows. X's
 * mentions endpoint returns newest-first, so the first item in a
 * non-empty response is the new cursor value.
 */
export async function ingestXMentions(
  adapter: Pick<XSignalAdapter, "fetchOwnMentions">,
  signalGraph: SignalGraph,
  cursorStore: IngestionCursorStore,
  userId: string,
  now: Date = new Date(),
): Promise<Signal[]> {
  const sinceId = (await cursorStore.load(CURSOR_SOURCE)) ?? undefined;
  const mentions = await adapter.fetchOwnMentions(userId, sinceId, now);
  const signals: Signal[] = [];

  for (const mention of mentions) {
    const signal = await signalGraph.ingest(
      {
        source: CURSOR_SOURCE,
        topic: null,
        evidence: {
          postId: mention.id,
          text: mention.text,
          authorId: mention.authorId,
          // The adapter already resolves this from X's API (expansions=
          // author_id&user.fields=username) -- it was being fetched and
          // discarded here. Capturing it is what lets Radar's engagement
          // opportunities show a real "Open profile" link instead of
          // being permanently limited to the numeric author id.
          authorHandle: mention.authorHandle,
          publicMetrics: mention.publicMetrics,
        },
        observedAt: mention.createdAt ?? now,
        sourceReference: `https://x.com/i/web/status/${mention.id}`,
        privacyClassification: "public",
      },
      now,
    );
    signals.push(signal);
  }

  if (mentions.length > 0) {
    await cursorStore.save(CURSOR_SOURCE, mentions[0]!.id);
  }

  return signals;
}
