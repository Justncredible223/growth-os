import { OFFICIAL_HANDLE } from "../shortform/types.js";
import type { InboundEngagement, InboundRepository, InboundStatus } from "./types.js";

/** The reason recorded when an item authored by our own account is dismissed. Stored in the row's existing respondedNote column. */
export const OWN_ACCOUNT_NOTE = "own account";

/** Lower-cases and strips a leading "@" and surrounding whitespace. Exact comparison only: "FillbookHQ_" or "Fi11bookHQ" are different accounts and must NOT match. */
export function normalizeHandle(handle: string | null | undefined): string {
  return (handle ?? "").trim().replace(/^@+/, "").toLowerCase();
}

export interface OwnAccountIdentity {
  /** The numeric X user id from /users/me, when the caller has it (ingestion does; queue loads usually don't). */
  userId?: string | null;
  /** Defaults to OFFICIAL_HANDLE. */
  handle?: string | null;
}

/**
 * True when a post was authored by Fillbook's OWN account. Such a post is never
 * inbound engagement and never an impersonation: it is us. Matches the numeric
 * author id (when both sides have one) or the handle, case-insensitively.
 * Only X rows are compared: a YouTube row's "handle" is a free-text display name.
 */
export function isOwnAccountAuthor(
  author: { platform?: string | null; authorId?: string | null; authorHandle?: string | null },
  own: OwnAccountIdentity = {},
): boolean {
  if (author.platform && author.platform.toLowerCase() !== "x") return false;
  if (own.userId && author.authorId && author.authorId === own.userId) return true;
  const ownHandle = normalizeHandle(own.handle ?? OFFICIAL_HANDLE);
  const handle = normalizeHandle(author.authorHandle);
  return ownHandle !== "" && handle !== "" && handle === ownHandle;
}

export function isOwnAccountRow(row: Pick<InboundEngagement, "platform" | "authorExternalId" | "authorHandle">, own: OwnAccountIdentity = {}): boolean {
  return isOwnAccountAuthor({ platform: row.platform, authorId: row.authorExternalId, authorHandle: row.authorHandle }, own);
}

/** Statuses that still count as an open queue item. */
export const ACTIVE_INBOUND_STATUSES: InboundStatus[] = ["new", "needs_response", "draft_ready", "follow_up", "review_needed"];

/**
 * Closes (never deletes) every still-active item authored by our OWN account, with the reason "own account" in the
 * existing responded_note column. Idempotent: a closed row is no longer active, so a second run finds nothing, and
 * items from other authors are never touched. Audit data (body, draft, timestamps) is left exactly as it was.
 * Returns the ids it closed.
 */
export async function closeOwnAccountItems(repo: InboundRepository, own: OwnAccountIdentity = {}): Promise<string[]> {
  const active = await repo.listByStatus(ACTIVE_INBOUND_STATUSES);
  const closed: string[] = [];
  for (const row of active) {
    if (!isOwnAccountRow(row, own)) continue;
    const previous = row.respondedNote?.trim();
    await repo.updateStatus(row.id, "closed", { respondedNote: previous ? `${OWN_ACCOUNT_NOTE} (was: ${previous})` : OWN_ACCOUNT_NOTE });
    closed.push(row.id);
  }
  return closed;
}

