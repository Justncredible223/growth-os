import { build, f, h, r, w, type Daily } from "./dailyConcepts.js";
import type { ScenePlan } from "./types.js";

/**
 * The fresh, hook-first pool (owner decision, 2026-10-07). The first 30 concepts (dailyConcepts.ts) all open on "what the screen is",
 * and the old pool averaged about 100 TikTok views with 1.9-4.1 s average watch and most viewers gone by 0:01. These nine open on the
 * viewer's pain or a striking number in the FIRST beat, the screen is the proof, and the last beat is a question that invites
 * comments rather than a pitch:
 *
 *   1 the HOOK (a number or a pain, said in the first two seconds)   2 the first figure   3 the "but" (a second figure that turns it)
 *   4 what Fillbook shows (the one product line)                    5 a question
 *
 * Same rules as every product mock: each concept is drawn from a verified recording's facts only (nothing here is invented), is
 * labelled Demo data on every beat, keeps each spoken line to 7 words, says whole dollars, and clears the A/A+ render bar. Hooks never say
 * the viewer personally did something: they describe what the demo account's screen shows, or ask the viewer a question.
 *
 * Hooks that could not be said as the owner first phrased them (kept truthful instead):
 *   - "Your best day might fail your payout"  -> the recording only shows one day at 46% of profit against a 40% cap; it says nothing about a payout result.
 *   - "Your favorite setup is your costliest" -> the recording does not say the setup is a favourite, only 8 trades at 25% win, -$422.
 *   - "Your own rules cost nothing to break"   -> the recording shows the opposite (off-plan trades average -$39 against +$21 inside); the hook is that nobody fines you, the numbers do.
 *   - "The moment your account is over"        -> the recording says the floor is breached and "most firms close an account at this point"; it does not say the account is closed.
 *
 * TODO (not built, needs a recording that does not exist yet): a tenth concept about setting your own limits when you trade your own capital.
 */
const BRIEF = "rec.p7-daily-brief.v1";
const SETUPS = "rec.p1-reports-setup-breakdown.v2";
const SIZE = "rec.p3-trades-orb-size.v2";
const HEALTH = "rec.p4-account-health-consistency.v1";
const TRAILING = "rec.hs-trailing-account.v1";
const INSIGHTS = "rec.b3-insights-behavior.v1";
const TIMING = "rec.b3-reports-timing-conviction.v1";
const PLANVS = "rec.b3-plan-vs-reality.v1";
const PROGRESS = "rec.b3-progress.v1";

