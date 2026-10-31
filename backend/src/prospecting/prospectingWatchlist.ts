/**
 * The creator watchlist (2026-10-25). Searching by phrase finds only about 3 usable posts per request, because fresh futures-trader
 * conversations are thin. A watchlist reads PEOPLE instead: the futures creators whose posts have already been vetted as relevant,
 * through one X search for their latest top-level posts (`from:a OR from:b ...`). It costs the same $0.005 a post read as any search, but
 * every post comes from an account that is known to be on topic, and replying to the same few creators builds a relationship.
 *
 * It builds itself, with no table and no migration: an author earns a place by having at least one post that passed the relevance
 * gates and was not turned away, or by having been replied to. Anyone can be added by hand through `PROSPECTING_SEED_CREATORS`
 * (here) or the PROSPECTING_WATCHLIST_HANDLES environment variable (comma-separated handles, no @).
 */

/** Handles added by hand, always on the list. Empty until the owner names some. No @. */
export const PROSPECTING_SEED_CREATORS: readonly string[] = [
  // 2026-10-30, picked from a read-only skim of X (futures-specific, 1.8K to 62K followers, no course or promo-code selling, active):
  "LumiTraders", "StoicTA", "aw_trades_", "RHerman", "fredtrades", "MrMilkTrading",
  "stefanytrades", "RC_FUTURES", "TraderLe", "FredrikMolnar", "nqvtrades", "mTraderNDX",
];

/** An author needs at least this many followers to be worth watching (the same floor spirit as MIN_PROSPECT_FOLLOWERS, higher on purpose). */
export const MIN_WATCH_FOLLOWERS = 1_000;
/** Above this a reply is rarely seen; below MIN a reply is rarely noticed. Creators between are the ones who read and answer replies. */
export const MAX_WATCH_FOLLOWERS = 300_000;
/** A watchlist search only runs once this many creators are known; with fewer, topic searches find more. */
export const MIN_WATCHLIST_SIZE = 4;
/** The most creators ever kept on the list. */
export const MAX_WATCHLIST_SIZE = 45;
/** How far back vetted candidates count toward a place on the list. */
export const WATCHLIST_LOOKBACK_DAYS = 30;
/**
 * Trading words every creator request must also match (2026-10-26). A bare `from:` request read each creator's whole timeline, and
 * 64 of the ~94 posts the free gates dropped in three days were "not_trading" (Oct 23-26: 57 searches, $1.84, no usable prospect): the
 * creators post plenty that is not about trading, and every other request in a run was a creator request. X ANDs this group with the
 * `from:` group, so only a creator's trading posts are read (and paid for).
 */
export const WATCHLIST_TRADING_ANCHOR = "(futures OR NQ OR MNQ OR MES OR trading OR trader OR drawdown OR eval OR funded OR setup OR stop OR loss)";
/** Characters of `from:` terms in one query: X allows 512 in all; the adapter adds about 34 more, and the trading anchor and a space come out of the same budget. */
const MAX_WATCHLIST_QUERY_CHARS = Math.min(330, 512 - 34 - WATCHLIST_TRADING_ANCHOR.length - 1 - 12);
/** A creator must have had a post with at least this opportunity score to earn a place by vetting alone. */
const MIN_VETTED_SCORE = 50;

/** The columns of prospecting_candidates the watchlist needs. */
export interface WatchlistRow {
  authorHandle: string | null;
  authorFollowerCount: number | null;
  status: string;
  opportunityScore: number;
}

export interface WatchedCreator {
  handle: string;
  followers: number | null;
  /** Why they are on the list: "seed", "replied" (the owner has replied to them) or "vetted". */
  reason: "seed" | "replied" | "vetted";
}

/** True when the handle is one of the hand-picked seed creators (case-insensitive, with or without @). */
export function isSeedCreator(handle: string | null | undefined): boolean {
  if (!handle) return false;
  const h = handle.replace(/^@/, "").toLowerCase();
  return PROSPECTING_SEED_CREATORS.some((s) => s.toLowerCase() === h);
}

const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

