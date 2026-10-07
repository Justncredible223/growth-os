import { buildBarsPlan } from "./chartBarsConcepts.js";
import type { ChartTone, MockDetailRow, MockFocus, MockHero, MockRow, MockSpec, MockWindow, ScenePlan } from "./types.js";

/**
 * The 30 older concepts. NO LONGER OFFERED since 2026-10-07 (owner decision: they open on "what the screen is", averaged ~100 views
 * and 1.9-4.1 s watch time; the offered pool is now freshConcepts.ts), but they stay in the catalog so a script already drafted or approved from
 * one still renders. Originally the concepts the app offered (owner decision, 2026-10-03: one new video a day, replacing the first twelve). Each is drawn
 * from a verified recording's facts only -- no figure here is invented -- and runs through the same checks as every
 * product-mock concept (claims, fit, story bar). They are listed in the order they are requested: DAILY_CONCEPT_ORDER is
 * "day 1" to "day 30", and the voice-script sheet (scripts/printVoiceScripts.ts) prints them in that order.
 *
 * A concept is five beats, the way the first twelve were:
 *   1 what the screen is   2 the first figure   3 the "but" (a second figure that turns it)
 *   4 what else the screen shows   5 the invitation
 * Each spoken line is 7 words or fewer, whole dollars only (test/narratedMocks.test.ts).
 */
export interface Daily {
  slug: string;
  title: string;
  topic: string;
  assetId: string;
  expectedTopic: string;
  /** Other topics of the cited facts on the same recording. */
  also?: string[];
  accent: "good" | "bad";
  lines: string[];
  opening: MockHero[];
  windows: MockWindow[];
  focus: [MockFocus, MockFocus];
  details: { title: string; rows: Array<[string, string, ChartTone]>; footer?: string };
  /** Fact keys on the recording that every beat cites (the mock's windows carry all of them). */
  facts: string[];
  say: [string, string, string, string, string];
  cap: [string, string, string, string, string];
  take: [string, string, string, string, string];
}

export const h = (label: string, value: string, tone: ChartTone): MockHero => ({ label, value, tone });
export const r = (label: string, sub: string | undefined, value: string, tone: ChartTone, meter?: number): MockRow => ({ label, ...(sub ? { sub } : {}), value, tone, ...(meter !== undefined ? { meter: { markAt: meter } } : {}) });
export const w = (title: string, rows: MockRow[]): MockWindow => ({ title, rows });
export const f = (hero: MockHero, window: number, row: number): MockFocus => ({ hero, window, row });

export function build(n: number, c: Daily, prefix = "daily"): ScenePlan {
  const id = String(n).padStart(2, "0");
  const details: MockSpec["details"] = {
    title: c.details.title,
    rows: c.details.rows.map(([label, value, tone]): MockDetailRow => ({ label, value, tone })),
    footer: c.details.footer ?? "From your synced trades.",
  };
  return buildBarsPlan({
    planId: `${prefix}-${id}-${c.slug}`,
    title: c.title,
    topic: c.topic,
    variationId: `${prefix}-${id}`,
    assetId: c.assetId,
    expectedTopic: c.expectedTopic,
    ...(c.also ? { alsoTopics: c.also } : {}),
    lines: c.lines,
    accent: c.accent,
    mock: { tag: "Demo data", opening: c.opening, windows: c.windows, focus: c.focus, details },
    beats: c.say.map((narration, i) => ({
      stage: i + 1,
      seconds: 2.6,
      facts: c.facts,
      narration,
      takeaway: c.take[i]!,
      caption: c.cap[i]!,
      ...(i === 3 ? { capability: true } : {}),
      ...(i === 4 ? { closing: true } : {}),
    })),
  });
}

const BRIEF = "rec.p7-daily-brief.v1";
const RULES = "rec.p2-rules-buffer.v2";
const SETUPS = "rec.p1-reports-setup-breakdown.v2";
const SIZE = "rec.p3-trades-orb-size.v2";
const SIM = "rec.p5-rule-simulator.v1";
const PAYOUT = "rec.p9-payout-timeline.v1";
const INSIGHTS = "rec.b3-insights-behavior.v1";
const ACCOUNTS = "rec.b3-accounts-overview.v1";
const EDGE = "rec.b3-your-edge.v1";
const HEALTH = "rec.p4-account-health-consistency.v1";
const TRAILING = "rec.hs-trailing-account.v1";
const FINALDAY = "rec.hs-finalday-account.v1";
const BEHAVIOR = "rec.hs-behavior-account.v1";
const PAYACCT = "rec.hs-payout-account.v1";

