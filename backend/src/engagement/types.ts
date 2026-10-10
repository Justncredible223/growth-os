export const ENGAGEMENT_PLATFORMS = ["youtube", "tiktok"] as const;
export type EngagementPlatform = (typeof ENGAGEMENT_PLATFORMS)[number];

export type EngagementItemStatus = "new" | "drafted" | "done" | "skipped";
export type EngagementItemSource = "watchlist" | "search" | "pasted";
export type EngagementActionKind = "drafted" | "opened" | "copied" | "done" | "skipped";
export type EngagementDid = "commented" | "liked" | "both";

export interface EngagementDraft {
  /** Stable within one item: "d1", "d2", "d3". */
  id: string;
  text: string;
}

export interface EngagementItem {
  id: string;
  platform: EngagementPlatform;
  externalId: string;
  url: string;
  title: string;
  creatorId: string;
  creatorName: string;
  thumbnailUrl: string | null;
  description: string | null;
  /** A few short top-comment snippets (YouTube only, fetched lazily at draft time). */
  topComments: string[];
  /** Cached API statistics. Purged with the row after 30 days (YouTube API Developer Policies). */
  stats: Record<string, number> | null;
  source: EngagementItemSource;
  status: EngagementItemStatus;
  drafts: EngagementDraft[];
  skipReason: string | null;
  fetchedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** One audit-log row: every drafted / opened / copied / done / skipped action the owner or the assistant took. */
export interface EngagementActionRow {
  id: string;
  itemId: string | null;
  platform: EngagementPlatform;
  externalId: string;
  creatorId: string;
  creatorName: string | null;
  kind: EngagementActionKind;
  did: EngagementDid | null;
  draftId: string | null;
  draftText: string | null;
  finalText: string | null;
  gotReply: boolean | null;
  profileVisits: number | null;
  outcomeNote: string | null;
  createdAt: string;
}

export interface WatchlistEntry {
  id: string;
  kind: "channel" | "query";
  value: string;
  label: string | null;
  active: boolean;
  createdAt: string;
}

/** What discovery or a pasted link resolved a video to, before it becomes a queue row. */
export interface VideoMetadata {
  platform: EngagementPlatform;
  externalId: string;
  url: string;
  title: string;
  creatorId: string;
  creatorName: string;
  thumbnailUrl: string | null;
  description: string | null;
  stats: Record<string, number> | null;
}