const FRESH: Daily[] = [
  // 01
  {
    slug: "two-limits", title: "Two limits. The smaller one decides.", topic: "A sample account's Daily Brief: the buffer to the drawdown floor against today's loss limit",
    assetId: BRIEF, expectedTopic: "daily_brief", accent: "bad", lines: ["$1,725 and $1,000.", "Only the smaller", "one decides."],
    opening: [h("Buffer to the floor", "$1,725", "good"), h("Today's loss limit", "$1,000", "bad")],
    windows: [w("Daily Brief", [r("Buffer", "to the floor", "$1,725", "good"), r("Loss limit", "left today", "$1,000", "bad")])],
    focus: [f(h("Buffer to the floor", "$1,725", "good"), 0, 0), f(h("Today's loss limit", "$1,000", "bad"), 0, 1)],
    details: { title: "Daily Brief · the rest", rows: [["Last session · 1 trade", "-$17", "bad"], ["Strongest window", "Open", "good"], ["Open · 22 trades", "64% win", "good"]] },
    facts: ["brief.account", "brief.buffer", "brief.loss_limit", "brief.last_session", "brief.window"],
    say: ["Two limits. The smaller one decides.", "One is $1,725 of buffer.", "But today's loss limit is $1,000.", "Fillbook's Daily Brief shows both.", "Which limit would you hit first?"],
    cap: ["Daily Brief: two limits.", "Buffer to the floor: $1,725.", "Today's loss limit: $1,000.", "Daily Brief shows both.", "Which would you hit first?"],
    take: ["Two limits, and one decides.", "The buffer to the floor.", "The loss limit left today.", "The brief shows both.", "Which limit comes first?"],
  },
  // 02
  {
    slug: "plan-said-3", title: "The plan said 3. The trade was 5.", topic: "A sample trade log: a trade larger than the trading plan's maximum contracts",
    assetId: SIZE, expectedTopic: "trade_size", accent: "bad", lines: ["Plan said 3.", "But the trade", "was 5."],
    opening: [h("Plan maximum", "3", "good"), h("Contracts traded", "5", "bad")],
    windows: [w("Trades", [r("MNQ Short", "5 contracts", "-$257", "bad"), r("Plan limit", "max contracts", "3", "good")])],
    focus: [f(h("Contracts traded", "5", "bad"), 0, 0), f(h("The plan's limit", "3", "good"), 0, 1)],
    details: { title: "Trading plan", rows: [["Max contracts per trade", "3", "good"], ["Last Opening Range trade", "5", "bad"], ["Result", "-$257.40", "bad"]] },
    facts: ["trade.orb_qty5_most_recent", "plan.max_contracts"],
    say: ["Plan said 3. The trade was 5.", "An Opening Range trade used 5.", "But the plan's maximum is 3.", "Fillbook's trade log shows the result.", "Does your size match your plan?"],
    cap: ["Trades: size vs plan.", "This trade: 5 contracts.", "The plan's limit: 3.", "The log shows the result.", "Does size match your plan?"],
    take: ["The plan said 3, the trade was 5.", "The trade used 5 contracts.", "The plan's limit is 3.", "The result sits beside it.", "Does your size match your plan?"],
  },
  // 03
  {
    slug: "one-day-46", title: "One day made 46% of the profit", topic: "A sample account's Account Health: one day against the firm's consistency cap",
    assetId: HEALTH, expectedTopic: "consistency", also: ["account_health"], accent: "bad", lines: ["46% from one day.", "Firm limit: only 40%."],
    opening: [h("One day's share of profit", "46%", "bad"), h("Firm's consistency cap", "40%", "good")],
    windows: [w("Account health", [r("Best day", "share of total profit", "46%", "bad"), r("Consistency cap", "the firm's", "40%", "good")])],
    focus: [f(h("One day · share of profit", "46%", "bad"), 0, 0), f(h("The firm's cap", "40%", "good"), 0, 1)],
    details: { title: "Account health", rows: [["Score", "80/100", "good"], ["Status", "Healthy", "good"], ["Most important action", "Consistency", "bad"]] },
    facts: ["health.consistency_action", "health.score"],
    say: ["One day made 46% of the profit.", "The firm's consistency cap is 40%.", "So that day is over the cap.", "Fillbook flags it in Account Health.", "Is your best day too big?"],
    cap: ["Account Health: one day.", "One day: 46% of profit.", "The firm's cap: 40%.", "Account Health flags it.", "Is your best day too big?"],
    take: ["One day made 46% of the profit.", "The firm's cap is 40%.", "That day is over the cap.", "Account Health flags it.", "Is your best day too big?"],
  },
  // 04
  {
    slug: "setup-lost-422", title: "One setup: 8 trades, lost $422", topic: "A sample account's setup report: what its weakest setup cost",
    assetId: SETUPS, expectedTopic: "setup_breakdown", also: ["month_total"], accent: "bad", lines: ["One setup: 8 trades.", "Lost $422."],
    opening: [h("One setup · 8 trades", "-$422", "bad")],
    windows: [w("Reports · by setup", [r("Opening Range", "8 trades", "25% win", "bad"), r("All trades", "22 trades", "64% win", "good")])],
    focus: [f(h("Opening Range Break", "-$422", "bad"), 0, 0), f(h("Every trade · win rate", "64%", "good"), 0, 1)],
    details: { title: "Reports · overview", rows: [["Net P&L", "$387.08", "good"], ["Win rate", "64%", "good"], ["Total trades", "22", "good"]] },
    facts: ["setup.opening_range_break_result", "month.net_pnl"],
    say: ["One setup. Eight trades. Lost $422.", "It won just 25% of them.", "But all trades won 64%.", "Fillbook's Reports rank setups, worst first.", "Which setup is costing you most?"],
    cap: ["Reports: one setup.", "Opening Range: 25% win.", "All trades: 64% win.", "Reports rank setups.", "Which setup costs you most?"],
    take: ["One setup lost $422 in 8 trades.", "It won just 25%.", "All trades won 64%.", "Reports rank setups, worst first.", "Which setup costs you most?"],
  },
  // 05
  {
    slug: "below-the-floor", title: "$60 below the floor", topic: "A sample trailing-drawdown account whose equity is below the floor, shown in the Daily Brief and Account Health",
    assetId: TRAILING, expectedTopic: "trailing_drawdown", accent: "bad", lines: ["Floor breached.", "$60 below it."],
    opening: [h("Buffer to the floor", "-$60", "bad")],
    windows: [w("Daily Brief", [r("Buffer", "to the floor", "-$60", "bad"), r("Loss limit", "left today", "$1,000", "good")]), w("Account health", [r("Score", "out of 100", "45/100", "bad"), r("Status", "most important", "CAUTION", "bad")])],
    focus: [f(h("Buffer to the floor", "-$60", "bad"), 0, 0), f(h("Account Health", "45/100", "bad"), 1, 0)],
    details: { title: "Daily Brief · the message", rows: [["Equity", "Below floor", "bad"], ["Most firms", "Close it", "bad"], ["Account Health", "CAUTION", "bad"]] },
    facts: ["dashboard.floor_breach", "dashboard.floor_buffer", "dashboard.below_floor"],
    say: ["The floor is breached. $60 below.", "Below it, most firms close the account.", "Yet Account Health reads 45 of 100.", "Fillbook flags the breach on screen.", "Would you spot this in time?"],
    cap: ["Daily Brief: floor breached.", "$60 below the floor.", "Account Health: 45/100.", "The breach is flagged.", "Would you spot this in time?"],
    take: ["The floor is breached.", "Most firms close the account there.", "Account Health reads 45 of 100.", "The breach shows on screen.", "Would you spot this in time?"],
  },
  // 06
  {
    slug: "five-revenge", title: "5 possible revenge trades, flagged", topic: "A sample account's Insights: possible revenge trades opened minutes after a loss and sized up",
    assetId: INSIGHTS, expectedTopic: "revenge_trading", accent: "bad", lines: ["5 possible revenge trades.", "Each followed a loss."],
    opening: [h("Possible revenge trades", "5", "bad")],
    windows: [w("Insights · behavior", [r("Possible revenge", "flagged trades", "5", "bad"), r("After a loss", "minutes later", "3-12 min", "bad"), r("Size vs average", "each trade", "1.5x-2.5x", "bad")])],
    focus: [f(h("Possible revenge trades", "5", "bad"), 0, 0), f(h("Size vs your average", "1.5x-2.5x", "bad"), 0, 2)],
    details: { title: "Insights · one trade", rows: [["MNQ opened after", "3 min", "bad"], ["After losing", "$127", "bad"], ["Sized", "2.5x average", "bad"]] },
    facts: ["behavior.revenge"],
    say: ["Five possible revenge trades, flagged.", "Each opened minutes after a loss.", "But sizes ran 1.5x to 2.5x average.", "Fillbook's Insights flag them for review.", "Do you trade right after a loss?"],
    cap: ["Insights: possible revenge.", "Opened minutes after a loss.", "Sized 1.5x to 2.5x.", "Insights flag them.", "Trade right after a loss?"],
    take: ["Five possible revenge trades.", "Each followed a loss.", "Each was sized up.", "Insights flag them for review.", "Do you trade after a loss?"],
  },
  // 07
  {
    slug: "take-it-again", title: "Would you take it again? 84% against 18%", topic: "A sample account's Reports: results split by whether the trader would take the trade again",
    assetId: TIMING, expectedTopic: "conviction", accent: "bad", lines: ["Would retake: 84% win.", "Would not: only 18%."],
    opening: [h("Would take again", "84%", "good"), h("Would not", "18%", "bad")],
    windows: [w("Reports · by conviction", [r("Would retake", "75 trades", "84% win", "good"), r("Wouldn't retake", "34 trades", "18% win", "bad")])],
    focus: [f(h("Would retake · win rate", "84%", "good"), 0, 0), f(h("Wouldn't · win rate", "18%", "bad"), 0, 1)],
    details: { title: "Reports · by conviction", rows: [["Would take again", "+0.51R avg", "good"], ["Wouldn't take again", "-0.65R avg", "bad"], ["Answered trades", "131", "good"]] },
    facts: ["conviction.all"],
    say: ["Would you take it again?", "Trades marked yes won 84%.", "But trades marked no won only 18%.", "Fillbook's Reports split trades by that answer.", "Would you take your last trade again?"],
    cap: ["Reports: take it again?", "Marked yes: 84% win.", "Marked no: 18% win.", "Reports split by that answer.", "Take your last trade again?"],
    take: ["Would you take it again?", "Trades marked yes won 84%.", "Trades marked no won 18%.", "Reports split trades by that answer.", "Would you take your last trade again?"],
  },
  // 08
  {
    slug: "nobody-fines", title: "Nobody fines you for off-plan trades", topic: "A sample account's Plan vs reality: trades outside the planned session against inside it, for a self-funded trader",
    assetId: PLANVS, expectedTopic: "plan_adherence", accent: "bad", lines: ["Outside the plan: lost $39.", "Inside: made $21."],
    opening: [h("Outside the window", "-$39", "bad"), h("Inside the window", "$21", "good")],
    windows: [w("Plan · next session", [r("Outside window", "20 trades · average", "-$39", "bad"), r("Inside window", "average per trade", "$21", "good")])],
    focus: [f(h("Outside · average", "-$39", "bad"), 0, 0), f(h("Inside · average", "$21", "good"), 0, 1)],
    details: { title: "Plan vs reality", rows: [["Overall adherence", "92%", "good"], ["Trading window", "85% slipping", "bad"], ["Timed trades in window", "111 of 131", "bad"]] },
    facts: ["plan.focus", "plan.adherence"],
    say: ["No one fines you for off-plan trades.", "Twenty trades fell outside 9:30 to 11:30.", "But they lost $39. Inside: made $21.", "Fillbook's Plan page compares both.", "Who holds you to your plan?"],
    cap: ["Plan vs reality.", "20 trades outside the window.", "Outside: -$39. Inside: $21.", "Plan compares both.", "Who holds you to your plan?"],
    take: ["No one fines you for off-plan trades.", "Twenty trades fell outside the window.", "They averaged a loss of $39.", "The Plan page compares both.", "Who holds you to your plan?"],
  },
  // 09
  {
    slug: "win-rate-fell", title: "The win rate fell 21 points", topic: "A sample account's Progress: win rate baseline against recent, and the behavior rates beside it",
    assetId: PROGRESS, expectedTopic: "progress", accent: "bad", lines: ["76% down to 55%.", "What changed?"],
    opening: [h("Win rate · baseline", "76%", "good"), h("Win rate · recent", "55%", "bad")],
    windows: [w("Progress · win rate", [r("Baseline", "win rate", "76%", "good"), r("Recent", "win rate", "55%", "bad")]), w("Progress · behavior", [r("Revenge rate", "baseline to recent", "0% to 6%", "bad"), r("Overtrading days", "baseline to recent", "0% to 17%", "bad")])],
    focus: [f(h("Win rate · down 21 points", "55%", "bad"), 0, 1), f(h("Flagged revenge-trade rate", "6%", "bad"), 1, 0)],
    details: { title: "Progress · the rest", rows: [["Win rate · baseline", "76%", "good"], ["Overtrading days", "17%", "bad"], ["Revenge rate", "6%", "bad"]] },
    facts: ["progress.win_rate", "progress.behavior"],
    say: ["This win rate fell 21 points.", "Baseline 76%, recent 55%.", "But flagged revenge trades rose to 6%.", "Fillbook's Progress compares baseline against recent.", "What changed in your recent trading?"],
    cap: ["Progress: win rate.", "76% down to 55%.", "Flagged revenge: 0% to 6%.", "Progress: baseline vs recent.", "What changed recently?"],
    take: ["The win rate fell 21 points.", "From 76% to 55%.", "Flagged revenge trades rose to 6%.", "Progress compares baseline and recent.", "What changed in your trading?"],
  },
];

/** The offered pool, in request order: fresh-01 first. */
export const FRESH_PILOTS: ScenePlan[] = FRESH.map((c, i) => build(i + 1, c, "fresh"));
export const FRESH_CONCEPT_ORDER: string[] = FRESH_PILOTS.map((p) => p.planId);
