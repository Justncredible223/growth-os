import type { DraftOption, PostedStyle } from "./prospectingDraftOptions.js";

import type { WatchlistRow } from "./prospectingWatchlist.js";

export type ProspectingStatus =
  | "new"
  | "shown"
  | "drafting"
  | "ready"
  | "replied"
  | "skipped"
  | "not_relevant"
  | "already_handled"
  | "expired";

export interface ProspectingCandidate {
  id: string;
  platform: string;
  externalId: string;
  discoveryQuery: string;
  authorHandle: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  authorFollowerCount: number | null;
  authorVerified: boolean | null;
  postText: string;
  postUrl: string;
  postCreatedAt: string | null;
  publicMetrics: Record<string, number>;
  opportunityScore: number;
  scoreBreakdown: Record<string, string>;
  creatorCandidate: boolean;
  status: ProspectingStatus;
  shownAt: string | null;
  openedAt: string | null;
  draftReply: string | null;
  /**
   * Reply-style experiment: the drafted options (sharp / helpful). draftReply is always the first option's text, so older
   * app builds keep working. Absent or null on drafts made before the experiment.
   */
  draftOptions?: DraftOption[] | null;
  /** Which style the owner actually posted (set when marked replied). Absent or null before the experiment. */
  postedStyle?: PostedStyle | null;
  finalReply: string | null;
  replyMentionsFillbook: boolean | null;
  replyUsedLink: boolean | null;
  repliedAt: string | null;
  skipReason: string | null;
  discoveredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewProspectingCandidate {
  platform: string;
  externalId: string;
  discoveryQuery: string;
  authorHandle: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  authorFollowerCount: number | null;
  authorVerified: boolean | null;
  postText: string;
  postUrl: string;
  postCreatedAt: string | null;
  publicMetrics: Record<string, number>;
  opportunityScore: number;
  scoreBreakdown: Record<string, string>;
  creatorCandidate: boolean;
  discoveredAt: string;
}

export interface ProspectingRepository {
  /** Insert-if-new by (platform, externalId) -- the dedup key. Returns created=false if already known (no duplicate re-surfacing). */
  upsertIfNew(candidate: NewProspectingCandidate): Promise<{ id: string; created: boolean }>;
  listByStatus(statuses: ProspectingStatus[], limit?: number): Promise<ProspectingCandidate[]>;
  /** Replied candidates whose repliedAt is at or after `since` -- feeds reply pacing (prospectingPacing.ts). */
  listRepliedSince(since: Date): Promise<ProspectingCandidate[]>;
  getById(id: string): Promise<ProspectingCandidate | null>;
  markShown(ids: string[]): Promise<void>;
  updateStatus(
    id: string,
    status: ProspectingStatus,
    fields?: Partial<
      Pick<
        ProspectingCandidate,
        "openedAt" | "draftReply" | "draftOptions" | "postedStyle" | "finalReply" | "replyMentionsFillbook" | "replyUsedLink" | "repliedAt" | "skipReason"
      >
    > & { /** Extra keys merged into the score_breakdown JSON (no migration), e.g. the owner override marker. */ breakdownPatch?: Record<string, string> },
  ): Promise<void>;
  /** True if this author has already been replied to via Prospecting before -- feeds both scoring and the Inbound relationship bridge. */
  hasPriorOutreach(platform: string, authorExternalId: string): Promise<boolean>;
  recordOutreach(platform: string, authorExternalId: string, authorHandle: string | null): Promise<void>;
  /** Author and status columns of recent candidates, for building the creator watchlist (prospectingWatchlist.ts). Optional so simple fakes need not implement it. */
  listWatchlistRows?(since: Date): Promise<WatchlistRow[]>;
  /** Marks non-terminal candidates older than the given cutoff as 'expired' -- run before each daily-set selection. Returns how many were expired. */
  expireStale(olderThan: Date): Promise<number>;
  /** Posts the AI relevance screen turned away at discovery (status not_relevant, skip_reason screened_out_at_discovery), updated at or after `since`, newest first. Optional so simple fakes need not implement it. */
  listScreenedOut?(since: Date, limit: number): Promise<ProspectingCandidate[]>;
}

/** The reason stored on a post the model relevance screen turned away (set in prospectingSearch.ts). */
export const SCREENED_OUT_REASON = "screened_out_at_discovery";

/** Keys stored inside score_breakdown when the owner chose to draft a post the screen turned away. */
export const OWNER_OVERRIDE_KEY = "owner_override";
export const OWNER_OVERRIDE_AT_KEY = "owner_override_at";
/** An owner-chosen card stays in the queue this long regardless of the freshness window and score floor. */
export const OWNER_OVERRIDE_VISIBLE_MS = 24 * 60 * 60 * 1000;
