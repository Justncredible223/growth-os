import type { IngestionCursorStore } from "./ingestionCursorStore.js";
import type { XMention, XSignalAdapter } from "./xAdapter.js";

/** Numeric comparison of two X post ids (snowflakes). Falls back to length-then-lexical order for anything that is not all digits. */
export function compareXIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Wraps one X adapter for the lifetime of ONE scheduled run (api/growth-pulse.ts) so the same paid read is never made
 * twice in that run:
 *
 *  - `resolveOwnUserId` (GET /users/me) is made once, however many steps ask for it.
 *  - `fetchOwnMentions` (GET /users/:id/mentions) is made once for every consumer that reads the account's mentions.
 *    Each consumer keeps its OWN since_id cursor (x_mention for the signal graph, x_mention_inbound for Inbound), so
 *    the one request uses the OLDEST of those cursors and each caller is then handed only the mentions newer than its
 *    own cursor. A caller therefore sees exactly what its own separate request would have returned: nothing is lost
 *    and nothing is delivered twice. A caller whose cursor is older than what was fetched (or that passes none, as
 *    backlog recovery does) falls through to a real request, so the semantics never narrow.
 *
 * Failed requests are not cached: the next caller simply tries again, as it did before this wrapper existed.
 */
export class RunScopedXReads {
  private userId: Promise<string> | null = null;
  private mentions: { userId: string; since: string | undefined; items: XMention[] } | null = null;

  constructor(
    readonly adapter: XSignalAdapter,
    private cursorStore: IngestionCursorStore,
    /** The ingestion-cursor sources of every consumer of fetchOwnMentions in this run. */
    private mentionCursorSources: string[],
  ) {}

  resolveOwnUserId(now: Date = new Date()): Promise<string> {
    if (!this.userId) {
      const pending = this.adapter.resolveOwnUserId(now);
      this.userId = pending;
      pending.catch(() => {
        if (this.userId === pending) this.userId = null;
      });
    }
    return this.userId;
  }

  async fetchOwnMentions(userId: string, sinceId?: string, now: Date = new Date()): Promise<XMention[]> {
    if (!this.mentions || this.mentions.userId !== userId) {
      const cursors = await Promise.all(this.mentionCursorSources.map((s) => this.cursorStore.load(s)));
      // Any consumer without a cursor needs everything, so the shared request cannot be bounded at all.
      const since = cursors.some((c) => c === null) ? undefined : cursors.reduce<string | undefined>((min, c) => (min === undefined || compareXIds(c as string, min) < 0 ? (c as string) : min), undefined);
      // The caller asking first may itself be older than every stored cursor (it is passing its own); never go narrower than it.
      const effective = since === undefined || sinceId === undefined ? undefined : compareXIds(sinceId, since) < 0 ? sinceId : since;
      const items = await this.adapter.fetchOwnMentions(userId, effective, now);
      this.mentions = { userId, since: effective, items };
      return sinceId === undefined ? items : items.filter((m) => compareXIds(m.id, sinceId) > 0);
    }
    const cached = this.mentions;
    // Cached request was bounded and this caller wants more than it covers: make the real request.
    if (cached.since !== undefined && (sinceId === undefined || compareXIds(sinceId, cached.since) < 0)) {
      return this.adapter.fetchOwnMentions(userId, sinceId, now);
    }
    return sinceId === undefined ? cached.items : cached.items.filter((m) => compareXIds(m.id, sinceId) > 0);
  }
}
