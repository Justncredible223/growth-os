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
export const PROSPECTING_SEED_CREATORS: readonly string[] = [];

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
/** Characters of `from:` terms in one query (X allows 512 in all; the adapter adds about 34 more). */
const MAX_WATCHLIST_QUERY_CHARS = 330;
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
 * most vetted posts. An author whose posts have mostly been turned away, or who is outside the follower range, is left off.
 */
export function buildWatchlist(rows: WatchlistRow[], seeds: readonly string[] = []): WatchedCreator[] {
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
      return a.vetted >= 1 && a.best >= MIN_VETTED_SCORE && a.turnedAway <= a.vetted;
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
  return `(${handles.map((h) => `from:${h}`).join(" OR ")})`;
}