/** Parses a comma-separated handle list (the environment variable form): trims, drops @, keeps only valid, de-duplicates. */
export function parseHandleList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const handle = part.trim().replace(/^@/, "");
    if (handle && isValidHandle(handle) && !out.some((h) => h.toLowerCase() === handle.toLowerCase())) out.push(handle);
  }
  return out;
}

/**
 * Pure: the ordered watchlist from vetted candidate rows. Seeds first, then creators the owner has replied to, then creators with the
 * most vetted posts. An author with any post turned away (unless the owner replied to them), or who is outside the follower range, is left off.
 */
export function buildWatchlist(rows: WatchlistRow[], seeds: readonly string[] = [], includeVetted = true): WatchedCreator[] {
  const seen = new Set<string>();
  const out: WatchedCreator[] = [];
  for (const raw of seeds) {
    const handle = raw.replace(/^@/, "");
    if (!isValidHandle(handle) || seen.has(handle.toLowerCase())) continue;
    seen.add(handle.toLowerCase());
    out.push({ handle, followers: null, reason: "seed" });
  }

  const byAuthor = new Map<string, { handle: string; followers: number | null; replied: boolean; vetted: number; turnedAway: number; best: number }>();
  for (const row of rows) {
    const handle = row.authorHandle?.replace(/^@/, "") ?? "";
    if (!isValidHandle(handle)) continue;
    const key = handle.toLowerCase();
    const entry = byAuthor.get(key) ?? { handle, followers: null, replied: false, vetted: 0, turnedAway: 0, best: 0 };
    if (row.authorFollowerCount !== null && row.authorFollowerCount !== undefined) entry.followers = Math.max(entry.followers ?? 0, row.authorFollowerCount);
    if (row.status === "replied") entry.replied = true;
    if (row.status === "not_relevant") entry.turnedAway++;
    else if (row.status !== "skipped") {
      entry.vetted++;
      entry.best = Math.max(entry.best, row.opportunityScore);
    }
    byAuthor.set(key, entry);
  }

  const ranked = [...byAuthor.entries()]
    .filter(([key, a]) => {
      if (seen.has(key)) return false;
      if (a.followers === null || a.followers < MIN_WATCH_FOLLOWERS || a.followers > MAX_WATCH_FOLLOWERS) return false;
      if (a.replied) return true;
      // One turned-away post is enough to drop an author (2026-10-25). The list used to keep anyone turned away no more often
      // than vetted, and "vetted" includes posts no model has screened yet, so company accounts (a prop firm posting about its own
      // drawdown rules) stayed on it, scored +6 and kept reaching the top of the queue only to be rejected on Draft reply.
      // includeVetted is off in production (2026-10-27): "vetted" admitted forex, crypto, Indian-market and firm-marketing accounts, and their
      // streams cost $0.90 over four days for one new prospect while topic searches found five for $1.04. Only seeds and creators the owner replied to stay.
      return includeVetted && a.vetted >= 1 && a.best >= MIN_VETTED_SCORE && a.turnedAway === 0;
    })
    .sort(([, a], [, b]) => Number(b.replied) - Number(a.replied) || b.vetted - a.vetted || b.best - a.best || (b.followers ?? 0) - (a.followers ?? 0));

  for (const [, a] of ranked) {
    if (out.length >= MAX_WATCHLIST_SIZE) break;
    out.push({ handle: a.handle, followers: a.followers, reason: a.replied ? "replied" : "vetted" });
  }
  return out;
}

/** Splits the handles into groups whose `from:` query fits in one X request. */
export function chunkWatchlist(handles: readonly string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let length = 2;
  for (const handle of handles) {
    const add = `from:${handle}`.length + (current.length ? 4 : 0);
    if (current.length > 0 && length + add > MAX_WATCHLIST_QUERY_CHARS) {
      groups.push(current);
      current = [];
      length = 2;
    }
    length += `from:${handle}`.length + (current.length ? 4 : 0);
    current.push(handle);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** The X query for one group: the latest top-level posts from any of these creators (the adapter adds -is:retweet -is:reply lang:en). */
export function watchlistQuery(handles: readonly string[]): string {
  return `(${handles.map((h) => `from:${h}`).join(" OR ")}) ${WATCHLIST_TRADING_ANCHOR}`;
}
