/**
 * Outcome record for the F1 to F5 reply checks (ChatGPT APP-DEFECT-1128: the 7-day watch could not count them because nothing was stored).
 * Codes only, never reply or post text, so nothing personal or sensitive is copied. Stored as a JSON string under one key in the existing
 * score_breakdown JSON of prospecting_candidates (no migration, same pattern as draft_options), and also logged as one line, because a
 * draft that is rejected outright must leave its row untouched (draftScreenedOutPost's contract) and so can only be counted in the logs.
 *
 * Every check is "pass", "hit" or "not_run", so a check that passed is never confused with one that never ran:
 * - F3 (sensitive post) and F4 (@grok) run on the post at draft time. They are "not_run" for an owner override (the free gate is skipped)
 *   or when an earlier part of the free gate already turned the post away.
 * - F2 (unsupported fact or firm rule) runs on each option. It is "not_run" when an earlier hard check (the shared guardrails) already failed.
 * - F1 (journal lens) runs only on the helpful option, and only when that option has no other soft problem first.
 * - F5 (Fillbook flag follows the posted text) is stored separately when the reply is marked replied.
 */
import { whyNotReplyWorthy, type RelevanceOptions } from "./prospectingRelevance.js";
import { isAddressedToGrok } from "./prospectingReplyChecks.js";

export const REPLY_CHECKS_KEY = "reply_checks";
export const REPLY_CHECK_F5_KEY = "reply_check_f5";

export type CheckResult = "pass" | "hit" | "not_run";

export interface OptionCheck {
  style: "sharp" | "helpful" | "single";
  f1: CheckResult;
  f2: CheckResult;
  /** Another hard problem (banned phrase, link, tag, Fillbook rule, length...). */
  otherHard: boolean;
  /** Another soft style problem. */
  otherSoft: boolean;
}

export interface AttemptCheck {
  n: number;
  /** False when the drafter judged the post irrelevant on this attempt (the options were then not checked). */
  relevant: boolean;
  options: OptionCheck[];
}

export type Disposition =
  /** Shown with no problem left. */
  | "shown_clean"
  /** Shown as the best attempt with a soft problem still present ("shown anyway"). */
  | "shown_soft_flag"
  /** Attempts ran out with one option failing a hard check; only the clean option was shown. */
  | "shown_one_option"
  /** Every attempt failed a hard check; nothing was shown. */
  | "rejected_hard"
  /** The free gate turned the post away at draft time. */
  | "gate_at_draft"
  /** A model relevance check (cheap check or the drafter) turned the post away. */
  | "irrelevant_at_draft"
  /** A clean draft was ready but the row had moved on meanwhile (replied, skipped, expired), so it was not saved. Logged only. */
  | "discarded_row_changed";

export interface ReplyCheckRecord {
  v: 1;
  at: string;
  ownerOverride: boolean;
  f3: CheckResult;
  f4: CheckResult;
  /** The free-gate reason code when the gate turned the post away (e.g. "sensitive_personal"). */
  gateReason?: string;
  attempts: AttemptCheck[];
  disposition: Disposition;
  /** Which attempt was shown (1-based), when one was. */
  shownAttempt?: number;
  /** The shown draft still had the F1 journal-lens problem. */
  shownWithF1: boolean;
  /** The shown draft still had any soft problem (F1 included). */
  shownWithSoft: boolean;
}

/** F3 and F4 from the free gate at draft time. A post that passes the whole gate passed both. */
export function postCheckResults(postText: string, opts: RelevanceOptions, ownerOverride: boolean): { f3: CheckResult; f4: CheckResult; gateReason: string | null } {
  if (ownerOverride) return { f3: "not_run", f4: "not_run", gateReason: null };
  const reason = whyNotReplyWorthy(postText, opts);
  if (reason === null) return { f3: "pass", f4: "pass", gateReason: null };
  // The real gate (isReplyWorthyBase) runs promo-type checks, then @grok (F4), then the off-market author check, then the sensitive-post
  // check (F3) last. whyNotReplyWorthy names off_market_author before @grok, so for that reason F4 did run and is read directly.
  if (reason === "addressed_to_grok") return { f3: "not_run", f4: "hit", gateReason: reason };
  if (reason === "off_market_author") return { f3: "not_run", f4: isAddressedToGrok(postText.normalize("NFKC")) ? "hit" : "pass", gateReason: reason };
  if (reason === "sensitive_personal") return { f3: "hit", f4: "pass", gateReason: reason };
  if (reason === "sales_funnel") return { f3: "pass", f4: "pass", gateReason: reason };
  // Any earlier reason (not trading, options, promo, broadcast, AI hype...) stopped the gate before either check.
  return { f3: "not_run", f4: "not_run", gateReason: reason };
}

export class ReplyCheckLog {
  private readonly attempts: AttemptCheck[] = [];
  private readonly drafts: unknown[] = [];
  private gateReason: string | null = null;

  constructor(
    private readonly ownerOverride: boolean,
    private f3: CheckResult,
    private f4: CheckResult,
    gateReason: string | null = null,
  ) {
    this.gateReason = gateReason;
  }

  /** Records one drafting attempt; `draft` is the model result object, used later to find which attempt was shown. */
  addAttempt(draft: unknown, relevant: boolean, options: OptionCheck[]): void {
    this.drafts.push(draft);
    this.attempts.push({ n: this.attempts.length + 1, relevant, options });
  }

  build(disposition: Disposition, shownDraft?: unknown, shownStyles?: ReadonlyArray<OptionCheck["style"]>, now: Date = new Date()): ReplyCheckRecord {
    const index = shownDraft === undefined ? -1 : this.drafts.lastIndexOf(shownDraft);
    const shown = index >= 0 ? this.attempts[index]! : undefined;
    const shownOptions = shown ? shown.options.filter((o) => !shownStyles || shownStyles.includes(o.style)) : [];
    return {
      v: 1,
      at: now.toISOString(),
      ownerOverride: this.ownerOverride,
      f3: this.f3,
      f4: this.f4,
      ...(this.gateReason ? { gateReason: this.gateReason } : {}),
      attempts: this.attempts,
      disposition,
      ...(shown ? { shownAttempt: shown.n } : {}),
      shownWithF1: shownOptions.some((o) => o.f1 === "hit"),
      shownWithSoft: shownOptions.some((o) => o.f1 === "hit" || o.otherSoft),
    };
  }
}

/** The score_breakdown patch for a record (a JSON string, as score_breakdown values are strings). */
export function replyChecksPatch(record: ReplyCheckRecord): Record<string, string> {
  return { [REPLY_CHECKS_KEY]: JSON.stringify(record) };
}

/** One log line per drafting outcome, codes plus the row id (not personal data), so a rejected draft can be joined to its row. */
export function logReplyChecks(record: ReplyCheckRecord, candidateId: string, log: (line: string) => void = console.log): void {
  log(`[prospecting] reply_checks ${JSON.stringify({ candidateId, ...record })}`);
}

/**
 * F5: did the stored Fillbook flag have to change to follow the posted text? "hit" when it changed (an edit, or a stale draft-time flag:
 * the draft-time flag is true when ANY offered option names Fillbook, so posting a plain option also corrects it), "pass" when it held,
 * "not_run" when there was no posted text to read.
 */
export function f5Result(postedText: string | null | undefined, draftedFlag: boolean | null | undefined, postedFlag: boolean): CheckResult {
  if (!postedText) return "not_run";
  return draftedFlag === postedFlag ? "pass" : "hit";
}
