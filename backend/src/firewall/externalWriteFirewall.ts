/**
 * External Write Firewall — see docs/EXTERNAL_WRITE_FIREWALL.md.
 *
 * This module is the ONLY code path allowed to authorize an action that
 * touches an external platform. EXTERNAL_WRITE is permanently rejected:
 * there is no flag, table row, env var, or admin call anywhere in this
 * module that can change that outcome.
 *
 * The Live Host speech exception (2026-10-09) was removed with the Live Host
 * feature on 2026-10-24; there are no exceptions.
 */

export type ActionClass =
  | "READ"
  | "INTERNAL_WRITE"
  | "EXTERNAL_DRAFT"
  | "EXTERNAL_WRITE";

export interface FirewallAction {
  /** Stable machine name, e.g. "x.post_tweet", "search_console.read_queries". */
  name: string;
  actionClass: ActionClass;
  /** Free-form context for the audit log (platform, target, etc). Must not contain secrets. */
  context?: Record<string, unknown>;
}

export interface AuditRecord {
  actionName: string;
  actionClass: ActionClass;
  outcome: "allowed" | "drafted" | "rejected";
  reason: string;
  context: Record<string, unknown>;
  timestamp: string;
}

export class ExternalWriteRejectedError extends Error {
  constructor(actionName: string) {
    super(
      `ExternalWriteFirewall: "${actionName}" is classified EXTERNAL_WRITE and is permanently rejected. ` +
        `Fillbook Growth OS never autonomously publishes, sends, submits, replies, comments, DMs, likes, ` +
        `reposts, follows, or otherwise communicates externally. The human owner must perform this action.`,
    );
    this.name = "ExternalWriteRejectedError";
  }
}

export type AuditSink = (record: AuditRecord) => void | Promise<void>;

/**
 * Pure guard: throws for EXTERNAL_WRITE, otherwise returns the action
 * unchanged so callers can proceed. No parameter here can suppress the
 * throw for EXTERNAL_WRITE — that is intentional, not an oversight.
 */
export function authorize(action: FirewallAction): FirewallAction {
  if (action.actionClass === "EXTERNAL_WRITE") {
    throw new ExternalWriteRejectedError(action.name);
  }
  return action;
}

/**
 * Authorize an action and record the decision to the audit log, regardless
 * of outcome. `auditSink` defaults to a no-op so this module has no hard
 * dependency on the database; callers wire in the real audit_logs writer.
 */
export async function authorizeAndAudit(
  action: FirewallAction,
  auditSink: AuditSink = () => {},
): Promise<FirewallAction> {
  const timestamp = new Date().toISOString();
  try {
    const result = authorize(action);
    const outcome = action.actionClass === "EXTERNAL_DRAFT" ? "drafted" : "allowed";
    await auditSink({
      actionName: action.name,
      actionClass: action.actionClass,
      outcome,
      reason: `classified ${action.actionClass}`,
      context: action.context ?? {},
      timestamp,
    });
    return result;
  } catch (err) {
    await auditSink({
      actionName: action.name,
      actionClass: action.actionClass,
      outcome: "rejected",
      reason: err instanceof Error ? err.message : String(err),
      context: action.context ?? {},
      timestamp,
    });
    throw err;
  }
}

/**
 * Canonical registry of known EXTERNAL_WRITE action names. Not exhaustive
 * by design — the firewall rejects by actionClass, not by name-matching —
 * but this list is what backend/test/firewall.test.ts drives its
 * "every prohibited action fails" test from, and what later-phase platform
 * integrations should classify their own actions against.
 */
export const KNOWN_EXTERNAL_WRITE_ACTIONS = [
  "x.post_tweet",
  "x.reply_to_tweet",
  "x.send_dm",
  "x.like_tweet",
  "x.retweet",
  "x.follow_account",
  "tiktok.publish_video",
  "tiktok.comment",
  "tiktok.like_video",
  "tiktok.follow_account",
  "youtube.publish_video_public",
  "youtube.post_comment",
  "youtube.like_video",
  "youtube.subscribe",
  "email.send",
  "discord.post_message",
  "generic.submit_external_form",
  "generic.modify_public_profile",
  "generic.start_ad_campaign",
  "generic.purchase_promotion",
] as const;