const CONCEPTS: Daily[] = [
  // 01
  {
    slug: "brief-room", title: "$1,725 to the floor, $1,000 left today", topic: "A sample account's Daily Brief: the buffer to the drawdown floor and the loss limit left today",
    assetId: BRIEF, expectedTopic: "daily_brief", accent: "good", lines: ["$1,725 of", "room. Only", "$1,000 today."],
    opening: [h("Buffer to the floor", "$1,725", "good"), h("Loss limit left", "$1,000", "good")],
    windows: [w("Daily Brief", [r("Buffer", "to the floor", "$1,725", "good"), r("Loss limit", "left today", "$1,000", "good")])],
    focus: [f(h("Buffer to the floor", "$1,725", "good"), 0, 0), f(h("Today's loss limit", "$1,000", "good"), 0, 1)],
    details: { title: "Daily Brief · the rest", rows: [["Last session · 1 trade", "-$17", "bad"], ["Strongest window", "Open", "good"], ["Open · 22 trades", "64% win", "good"]] },
    facts: ["brief.account", "brief.buffer", "brief.loss_limit", "brief.last_session", "brief.window"],
    say: ["Your Fillbook Daily Brief starts with room.", "Buffer to the floor: $1,725.", "But today's limit is $1,000.", "Fillbook adds your last session.", "Find your own room."],
    cap: ["Daily Brief: your room.", "$1,725 to the floor.", "$1,000 left today.", "Last session and best window.", "Open your Daily Brief."],
    take: ["The Daily Brief starts with room.", "The buffer to the floor.", "The loss limit left today.", "It adds the last session.", "Check your own room."],
  },
  // 02
  {
    slug: "brief-last-session", title: "Last session: lost $17 on one trade", topic: "A sample account's Daily Brief: how the last session ended",
    assetId: BRIEF, expectedTopic: "daily_brief", accent: "bad", lines: ["Lost $17.", "Only one", "trade."],
    opening: [h("Last session", "-$17", "bad")],
    windows: [w("Daily Brief", [r("Last session", "1 trade", "-$17", "bad"), r("Loss limit", "left today", "$1,000", "good")])],
    focus: [f(h("Last session", "-$17", "bad"), 0, 0), f(h("Still left today", "$1,000", "good"), 0, 1)],
    details: { title: "Daily Brief · account", rows: [["Buffer to the floor", "$1,725", "good"], ["Loss limit left today", "$1,000", "good"], ["Strongest window", "Open", "good"]] },
    facts: ["brief.last_session", "brief.last_session_value", "brief.account", "brief.loss_limit", "brief.buffer", "brief.window"],
    say: ["Fillbook's brief opens with last session.", "It lost $17.", "But it was only one trade.", "Buffer and limit sit beside it.", "Review your last session."],
    cap: ["Daily Brief: last session.", "Last session: lost $17.", "Just one trade.", "Buffer and limit beside it.", "Review your last session."],
    take: ["The brief opens with the last session.", "It lost $17.", "It was only one trade.", "Buffer and limit sit beside it.", "Review your own last session."],
  },
  // 03
  {
    slug: "brief-strong-window", title: "The open: 22 trades, 64% win", topic: "A sample account's Daily Brief: its strongest trading window",
    assetId: BRIEF, expectedTopic: "daily_brief", accent: "good", lines: ["The open wins", "64%. Only 22", "trades."],
    opening: [h("Strongest window", "64%", "good")],
    windows: [w("Daily Brief", [r("Open", "9:30-10:30am ET", "64% win", "good"), r("Trades", "in that window", "22", "good")])],
    focus: [f(h("The open · win rate", "64%", "good"), 0, 0), f(h("Trades in the window", "22", "good"), 0, 1)],
    details: { title: "Daily Brief · the rest", rows: [["Buffer to the floor", "$1,725", "good"], ["Loss limit left today", "$1,000", "good"], ["Last session · 1 trade", "-$17", "bad"]] },
    facts: ["brief.window", "brief.window_stats", "brief.window_name", "brief.account", "brief.last_session"],
    say: ["Fillbook's Daily Brief names your strongest window.", "The open wins 64%.", "But that is only 22 trades.", "Fillbook also shows today's room.", "Find your own best window."],
    cap: ["Daily Brief: best window.", "The open: 64% win.", "Across 22 trades.", "Room and last session too.", "Find your best window."],
    take: ["The brief names your best window.", "The open wins 64%.", "Out of 22 trades.", "It adds room and last session.", "Find your own best window."],
  },
  // 04
  {
    slug: "target-progress", title: "$387 of a $3,000 target: 13%", topic: "A sample evaluation account's profit target progress",
    assetId: RULES, expectedTopic: "profit_target", also: ["account_context", "drawdown", "buffer"], accent: "bad", lines: ["$3,000", "target. Only", "$387 so far."],
    opening: [h("Toward the target", "13%", "bad")],
    windows: [w("Prop firm rules", [r("Profit target", "evaluation", "$3,000", "good"), r("Net so far", "13% of target", "$387", "bad")])],
    focus: [f(h("Profit target", "$3,000", "good"), 0, 0), f(h("Net so far", "$387", "bad"), 0, 1)],
    details: { title: "Prop firm rules · account", rows: [["Trailing drawdown buffer", "$1,725", "good"], ["Loss limit left today", "$1,000", "good"], ["Wins / losses", "14W / 8L", "good"]] },
    facts: ["account.profit_target_progress", "account.net_pnl_dashboard", "rule.trailing_drawdown_buffer", "rule.daily_loss_limit_remaining"],
    say: ["Fillbook's rules page tracks your profit target.", "The target is $3,000.", "But the account is at $387.", "It adds buffer and daily limit.", "Track your own target."],
    cap: ["Rules: profit target.", "Target: $3,000.", "So far: $387, 13%.", "Buffer and daily limit too.", "Track your own target."],
    take: ["The rules page tracks the target.", "The target is $3,000.", "The account is at $387.", "It adds buffer and limit.", "Track your own target."],
  },
  // 05
  {
    slug: "net-pnl-wins", title: "14 wins, 8 losses, $387 net", topic: "A sample account's dashboard: net P&L and its win and loss count",
    assetId: RULES, expectedTopic: "account_context", also: ["profit_target", "drawdown", "buffer"], accent: "good", lines: ["14 wins.", "But 8", "losses."],
    opening: [h("Wins", "14", "good"), h("Losses", "8", "bad")],
    windows: [w("Dashboard", [r("Wins", "closed trades", "14", "good"), r("Losses", "closed trades", "8", "bad")]), w("Dashboard · net", [r("Net P&L", "all trades", "$387", "good"), r("Profit target", "of $3,000", "13%", "bad")])],
    focus: [f(h("Winning trades", "14", "good"), 0, 0), f(h("Net P&L", "$387", "good"), 1, 0)],
    details: { title: "Prop firm rules", rows: [["Trailing drawdown buffer", "$1,725", "good"], ["Loss limit left today", "$1,000", "good"], ["Profit target", "$3,000", "good"]] },
    facts: ["account.net_pnl_dashboard", "account.profit_target_progress", "rule.trailing_drawdown_buffer", "rule.daily_loss_limit_remaining"],
    say: ["Your Fillbook dashboard counts wins and losses.", "Fourteen winners.", "But eight losses, and $387 net.", "Fillbook adds your rules beside it.", "Count your own wins."],
    cap: ["Dashboard: wins and losses.", "14 winning trades.", "8 losses. Net $387.", "Rules sit beside the P&L.", "Count your own wins."],
    take: ["The dashboard counts wins and losses.", "Fourteen wins.", "Eight losses, $387 net.", "It adds the rules beside it.", "Count your own wins."],
  },
  // 06
  {
    slug: "orb-setup", title: "One setup: 8 trades, 25% win, lost $422", topic: "A sample account's setup report: its weakest setup",
    assetId: SETUPS, expectedTopic: "setup_breakdown", also: ["month_total"], accent: "bad", lines: ["One setup", "wins only 25%.", "Overall 64%."],
    opening: [h("Opening Range Break", "25%", "bad")],
    windows: [w("Reports · by setup", [r("Opening Range", "8 trades", "25% win", "bad"), r("All trades", "22 trades", "64% win", "good")])],
    focus: [f(h("Opening Range Break", "25%", "bad"), 0, 0), f(h("Every trade", "64%", "good"), 0, 1)],
    details: { title: "Reports · overview", rows: [["Net P&L", "$387.08", "good"], ["Win rate", "64%", "good"], ["Total trades", "22", "good"]] },
    facts: ["setup.opening_range_break_result", "month.net_pnl"],
    say: ["Fillbook Reports rank your setups, worst first.", "One setup wins 25%.", "But all trades win 64%.", "It adds net P&L and trade count.", "Rank your own setups."],
    cap: ["Reports: by setup.", "Opening Range: 25% win.", "All trades: 64% win.", "Net P&L and trade count.", "Rank your own setups."],
    take: ["Reports rank setups, worst first.", "One setup wins 25%.", "Overall it is 64%.", "It adds the net P&L.", "Rank your own setups."],
  },
  // 07
  {
    slug: "one-setup-cost", title: "One setup lost $422 in 8 trades", topic: "A sample account's setup report: what its weakest setup cost",
    assetId: SETUPS, expectedTopic: "month_total", also: ["setup_breakdown"], accent: "bad", lines: ["One setup", "lost $422.", "All trades: +$387."],
    opening: [h("One setup cost", "$422", "bad"), h("All 22 trades", "$387", "good")],
    windows: [w("Reports · by setup", [r("Opening Range", "8 trades", "-$422", "bad"), r("All trades", "22 trades", "$387", "good")])],
    focus: [f(h("One setup", "-$422", "bad"), 0, 0), f(h("Everything else", "$387", "good"), 0, 1)],
    details: { title: "Reports · overview", rows: [["Net P&L", "$387.08", "good"], ["Win rate", "64%", "good"], ["Total trades", "22", "good"]] },
    facts: ["setup.opening_range_break_result", "month.net_pnl"],
    say: ["Fillbook shows what each setup cost.", "One setup lost $422.", "Yet all 22 trades netted $387.", "Reports add win rate and count.", "See what yours cost."],
    cap: ["Reports: setup cost.", "One setup: lost $422.", "All 22 trades: +$387.", "Win rate and trade count.", "See what yours cost."],
    take: ["Reports show what each setup cost.", "One setup lost $422.", "All trades netted $387.", "It adds win rate and count.", "See what your setups cost."],
  },
  // 08
  {
    slug: "size-over-plan", title: "5 contracts against a plan of 3", topic: "A sample trade log: a trade larger than the trading plan's maximum",
    assetId: SIZE, expectedTopic: "trade_size", accent: "bad", lines: ["5 contracts.", "Your plan said", "only 3."],
    opening: [h("Contracts traded", "5", "bad"), h("Plan maximum", "3", "good")],
    windows: [w("Trades", [r("MNQ Short", "5 contracts", "-$257", "bad"), r("Plan limit", "max contracts", "3", "good")])],
    focus: [f(h("Contracts traded", "5", "bad"), 0, 0), f(h("Your plan's limit", "3", "good"), 0, 1)],
    details: { title: "Trading plan", rows: [["Max contracts per trade", "3", "good"], ["Last Opening Range trade", "5", "bad"], ["Result", "-$257.40", "bad"]] },
    facts: ["trade.orb_qty5_most_recent", "plan.max_contracts"],
    say: ["Fillbook's log checks size against plan.", "This trade used 5 contracts.", "But your plan says 3.", "The log shows the result beside it.", "Check your own size."],
    cap: ["Trades: size vs your plan.", "This trade: 5 contracts.", "Your plan's limit: 3.", "The result sits beside it.", "Check your own size."],
    take: ["The log checks size against the plan.", "The trade used 5 contracts.", "The plan limit is 3.", "The result sits beside it.", "Check your own size."],
  },
  // 09
  {
    slug: "plan-adherence", title: "92% on plan, but only 85% inside the window", topic: "A sample Plan vs reality check: overall adherence and the trading window",
    assetId: "rec.b3-plan-vs-reality.v1", expectedTopic: "plan_adherence", accent: "bad", lines: ["92% on plan.", "Only 85% in", "the window."],
    opening: [h("On plan overall", "92%", "good")],
    windows: [w("Plan vs reality", [r("Overall", "adherence", "92%", "good"), r("Trading window", "Slipping", "85%", "bad"), r("Max trades a day", "On plan", "90%", "good")])],
    focus: [f(h("Overall adherence", "92%", "good"), 0, 0), f(h("Inside the window", "85%", "bad"), 0, 1)],
    details: { title: "Plan vs reality · counts", rows: [["Timed trades in window", "111 of 131", "bad"], ["Days within trade cap", "43 of 48", "good"], ["Trade cap per day", "5", "good"]] },
    facts: ["plan.adherence"],
    say: ["Fillbook's plan check scores your adherence.", "Overall, you are 92% on plan.", "But the trading window: 85%.", "It counts trades inside your window.", "Check your own plan."],
    cap: ["Plan vs reality.", "Overall: 92% on plan.", "Trading window: 85%.", "Trades inside your window.", "Check your own plan."],
    take: ["The plan check scores adherence.", "Overall you are 92% on plan.", "The trading window is 85%.", "It counts trades inside the window.", "Check your own plan."],
  },
  // 10
  {
    slug: "payout-pace", title: "129 more trading days at this pace", topic: "A sample payout timeline: days to payout-ready at the current pace",
    assetId: PAYOUT, expectedTopic: "payouts", accent: "bad", lines: ["$20 a day.", "Still 129 days", "away."],
    opening: [h("More trading days", "129", "bad")],
    windows: [w("Payouts · timeline", [r("Days to payout", "at this pace", "129", "bad"), r("Current pace", "per trading day", "$20", "good")])],
    focus: [f(h("Days to go", "129", "bad"), 0, 0), f(h("Pace per day", "$20", "good"), 0, 1)],
    details: { title: "Payouts · readiness", rows: [["Net toward target", "13%", "bad"], ["Trading days logged", "19", "good"], ["Minimum days", "10", "good"]] },
    facts: ["payout.timeline", "payout.readiness"],
    say: ["Fillbook's payout timeline projects your pace.", "129 more trading days.", "At twenty dollars a day.", "Readiness adds days logged.", "Check your own pace."],
    cap: ["Payouts: the timeline.", "129 more trading days.", "At $20.37 a day.", "Days logged and target.", "Check your own pace."],
    take: ["The timeline projects your pace.", "129 more trading days.", "At about $20 a day.", "Readiness adds days logged.", "Check your own pace."],
  },
  // 11
  {
    slug: "payout-days-logged", title: "19 trading days logged, 10 required", topic: "A sample payout readiness checklist: the minimum trading days",
    assetId: PAYOUT, expectedTopic: "payouts", accent: "good", lines: ["19 days logged.", "Only 10", "needed."],
    opening: [h("Trading days logged", "19", "good")],
    windows: [w("Payouts · readiness", [r("Trading days", "logged", "19", "good"), r("Minimum days", "required", "10", "good")])],
    focus: [f(h("Days logged", "19", "good"), 0, 0), f(h("Minimum required", "10", "good"), 0, 1)],
    details: { title: "Payouts · readiness", rows: [["Profit target", "13%", "bad"], ["Best day vs cap", "46% / 40%", "bad"], ["Days to payout-ready", "129", "bad"]] },
    facts: ["payout.readiness", "payout.timeline"],
    say: ["Fillbook's payout readiness lists each requirement.", "Days logged: 19.", "But the minimum is 10.", "Other lines are still open.", "Read your own checklist."],
    cap: ["Payouts: readiness.", "Trading days: 19.", "The minimum: 10.", "Other lines are still open.", "Read your own checklist."],
    take: ["Readiness lists each requirement.", "Nineteen days logged.", "The minimum is ten.", "Other requirements are open.", "Read your own checklist."],
  },
  // 12
  {
    slug: "busy-day", title: "6 trades against a norm of 2.7", topic: "A sample account's flagged busy days: 6 trades against its own 2.7 a day",
    assetId: INSIGHTS, expectedTopic: "overtrading", accent: "bad", lines: ["6 trades. Your", "norm: only", "2.7 a day."],
    opening: [h("Trades that day", "6", "bad"), h("Your daily norm", "2.7", "good")],
    windows: [w("Insights · flagged days", [r("Flagged day", "Sep 18 · 6 trades", "-$468", "bad"), r("Flagged day", "Sep 24 · 6 trades", "-$465", "bad")])],
    focus: [f(h("Trades that day", "6", "bad"), 0, 0), f(h("Another flagged day", "-$465", "bad"), 0, 1)],
    details: { title: "Insights · flagged days", rows: [["Sep 10 · 6 trades", "$15.28", "good"], ["Sep 18 · 6 trades", "-$468.20", "bad"], ["Sep 24 · 6 trades", "-$464.72", "bad"]] },
    facts: ["behavior.overtraded"],
    say: ["Fillbook Insights flags unusually busy days.", "Six trades that day.", "But your norm is 2.7.", "Insights list each flagged day.", "Review your busy days."],
    cap: ["Insights: busy days.", "Flagged: 6 trades.", "Your norm: 2.7 a day.", "Each flagged day, listed.", "Review your busy days."],
    take: ["Insights flag unusually busy days.", "Six trades that day.", "Your norm is 2.7.", "Each flagged day is listed.", "Review your own busy days."],
  },
  // 13
  {
    slug: "busy-day-cost", title: "Two flagged busy days lost $468 and $465", topic: "A sample account's flagged busy days and what two of them cost",
    assetId: INSIGHTS, expectedTopic: "overtrading", accent: "bad", lines: ["Two busy days.", "Lost $468,", "$465."],
    opening: [h("September 18", "-$468", "bad"), h("September 24", "-$465", "bad")],
    windows: [w("Insights · flagged days", [r("Sep 18", "6 trades", "-$468", "bad"), r("Sep 24", "6 trades", "-$465", "bad")])],
    focus: [f(h("Sep 18 · 6 trades", "-$468", "bad"), 0, 0), f(h("Sep 24 · 6 trades", "-$465", "bad"), 0, 1)],
    details: { title: "Insights · flagged days", rows: [["Sep 10 · 6 trades", "$15.28", "good"], ["Sep 18 · 6 trades", "-$468.20", "bad"], ["Sep 24 · 6 trades", "-$464.72", "bad"]] },
    facts: ["behavior.overtraded"],
    say: ["Fillbook Insights prices each flagged day.", "September 18 lost $468.", "But September 24 lost $465.", "Three flagged sessions, listed.", "Price your own busy days."],
    cap: ["Insights: what busy days cost.", "Sep 18: lost $468.", "Sep 24: lost $465.", "Three flagged sessions.", "Price your busy days."],
    take: ["Insights price each flagged day.", "September 18 lost $468.", "September 24 lost $465.", "Three flagged sessions.", "Price your own busy days."],
  },
  // 14
  {
    slug: "weak-hour", title: "11:00 wins 25%; the account wins 62%", topic: "A sample account's weakest hour compared with its overall win rate",
    assetId: INSIGHTS, expectedTopic: "time_of_day", accent: "bad", lines: ["Weak hour wins", "only 25%.", "Overall 62%."],
    opening: [h("The 11:00 hour", "25%", "bad"), h("Everything overall", "62%", "good")],
    windows: [w("Insights · weak hour", [r("11:00 hour", "20 timed trades", "25% win", "bad"), r("Overall", "all timed trades", "62% win", "good")])],
    focus: [f(h("The 11:00 hour", "25%", "bad"), 0, 0), f(h("Overall win rate", "62%", "good"), 0, 1)],
    details: { title: "Insights · weak hour", rows: [["Weak hour", "11:00", "bad"], ["Timed trades", "20", "good"], ["Net in that hour", "-$783.20", "bad"]] },
    facts: ["behavior.weak_hour"],
    say: ["Fillbook Insights flags your weak hour.", "The 11:00 hour wins 25%.", "But overall you win 62%.", "Insights add its net result.", "Find your own weak hour."],
    cap: ["Insights: weak hour.", "11:00 wins 25%.", "Overall: 62%.", "Net result of that hour.", "Find your weak hour."],
    take: ["Insights flag your weak hour.", "11:00 wins 25%.", "Overall it is 62%.", "It adds the net result.", "Find your own weak hour."],
  },
  // 15
  {
    slug: "weak-hour-cost", title: "One weak hour cost $783", topic: "A sample account's weak hour and what it cost",
    assetId: INSIGHTS, expectedTopic: "time_of_day", accent: "bad", lines: ["One hour lost", "$783. Only", "20 trades."],
    opening: [h("11:00 hour net", "-$783", "bad")],
    windows: [w("Insights · weak hour", [r("11:00 hour", "net result", "-$783", "bad"), r("Timed trades", "in that hour", "20", "good")])],
    focus: [f(h("11:00 hour", "-$783", "bad"), 0, 0), f(h("Trades in that hour", "20", "good"), 0, 1)],
    details: { title: "Insights · weak hour", rows: [["Win rate in that hour", "25%", "bad"], ["Win rate overall", "62%", "good"], ["Weak hour", "11:00", "bad"]] },
    facts: ["behavior.weak_hour"],
    say: ["Fillbook Insights shows what an hour cost.", "The 11:00 hour lost $783.", "But only 20 timed trades.", "Insights add the win rates.", "Price your own hours."],
    cap: ["Insights: what an hour cost.", "11:00 lost $783.", "Across 20 timed trades.", "Win rate, hour and overall.", "Price your own hours."],
    take: ["Insights show what an hour cost.", "The 11:00 hour lost $783.", "Across 20 timed trades.", "It adds the win rates.", "Price your own hours."],
  },
  // 16
  {
    slug: "chased-price", title: "Chased price: 10 trades, lost $630", topic: "A sample account's tagged habit with the most trades and its net result",
    assetId: INSIGHTS, expectedTopic: "mistake_tags", accent: "bad", lines: ["Chasing lost", "$630. Discipline", "made $828."],
    opening: [h("Tagged Chased price", "-$630", "bad")],
    windows: [w("Insights · tagged habits", [r("Chased price", "10 trades", "-$630", "bad"), r("Good discipline", "12 trades", "$828", "good")])],
    focus: [f(h("Chased price", "-$630", "bad"), 0, 0), f(h("Good discipline", "$828", "good"), 0, 1)],
    details: { title: "Insights · tagged habits", rows: [["Chased price · avg", "-$62.96", "bad"], ["Good discipline · avg", "$69.04", "good"], ["Trades tagged Chased", "10", "bad"]] },
    facts: ["tags.all"],
    say: ["Fillbook Insights adds up your tags.", "Chased price lost $630.", "But Good discipline made $828.", "Insights show each tag's average.", "Tag your own trades."],
    cap: ["Insights: your tags.", "Chased price: -$630.", "Good discipline: +$828.", "Average per tagged trade.", "Tag your own trades."],
    take: ["Insights add up your tags.", "Chased price lost $630.", "Good discipline made $828.", "Each tag shows its average.", "Tag your own trades."],
  },
  // 17
  {
    slug: "fomo-tag", title: "5 trades tagged FOMO entry lost $459", topic: "A sample account's tagged FOMO entries and their average result",
    assetId: INSIGHTS, expectedTopic: "mistake_tags", accent: "bad", lines: ["Tagged FOMO", "lost $459.", "Only 5 trades."],
    opening: [h("Tagged FOMO entry", "-$459", "bad")],
    windows: [w("Insights · tagged habits", [r("FOMO entry", "5 trades", "-$459", "bad"), r("Overtraded", "5 trades", "-$315", "bad")])],
    focus: [f(h("FOMO entry · 5 trades", "-$459", "bad"), 0, 0), f(h("Average per trade", "-$92", "bad"), 0, 0)],
    details: { title: "Insights · tagged habits", rows: [["Moved stop · 4 trades", "-$655.84", "bad"], ["Revenge trade · 5 trades", "-$605.08", "bad"], ["Good discipline · 12", "$828.48", "good"]] },
    facts: ["tags.all"],
    say: ["Fillbook Insights shows what a tag cost.", "Five trades tagged FOMO lost $459.", "But that is $92 per trade.", "Insights rank every tag.", "Rank your own tags."],
    cap: ["Insights: what a tag cost.", "Tagged FOMO: lost $459.", "About $92 per trade.", "Every tag, ranked.", "Rank your own tags."],
    take: ["Insights show what a tag cost.", "Tagged FOMO entries lost $459.", "About $92 per tagged trade.", "Every tag is ranked.", "Rank your own tags."],
  },
  // 18
  {
    slug: "accounts-health", title: "Two accounts: health 87 and 80", topic: "A sample accounts overview: two accounts' health scores side by side",
    assetId: ACCOUNTS, expectedTopic: "accounts_overview", accent: "good", lines: ["Health 87 here.", "Only 80", "there."],
    opening: [h("Account health", "87", "good"), h("The other account", "80", "good")],
    windows: [w("All accounts", [r("Behavior 50K", "health score", "87", "good"), r("Fixture 50K", "health score", "80", "good")])],
    focus: [f(h("Behavior 50K health", "87", "good"), 0, 0), f(h("Fixture 50K health", "80", "good"), 0, 1)],
    details: { title: "All accounts · at a glance", rows: [["Best day vs cap · one", "13% / 40%", "good"], ["Best day vs cap · other", "46% / 40%", "bad"], ["Accounts shown", "2", "good"]] },
    facts: ["accounts.overview"],
    say: ["Fillbook shows all your accounts at once.", "One account scores 87.", "The other scores 80.", "Each shows its best-day share.", "Line up your accounts."],
    cap: ["All accounts at a glance.", "One account: health 87.", "The other: health 80.", "Best-day share, each.", "Line up your accounts."],
    take: ["Fillbook shows all accounts at once.", "One account scores 87.", "The other scores 80.", "Each shows its best-day share.", "Line up your accounts."],
  },
  // 19
  {
    slug: "accounts-target", title: "Two accounts: 52% and 13% to target", topic: "A sample accounts overview: progress to the profit target on two accounts",
    assetId: ACCOUNTS, expectedTopic: "accounts_overview", accent: "bad", lines: ["52% to target", "here. Only 13%", "there."],
    opening: [h("One account", "52%", "good"), h("The other", "13%", "bad")],
    windows: [w("All accounts", [r("Behavior 50K", "to target", "52%", "good"), r("Fixture 50K", "to target", "13%", "bad")])],
    focus: [f(h("Behavior 50K", "52%", "good"), 0, 0), f(h("Fixture 50K", "13%", "bad"), 0, 1)],
    details: { title: "All accounts · at a glance", rows: [["Health · one account", "87", "good"], ["Health · other", "80", "good"], ["Accounts shown", "2", "good"]] },
    facts: ["accounts.overview"],
    say: ["Fillbook compares progress across your accounts.", "One account: 52% to target.", "But the other: 13%.", "Health scores sit beside them.", "Compare your own accounts."],
    cap: ["Accounts: progress to target.", "One account: 52%.", "The other: 13%.", "Health scores sit beside them.", "Compare your accounts."],
    take: ["Fillbook compares progress across accounts.", "One account is 52% there.", "The other is 13%.", "Health scores sit beside.", "Compare your own accounts."],
  },
  // 20
  {
    slug: "accounts-limit", title: "Two accounts: $1,100 and $1,000 left today", topic: "A sample accounts overview: today's loss limit left on two accounts",
    assetId: ACCOUNTS, expectedTopic: "accounts_overview", accent: "bad", lines: ["$1,100 left", "today here. Only", "$1,000 there."],
    opening: [h("One account", "$1,100", "good"), h("The other", "$1,000", "bad")],
    windows: [w("All accounts", [r("Behavior 50K", "limit left today", "$1,100", "good"), r("Fixture 50K", "limit left today", "$1,000", "bad")])],
    focus: [f(h("Behavior 50K limit", "$1,100", "good"), 0, 0), f(h("Fixture 50K limit", "$1,000", "bad"), 0, 1)],
    details: { title: "All accounts · buffer", rows: [["Behavior 50K · buffer", "$1,682", "good"], ["Fixture 50K · buffer", "$1,725", "good"], ["Accounts shown", "2", "good"]] },
    facts: ["accounts.overview"],
    say: ["Fillbook compares each account's daily limit.", "One has $1,100 left.", "But the other: only $1,000.", "Buffer to the floor sits beside.", "Compare your own accounts."],
    cap: ["Accounts: limit left today.", "One account: $1,100.", "The other: $1,000.", "Buffer to the floor, each.", "Compare your accounts."],
    take: ["Fillbook compares each daily limit.", "One account has $1,100 left.", "The other has $1,000.", "Buffer sits beside each.", "Compare your own accounts."],
  },
  // 21
  {
    slug: "edge-setup", title: "Your best setup: 88% win over 48 trades", topic: "A sample Your Edge report: the strongest setup",
    assetId: EDGE, expectedTopic: "edge", accent: "good", lines: ["Best setup wins", "88%. Only", "48 trades."],
    opening: [h("Strongest setup", "88%", "good")],
    windows: [w("Intelligence · Your Edge", [r("Order Block", "Retest · 48 trades", "88% win", "good"), r("Order Block", "Retest · per trade", "+0.58R", "good")])],
    focus: [f(h("Win rate", "88%", "good"), 0, 0), f(h("Per trade", "+0.58R", "good"), 0, 1)],
    details: { title: "Your Edge · confidence", rows: [["Setup confidence", "High", "good"], ["Strongest window", "Open", "good"], ["Window win rate", "71%", "good"]] },
    facts: ["edge.strongest"],
    say: ["Fillbook's Your Edge names your strongest setup.", "It wins 88%.", "But only 48 trades.", "Confidence is shown beside it.", "Find your own edge."],
    cap: ["Your Edge: strongest setup.", "Order Block Retest: 88%.", "But only 48 trades.", "Confidence shown beside it.", "Find your own edge."],
    take: ["Your Edge names the strongest setup.", "It wins 88%.", "But only 48 trades.", "Confidence is shown beside it.", "Find your own edge."],
  },
  // 22
  {
    slug: "edge-window", title: "Your best window: the open, 71% win", topic: "A sample Your Edge report: the strongest trading window",
    assetId: EDGE, expectedTopic: "edge", accent: "good", lines: ["Open: 71% win.", "But just", "+$28."],
    opening: [h("Strongest window", "71%", "good")],
    windows: [w("Intelligence · Your Edge", [r("Open", "9:30-10:30am ET", "71% win", "good"), r("Open", "106 trades", "+$28", "good")])],
    focus: [f(h("Win rate at the open", "71%", "good"), 0, 0), f(h("Trades in the window", "106", "good"), 0, 1)],
    details: { title: "Your Edge · confidence", rows: [["Window confidence", "High", "good"], ["Strongest setup", "Order Block", "good"], ["Setup win rate", "88%", "good"]] },
    facts: ["edge.strongest"],
    say: ["Fillbook finds your best trading window.", "The open wins 71%.", "But the open earns just $28.", "Your best setup sits beside it.", "Find your own window."],
    cap: ["Your Edge: best window.", "The open: 71% win.", "But the open earns just $28.", "Strongest setup beside it.", "Find your own window."],
    take: ["Your Edge names the strongest window.", "The open wins 71%.", "But the open earns just $28.", "The strongest setup sits beside.", "Find your own window."],
  },
  // 23
  {
    slug: "health-score", title: "Account health: 80 out of 100", topic: "A sample Account health score and what it checks",
    assetId: HEALTH, expectedTopic: "account_health", also: ["consistency"], accent: "good", lines: ["Account health", "80. Not 100."],
    opening: [h("Account health", "80", "good")],
    windows: [w("Dashboard · Account health", [r("Health score", "out of 100", "80", "good"), r("Checks active", "of all checks", "80%", "good")])],
    focus: [f(h("Health score", "80", "good"), 0, 0), f(h("Checks active", "80%", "good"), 0, 1)],
    details: { title: "Account health · action", rows: [["Status", "Healthy", "good"], ["One day's share", "46%", "bad"], ["Firm's cap", "40%", "good"]] },
    facts: ["health.score", "health.consistency_action"],
    say: ["Your Fillbook Account health scores your setup.", "The score is 80.", "But only 80% of checks active.", "It names your top action.", "Check your own health."],
    cap: ["Account health score.", "Health: 80 out of 100.", "80% of checks active.", "It names your top action.", "Check your own health."],
    take: ["Account health scores your setup.", "The score is 80.", "80% of checks are active.", "It names your top action.", "Check your own health."],
  },
  // 24
  {
    slug: "trailing-floor", title: "Equity $60 below the floor", topic: "A sample account that closed trades below its trailing drawdown floor",
    assetId: TRAILING, expectedTopic: "trailing_drawdown", accent: "bad", lines: ["Floor breached", "by $60.", "Health: 45."],
    opening: [h("Below the floor", "-$60", "bad")],
    windows: [w("Daily Brief · account", [r("Buffer to floor", "closed trades", "-$60", "bad"), r("Loss limit", "left today", "$1,000", "good")])],
    focus: [f(h("Buffer to the floor", "-$60", "bad"), 0, 0), f(h("Account health", "45", "bad"), 0, 1)],
    details: { title: "Account health", rows: [["Health score", "45 / 100", "bad"], ["Status", "Caution", "bad"], ["Loss limit left today", "$1,000", "good"]] },
    facts: ["dashboard.floor_breach", "dashboard.floor_buffer"],
    say: ["The Fillbook Daily Brief shows the floor.", "Equity drops below the floor.", "But health falls to 45.", "It is based on closed trades.", "Check your own floor."],
    cap: ["Daily Brief: the floor.", "Buffer: $60 below.", "Health: 45 out of 100.", "Based on closed trades.", "Check your own floor."],
    take: ["The Daily Brief shows the floor.", "The buffer is $60 below.", "Health falls to 45.", "It uses closed trades.", "Check your own floor."],
  },
  // 25
  {
    slug: "trailing-best-worst", title: "Best day $3,100, worst day -$3,060", topic: "A sample account's best and worst day on its dashboard",
    assetId: TRAILING, expectedTopic: "trailing_drawdown", accent: "bad", lines: ["Best day $3,100.", "But worst:", "-$3,060."],
    opening: [h("Best day", "$3,100", "good"), h("Worst day", "-$3,060", "bad")],
    windows: [w("Dashboard · September", [r("Best day", "1 trade", "$3,100", "good"), r("Worst day", "1 trade", "-$3,060", "bad")])],
    focus: [f(h("Best day", "$3,100", "good"), 0, 0), f(h("Worst day", "-$3,060", "bad"), 0, 1)],
    details: { title: "Dashboard · the month", rows: [["Month total", "$40.00", "good"], ["Trading days", "2", "good"], ["Avg per trading day", "$20.00", "good"]] },
    facts: ["dashboard.trailing_summary", "dashboard.best_day", "dashboard.worst_day"],
    say: ["Fillbook's dashboard lists best and worst days.", "Best day: $3,100.", "But worst day: negative $3,060.", "The month nets just $40.", "Read your own days."],
    cap: ["Dashboard: best and worst.", "Best day: $3,100.", "Worst day: -$3,060.", "The month: just $40.", "Read your own days."],
    take: ["The dashboard lists best and worst days.", "Best day is $3,100.", "Worst day is minus $3,060.", "The month nets $40.", "Read your own days."],
  },
  // 26
  {
    slug: "finalday-room", title: "98% to target with $4,940 of buffer", topic: "A sample evaluation account on its final stretch: buffer and target progress",
    assetId: FINALDAY, expectedTopic: "payout_readiness", accent: "good", lines: ["98% there.", "Still not at", "the target."],
    opening: [h("Toward the target", "98%", "good"), h("Drawdown buffer", "$4,940", "good")],
    windows: [w("Prop firm rules", [r("Profit target", "$3,000", "98%", "good"), r("Drawdown buffer", "max, $50,000 account", "$4,940", "good")])],
    focus: [f(h("Toward the target", "98%", "good"), 0, 0), f(h("Drawdown buffer", "$4,940", "good"), 0, 1)],
    details: { title: "Prop firm rules · account", rows: [["Account now", "$2,940", "good"], ["Profit target", "$3,000", "good"], ["Loss limit left today", "$1,000", "good"]] },
    facts: ["rules.finalday_target", "rules.target_progress"],
    say: ["Fillbook's rules page shows target and buffer.", "Target progress: 98%.", "But still not at target.", "Today's loss limit sits beside.", "Read your own rules page."],
    cap: ["Rules: target and buffer.", "Target progress: 98%.", "Buffer: $4,940.", "Today's limit sits beside.", "Read your rules page."],
    take: ["The rules page shows target and buffer.", "Target progress is 98%.", "The buffer is $4,940.", "Today's limit sits beside.", "Read your own rules page."],
  },
  // 27
  {
    slug: "finalday-average", title: "10 green days averaged $294", topic: "A sample account's ten green days and their daily average",
    assetId: FINALDAY, expectedTopic: "payout_readiness", accent: "good", lines: ["Green days: 10.", "Average:", "only $294."],
    opening: [h("Average trading day", "$294", "good")],
    windows: [w("Dashboard · September", [r("Green days", "of 10 days", "10", "good"), r("Avg per day", "21 trades", "$294", "good")])],
    focus: [f(h("Green days", "10", "good"), 0, 0), f(h("Average per day", "$294", "good"), 0, 1)],
    details: { title: "Dashboard · September", rows: [["Best day", "$340.00", "good"], ["Worst day", "$180.00", "good"], ["Month total", "$2,940.00", "good"]] },
    facts: ["dashboard.finalday_summary", "dashboard.green_days"],
    say: ["Your Fillbook dashboard averages each day.", "Ten green days.", "But only $294 a day.", "Best and worst day sit beside.", "Average your own days."],
    cap: ["Dashboard: daily average.", "Green days: 10.", "Average: $294 a day.", "Best and worst day.", "Average your own days."],
    take: ["The dashboard averages each day.", "Ten green days.", "Average $294 a day.", "Best and worst day sit beside.", "Average your own days."],
  },
  // 28
  {
    slug: "behavior-month", title: "13 of 19 days green, month down $185", topic: "A sample account's month: mostly green days, but a negative total",
    assetId: BEHAVIOR, expectedTopic: "overtrading", accent: "bad", lines: ["13 green days.", "Still down", "$185."],
    opening: [h("Green days", "13 of 19", "good"), h("Month total", "-$185", "bad")],
    windows: [w("September calendar", [r("Green days", "of 19 days", "13", "good"), r("Month total", "60 trades", "-$185", "bad")])],
    focus: [f(h("Green days", "13 of 19", "good"), 0, 0), f(h("Month total", "-$185", "bad"), 0, 1)],
    details: { title: "Calendar · September", rows: [["Best day", "$203.12", "good"], ["Worst day", "-$468.20", "bad"], ["Avg per trading day", "-$9.76", "bad"]] },
    facts: ["calendar.month_overview"],
    say: ["Your Fillbook calendar shows the whole month.", "Thirteen of nineteen days green.", "But the month is down $185.", "Best, worst and average day, listed.", "Read your own month."],
    cap: ["Calendar: the month.", "13 of 19 days green.", "Yet the month: -$185.", "Best, worst, average day.", "Read your own month."],
    take: ["The calendar shows the month.", "13 of 19 days are green.", "The month is down $185.", "Best, worst and average day.", "Read your own month."],
  },
  // 29
  {
    slug: "behavior-red-day", title: "One day: lost $465 in 6 trades", topic: "A sample account's one red day among mostly green ones",
    assetId: BEHAVIOR, expectedTopic: "overtrading", accent: "bad", lines: ["One day lost", "$465. Only", "6 trades."],
    opening: [h("Day 25", "-$465", "bad")],
    windows: [w("September calendar", [r("Day 25", "6 trades", "-$465", "bad"), r("Win rate", "that day", "17%", "bad")])],
    focus: [f(h("Day 25", "-$465", "bad"), 0, 0), f(h("Win rate that day", "17%", "bad"), 0, 1)],
    details: { title: "Calendar · September", rows: [["Best day", "$203.12", "good"], ["Green days", "13 of 19", "good"], ["Month total", "-$185.44", "bad"]] },
    facts: ["calendar.month_overview"],
    say: ["Fillbook's calendar singles out the red day.", "Day 25 lost $465.", "But in only six trades.", "Only 17% of them won.", "Find your own red day."],
    cap: ["Calendar: the red day.", "Day 25: lost $465.", "Six trades that day.", "Win rate: 17%.", "Find your own red day."],
    take: ["The calendar singles out the red day.", "Day 25 lost $465.", "But in only six trades.", "Only 17% won.", "Find your own red day."],
  },
  // 30
  {
    slug: "pace-up", title: "6 trades after a streak: pace up 126%", topic: "A sample Daily Brief watch item: trade frequency against the account's own pace",
    assetId: BEHAVIOR, expectedTopic: "overtrading", accent: "bad", lines: ["Pace up 126%.", "Not your", "usual 2.7."],
    opening: [h("Frequency up", "126%", "bad")],
    windows: [w("Daily Brief · watch item", [r("Last session", "after a losing streak", "6", "bad"), r("Your normal pace", "trades a day", "2.7", "good")])],
    focus: [f(h("Trades last session", "6", "bad"), 0, 0), f(h("Your normal pace", "2.7", "good"), 0, 1)],
    details: { title: "Daily Brief · account", rows: [["Buffer to the floor", "$1,682", "good"], ["Loss limit left today", "$1,100", "good"], ["Window win rate", "71%", "good"]] },
    facts: ["dashboard.overtrading_watch"],
    say: ["The Fillbook Daily Brief compares your pace.", "Six trades last session.", "But your normal is 2.7.", "Buffer and limit sit beside it.", "Compare your own pace."],
    cap: ["Daily Brief: your pace.", "Last session: 6 trades.", "Your normal: 2.7 a day.", "Buffer and limit beside it.", "Compare your own pace."],
    take: ["The Daily Brief compares your pace.", "Six trades last session.", "Your normal pace is 2.7.", "Buffer and limit sit beside it.", "Compare your own pace."],
  },
];

