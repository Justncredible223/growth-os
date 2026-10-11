import { LIVE_HOST_SEGMENTS, type LiveHostSegment } from "./liveHostPersona.js";
import { OVERRUN_BLOCK, RUNDOWN, type RundownBlock } from "./showRundownConfig.js";

/** The block of the show a given number of minutes in. Past the last block it is the extended block, never a replay. */
export function rundownBlockAt(elapsedMinutes: number, blocks: RundownBlock[] = RUNDOWN, overrun: RundownBlock = OVERRUN_BLOCK): RundownBlock {
  const minutes = Math.max(0, elapsedMinutes);
  return blocks.find((block) => minutes >= block.fromMinute && minutes < block.toMinute) ?? overrun;
}

export interface RundownPickInput {
  elapsedMinutes: number;
  /** Segment ids of this session's most recent lines, newest first. */
  recentSegmentIds: Array<string | null>;
  /** How often each segment ran in earlier sessions: lower is fresher. */
  priorUseCounts?: Record<string, number>;
  /** Whether the Fillbook spot may run right now (cooldowns, live chat, promos switched on). */
  fillbookSpotAllowed: boolean;
  random?: () => number;
}

/**
 * The next segment: the least recently used one in the current block's pool (ties broken by how much earlier
 * streams used it, then at random). Never the segment just said. Falls back to the whole non-retired set when the
 * pool is empty, so it always returns something.
 */
export function pickRundownSegment(input: RundownPickInput): { segment: LiveHostSegment; block: RundownBlock } {
  const random = input.random ?? Math.random;
  const block = rundownBlockAt(input.elapsedMinutes);
  const usable = (segment: LiveHostSegment | undefined): segment is LiveHostSegment =>
    !!segment && !segment.retired && !segment.show && (!segment.isFillbookSpot || input.fillbookSpotAllowed);
  const byIds = (ids: string[]): LiveHostSegment[] => ids.map((id) => LIVE_HOST_SEGMENTS.find((segment) => segment.id === id)).filter(usable);
  const last = input.recentSegmentIds[0] ?? null;
  // A block whose only usable segment was just said (the one-line opening) hands over to the next block's pool.
  let pool = byIds(block.segmentIds);
  const startAt = RUNDOWN.indexOf(block);
  for (let at = startAt + 1; at >= 1 && at < RUNDOWN.length && pool.filter((segment) => segment.id !== last).length === 0; at++) {
    pool = byIds(RUNDOWN[at]!.segmentIds);
  }
  if (pool.length === 0) pool = byIds(OVERRUN_BLOCK.segmentIds);
  if (pool.length === 0) pool = LIVE_HOST_SEGMENTS.filter((segment) => usable(segment) && !segment.isFillbookSpot);
  // A due Fillbook spot goes first when the block allows it, as it did before the rundown.
  const spot = pool.find((segment) => segment.isFillbookSpot);
  if (spot && last !== spot.id) return { segment: spot, block };
  const candidates = pool.length > 1 ? pool.filter((segment) => segment.id !== last) : pool;
  // Position in the recent list (0 = just said). Never said recently sorts as the oldest.
  const recency = (id: string): number => {
    const index = input.recentSegmentIds.indexOf(id);
    return index === -1 ? 1_000 : index;
  };
  const used = (id: string): number => input.priorUseCounts?.[id] ?? 0;
  const ranked = [...candidates].sort((a, b) => recency(b.id) - recency(a.id) || used(a.id) - used(b.id));
  const best = ranked[0]!;
  const tied = ranked.filter((segment) => recency(segment.id) === recency(best.id) && used(segment.id) === used(best.id));
  return { segment: tied[Math.floor(random() * tied.length)] ?? best, block };
}
