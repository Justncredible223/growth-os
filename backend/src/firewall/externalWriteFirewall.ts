/**
 * External Write Firewall — see docs/EXTERNAL_WRITE_FIREWALL.md.
 *
 * This module is the ONLY code path allowed to authorize an action that
 * touches an external platform. EXTERNAL_WRITE is permanently rejected:
 * there is no flag, table row, env var, or admin call anywhere in this
 * module that can change that outcome.
 *
 * One owner-approved exception exists (2026-10-09): the Live Host may SPEAK
 * on a live stream the owner has switched on. It has its own class
 * (LIVE_HOST_SPEECH), its own single action name and its own guard,
 * authorizeLiveHostSpeech() below. authorize() rejects that class too, so
 * declaring it is never enough. See the "Live Host exception" section of
 * the doc.
 */

export type ActionClass =
  | "READ"
  | "INTERNAL_WRITE"
  | "EXTERNAL_DRAFT"
  | "EXTERNAL_WRITE"
  | "LIVE_HOST_SPEECH";

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
  // Live speech is only ever allowed through authorizeLiveHostSpeech(), which checks the owner's switch, the
  // system pause and the guardrail result. Reaching this generic guard with that class is always a mistake.
  if (action.actionClass === "LIVE_HOST_SPEECH") {
    throw new ExternalWriteRejectedError(action.name);
  }
  return action;
}

/** The one action name the Live Host exception covers. Nothing else can be authorized as LIVE_HOST_SPEECH. */
export const LIVE_HOST_SPEAK_ACTION = "live_host.speak";

export class LiveHostSpeechRejectedError extends Error {
  constructor(reason: string) {
    super(`ExternalWriteFirewall: "${LIVE_HOST_SPEAK_ACTION}" rejected: ${reason}`);
    this.name = "LiveHostSpeechRejectedError";
  }
}

/**
 * Everything authorizeLiveHostSpeech() needs to see before one line is spoken. Callers pass what they actually
 * read and computed for this line (the settings row, the pause flag, the guardrail result). None of these is a
 * standing permission, and a missing or false value always rejects.
 */
export interface LiveHostSpeechGrant {
  /** live_host_settings.desired_state === "on": the owner switched the host on in the app. */
  ownerSwitchedOn: boolean;
  /** system_settings.paused: the global Pause System switch. */
  systemPaused: boolean;
  /** The open live_host_sessions row this line belongs to. */
  sessionId: string | null;
  /** The mechanical guardrail verdict for exactly this text (liveHostGuardrails.ts). Null means it passed. */
  guardrailProblem: string | null;
  /** The exact text to be spoken. */
  text: string;
}

/**
 * The single owner-approved exception to "never communicates externally" (docs/EXTERNAL_WRITE_FIREWALL.md,
 * "Live Host exception"). Allows one spoken line on the owner's own live stream, and only when the owner has
 * switched the host on, the system is not paused, the line belongs to an open session and the line passed the
 * mechanical guardrails. It cannot post, comment, reply in chat, DM, like or follow: those stay EXTERNAL_WRITE.
 */
export function authorizeLiveHostSpeech(grant: LiveHostSpeechGrant): FirewallAction {
  if (grant.ownerSwitchedOn !== true) throw new LiveHostSpeechRejectedError("the owner has not switched the Live Host on");
  if (grant.systemPaused !== false) throw new LiveHostSpeechRejectedError("the system is paused");
  if (!grant.sessionId) throw new LiveHostSpeechRejectedError("there is no open live session");
  if (grant.text.trim().length === 0) throw new LiveHostSpeechRejectedError("there is nothing to say");
  if (grant.guardrailProblem !== null) throw new LiveHostSpeechRejectedError(`the line ${grant.guardrailProblem}`);
  return {
    name: LIVE_HOST_SPEAK_ACTION,
    actionClass: "LIVE_HOST_SPEECH",
    context: { sessionId: grant.sessionId, characters: grant.text.length },
  };
}

/** authorizeLiveHostSpeech() plus an audit row for every decision, allowed or rejected. */
export async function authorizeLiveHostSpeechAndAudit(grant: LiveHostSpeechGrant, auditSink: AuditSink = () => {}): Promise<FirewallAction> {
  const timestamp = new Date().toISOString();
  try {
    const action = authorizeLiveHostSpeech(grant);
    await auditSink({
      actionName: action.name,
      actionClass: action.actionClass,
      outcome: "allowed",
      reason: "owner switched the Live Host on and the line passed guardrails",
      context: action.context ?? {},
      timestamp,
    });
    return action;
  } catch (err) {
    await auditSink({
      actionName: LIVE_HOST_SPEAK_ACTION,
      actionClass: "LIVE_HOST_SPEECH",
      outcome: "rejected",
      reason: err instanceof Error ? err.message : String(err),
      context: { sessionId: grant.sessionId },
      timestamp,
    });
    throw err;
  }
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