/**
 * Day 1 to day 30. Never two concepts about the same recording back to back, and a recording's concepts are spread across
 * the month (the six Insights concepts fall on days 3, 8, 14, 20, 25 and 29). A concept's id carries its day number.
 */
const DAY_ORDER = [
  "brief-room", "orb-setup", "busy-day", "accounts-target", "size-over-plan", "behavior-red-day", "payout-pace", "weak-hour", "edge-setup", "trailing-best-worst",
  "plan-adherence", "target-progress", "finalday-room", "chased-price", "brief-last-session", "accounts-health", "one-setup-cost", "health-score", "behavior-month", "busy-day-cost",
  "payout-days-logged", "edge-window", "net-pnl-wins", "trailing-floor", "fomo-tag", "finalday-average", "accounts-limit", "brief-strong-window", "weak-hour-cost", "pace-up",
];
if (new Set(DAY_ORDER).size !== CONCEPTS.length || DAY_ORDER.length !== CONCEPTS.length || CONCEPTS.some((c) => !DAY_ORDER.includes(c.slug))) {
  throw new Error("dailyConcepts: DAY_ORDER must list every concept exactly once.");
}

/** The 30 plans, in request order: day 1 first. */
export const DAILY_PILOTS: ScenePlan[] = DAY_ORDER.map((slug, i) => build(i + 1, CONCEPTS.find((c) => c.slug === slug)!));
export const DAILY_CONCEPT_ORDER: string[] = DAILY_PILOTS.map((p) => p.planId);
