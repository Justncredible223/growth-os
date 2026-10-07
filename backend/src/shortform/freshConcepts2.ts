import { build, f, h, r, w, type Daily } from "./dailyConcepts.js";
import type { ScenePlan } from "./types.js";

/**
 * The second batch of fresh hook-first concepts (2026-10-07): 21 more, so the 9 of freshConcepts.ts and these 21 make the 30 distinct days
 * of the offered pool. Same shape, same guards and same checks as freshConcepts.ts: the Daily/build() path with hookFirst, five beats (the
 * hook, the first figure, the "but", what Fillbook shows, a question), every figure taken from a fact in
 * scripts/video-factory/assets/verified-manifest.json, seven words or fewer per spoken line, whole dollars, flags framed as flags, and the
 * A/A+ render bar.
 *
 * Every concept here draws on ONE recording. A concept drawn on an older ui.* capture carries that capture's own label, "EXAMPLE DATA", on
 * the slide and as the disclosure; one drawn on a rec.* recording says "Demo data".
 *
 * THE 30-DAY REQUEST ORDER (the ordered list itself is OFFERED_DAILY_CONCEPT_IDS in motionPlans.ts). Lane: P = prop-firm rule pain,
 * O = "own money, own rules" discipline (no firm sets the limit). Never more than two of one lane in a row; never the same recording twice in
 * a row; the strongest, most universal hooks sit in days 1-10; a comment-bait question closes every concept. The separate recording-variants
 * PR (fresh-02b, fresh-04b, fresh-06b) replaces the card versions fresh-02, fresh-04 and fresh-06 in place (days 2, 21 and 1), so it adds no day.
 *
 *    day  id                                 lane  recording
 *    1   fresh-06-five-revenge              P    rec.b3-insights-behavior
 *    2   fresh-02-plan-said-3               P    rec.p3-trades-orb-size
 *    3   fresh-07-take-it-again             O    rec.b3-reports-timing-conviction
 *    4   fresh-01-two-limits                P    rec.p7-daily-brief
 *    5   fresh-12-one-red-day               P    rec.hs-payout-account
 *    6   fresh-19-biggest-leak              O    ui.intelligence-overview
 *    7   fresh-10-eight-contracts           P    ui.trade-log-flags
 *    8   fresh-14-won-then-lost             P    rec.hs-trailing-account
 *    9   fresh-08-nobody-fines              O    rec.b3-plan-vs-reality
 *   10   fresh-11-two-accounts-one-trade    P    rec.hs-multi-account-a
 *   11   fresh-03-one-day-46                P    rec.p4-account-health-consistency
 *   12   fresh-20-moved-stop                O    rec.b3-insights-behavior
 *   13   fresh-15-open-vs-late-morning      P    rec.b3-reports-timing-conviction
 *   14   fresh-09-win-rate-fell             O    rec.b3-progress
 *   15   fresh-17-690-left                  P    ui.drawdown-bars
 *   16   fresh-18-one-day-1788              P    ui.calendar-earlier
 *   17   fresh-21-edge-score-67             O    rec.p6-edge-score
 *   18   fresh-16-six-vs-norm               P    rec.hs-behavior-account
 *   19   fresh-28-weak-hour                 P    rec.b3-insights-behavior
 *   20   fresh-22-only-monday-lost          O    rec.p8-day-of-week
 *   21   fresh-04-setup-lost-422            P    rec.p1-reports-setup-breakdown
 *   22   fresh-30-84-percent                P    rec.hs-payout-account
 *   23   fresh-29-24-wins-14-losses         O    ui.month-overview-setups
 *   24   fresh-23-52-vs-13                  P    rec.b3-accounts-overview
 *   25   fresh-13-129-days                  P    rec.p9-payout-timeline
 *   26   fresh-24-92-on-plan                O    rec.b3-plan-vs-reality
 *   27   fresh-26-98-percent                P    rec.hs-finalday-account
 *   28   fresh-05-below-the-floor           P    rec.hs-trailing-account
 *   29   fresh-25-overtrading-days-17       O    rec.b3-progress
 *   30   fresh-27-48-trades-88              O    rec.b3-your-edge
 *
 * Facts left unused, and why:
 *   - Payout requests ("payout requested, $4,000" on rec.hs-payout-account): no video says or implies a payout, so nothing leans on it.
 *   - Rule simulator ("No active breach - evaluation incomplete. This is not a pass"): true, but it carries no figure, so it cannot open on a
 *     number and does not clear the A bar honestly. Not built.
 *   - The personal-capital limit-setting screen has no recording, so no concept is made from it.
 *   - Derived arithmetic (a difference or a ratio the screen does not itself show) is never spoken; a figure is a figure the recording shows.
 *   - Left for later (the figures are the same ideas as concepts above): ui.setup-breakdown (Opening Range Break, 2 trades, -$1,030; same idea as
 *     fresh-04), the 9-contract -$630 and ES -$279 trades on ui.trade-log-flags (same recording as fresh-10), rec.hs-multi-account-b (same trade as fresh-11).
 */
const FLAGS = "ui.trade-log-flags.v1";
const DRAWDOWN = "ui.drawdown-bars.v1";
const INTEL = "ui.intelligence-overview.v1";
const CALENDAR = "ui.calendar-earlier.v1";
const PAYACCT = "rec.hs-payout-account.v1";
const TRAILING = "rec.hs-trailing-account.v1";
const MULTI_A = "rec.hs-multi-account-a.v1";
const PAYOUT = "rec.p9-payout-timeline.v1";
const TIMING = "rec.b3-reports-timing-conviction.v1";
const BEHAVIOR = "rec.hs-behavior-account.v1";
const ACCOUNTS = "rec.b3-accounts-overview.v1";
const FINALDAY = "rec.hs-finalday-account.v1";
const INSIGHTS = "rec.b3-insights-behavior.v1";
const EDGE_SCORE = "rec.p6-edge-score.v1";
const DOW = "rec.p8-day-of-week.v1";
const PLANVS = "rec.b3-plan-vs-reality.v1";
const PROGRESS = "rec.b3-progress.v1";
const YOUR_EDGE = "rec.b3-your-edge.v1";
const MONTH = "ui.month-overview-setups.v1";
const EXAMPLE = "EXAMPLE DATA";

const FRESH2: Daily[] = [
  // 10
  {
    slug: "eight-contracts", title: "One trade. 8 contracts. Lost $400.", topic: "A sample trade log: one 8-contract loss carrying two flags",
    assetId: FLAGS, expectedTopic: "behavior_flags", also: ["trade_log", "trade_size"], accent: "bad", dataLabel: EXAMPLE, lines: ["One trade. 8 contracts.", "Lost $400."],
    opening: [h("Contracts on one trade", "8", "bad"), h("Trade result", "-$400", "bad")],
    windows: [w("Trade log · MNQ Short", [r("Opening Range", "8 contracts", "-$400", "bad"), r("Tagged", "revenge, oversized", "Flagged", "bad")])],
    focus: [f(h("Contracts · one trade", "8", "bad"), 0, 0), f(h("Also tagged", "Oversized", "bad"), 0, 1)],
    details: { title: "Trade log · the rest", rows: [["Contracts", "8", "bad"], ["Result · dollars", "-$400", "bad"], ["Result · in R", "-1.25R", "bad"], ["Tags", "Flagged", "bad"]] },
    facts: ["trade.orb_mnq_8x_flagged", "flag.revenge_and_oversized_tags"],
    say: ["One trade. 8 contracts. Lost $400.", "An Opening Range Break on MNQ.", "But it was tagged revenge and oversized.", "Fillbook's trade log shows those tags.", "Which of your trades gets tagged?"],
    cap: ["Trade log: 8 contracts.", "MNQ Short, Opening Range.", "Tagged: revenge, oversized.", "The trade log shows the tags.", "Which trade gets tagged?"],
    take: ["One trade lost $400.", "An Opening Range Break on MNQ.", "It was tagged revenge and oversized.", "The trade log shows the tags.", "Which of your trades gets tagged?"],
  },
  // 11
  {
    slug: "two-accounts-one-trade", title: "Same trade. Two accounts. Each lost $1,201.", topic: "Two sample accounts that took the same 5-contract trade on the same day",
    assetId: MULTI_A, expectedTopic: "accounts_overview", accent: "bad", lines: ["Same trade.", "Two accounts.", "Each lost $1,201."],
    opening: [h("Day 25 · the red day", "-$1,201", "bad")],
    windows: [w("Calendar · September", [r("Day 25", "1 trade · 0% win", "-$1,201", "bad"), r("Contracts", "that one trade", "5", "bad"), r("Tagged", "Opening Range Break", "Oversized", "bad"), r("Green days", "of 4 days", "2/4", "good")])],
    focus: [f(h("Contracts on that trade", "5", "bad"), 0, 1), f(h("Tagged on both", "Oversized", "bad"), 0, 2)],
    details: { title: "Calendar · the month", rows: [["Month total", "-$1,076", "bad"], ["Days · trades", "4 · 4", "bad"], ["Best day", "$100", "good"], ["Green days", "2/4", "bad"]] },
    facts: ["dashboard.multi_a_summary", "dashboard.multi_a_worst_day", "dashboard.multi_a_red_day"],
    say: ["Same trade, two accounts. Each lost $1,201.", "The trade was 5 contracts.", "But it was tagged oversized on both.", "Fillbook's calendar shows each red day.", "Do you copy trades across accounts?"],
    cap: ["Same trade, two accounts.", "That trade: 5 contracts.", "Tagged oversized on both.", "Calendar shows each red day.", "Copy trades across accounts?"],
    take: ["The same trade ran on two accounts.", "It was 5 contracts.", "It was tagged oversized on both.", "The calendar shows each red day.", "Do you copy trades across accounts?"],
  },
  // 12
  {
    slug: "one-red-day", title: "17 green days. One red day lost $1,504.", topic: "A sample account's September calendar: one red day among 17 green ones",
    assetId: PAYACCT, expectedTopic: "payout_readiness", also: ["calendar"], accent: "bad", lines: ["17 green days.", "One red day lost $1,504."],
    opening: [h("Green days · September", "17/18", "good"), h("The one red day", "-$1,504", "bad")],
    windows: [
      w("Calendar · September", [r("Day 25", "2 trades · 0% win", "-$1,504", "bad"), r("Green days", "of 18 days", "17/18", "good")]),
      w("Calendar · the month", [r("Month total", "18 days · 19 trades", "$6,996", "good"), r("Best day", "one day", "$610", "good")]),
    ],
    focus: [f(h("The one red day", "-$1,504", "bad"), 0, 0), f(h("Month total", "$6,996", "good"), 1, 0)],
    details: { title: "Calendar · the rest", rows: [["Best day", "$610", "good"], ["Average per trading day", "$389", "good"], ["Days · trades", "18 · 19", "good"]] },
    facts: ["calendar.overview", "calendar.green_days", "calendar.worst_day"],
    say: ["17 green days. One red day.", "Two trades lost $1,504 that day.", "But the month still made $6,996.", "Fillbook's September calendar shows every day.", "How big is your worst day?"],
    cap: ["Calendar: one red day.", "Day 25: 2 trades, -$1,504.", "Month total: $6,996.", "The calendar shows every day.", "How big is your worst day?"],
    take: ["17 days were green.", "One red day lost $1,504.", "The month still made $6,996.", "The calendar shows every day.", "How big is your worst day?"],
  },
  // 13
  {
    slug: "129-days", title: "Still 129 trading days to go", topic: "A sample account's readiness timeline: days to go at the current daily pace",
    assetId: PAYOUT, expectedTopic: "payouts", accent: "bad", lines: ["$20 a day pace.", "Still 129 days to go."],
    opening: [h("Trading days to go", "129", "bad"), h("Current pace · per day", "$20", "good")],
    windows: [
      w("Readiness · timeline", [r("To go", "trading days", "129", "bad"), r("Current pace", "per trading day", "$20", "good")]),
      w("Readiness · the rules", [r("Minimum days", "19 logged · 10 minimum", "Met", "good"), r("Profit target", "$387 of $3,000", "13%", "bad"), r("Consistency", "best day vs 40% cap", "46%", "bad")]),
    ],
    focus: [f(h("Trading days to go", "129", "bad"), 0, 0), f(h("Trading days logged", "19", "good"), 1, 0)],
    details: { title: "Readiness · the rest", rows: [["Rule breach", "None active", "good"], ["Left to the target", "$2,613", "bad"], ["Minimum trading days", "10", "good"]] },
    facts: ["payout.timeline", "payout.readiness"],
    say: ["129 more days at $20 a day.", "A projection at the current pace.", "But it already logged 19 trading days.", "Fillbook's readiness page checks each rule.", "How many days would your account show?"],
    cap: ["Readiness: days to go.", "129 days at $20 a day.", "19 trading days logged.", "Readiness page checks rules.", "How many days for you?"],
    take: ["129 more trading days at $20 a day.", "A projection at the current pace.", "It already logged 19 trading days.", "The readiness page checks each rule.", "How many days would your account show?"],
  },
  // 14
  {
    slug: "won-then-lost", title: "Won $3,100. Then lost $3,060.", topic: "A sample account's calendar: a $3,100 day and a $3,060 loss two trades apart",
    assetId: TRAILING, expectedTopic: "trailing_drawdown", accent: "bad", lines: ["Won $3,100.", "Then lost $3,060."],
    opening: [h("Best day · Sep 21", "$3,100", "good"), h("Worst day · Sep 25", "-$3,060", "bad")],
    windows: [
      w("Calendar · September", [r("Sep 21", "1 trade · 100% win", "$3,100", "good"), r("Sep 25", "1 trade · 0% win", "-$3,060", "bad")]),
      w("Calendar · the month", [r("Month total", "2 days · 2 trades", "$40", "bad"), r("Green days", "of 2 days", "1/2", "bad")]),
    ],
    focus: [f(h("Best day · 1 trade", "$3,100", "good"), 0, 0), f(h("Month total", "$40", "bad"), 1, 0)],
    details: { title: "Calendar · the rest", rows: [["Average per trading day", "$20", "good"], ["Days · trades", "2 · 2", "good"], ["Green days", "1/2", "bad"]] },
    facts: ["dashboard.trailing_summary", "dashboard.best_day", "dashboard.worst_day"],
    say: ["Won $3,100. Then lost $3,060.", "One trade each day.", "But the month nets just $40.", "Fillbook's calendar shows both days.", "Could one trade undo your month?"],
    cap: ["Calendar: two days.", "Won $3,100, then -$3,060.", "Month total: $40.", "The calendar shows both days.", "One trade undo your month?"],
    take: ["Won $3,100, then lost $3,060.", "One trade each day.", "The month nets just $40.", "The calendar shows both days.", "Could one trade undo your month?"],
  },
  // 15
  {
    slug: "open-vs-late-morning", title: "Open wins 71%. Late morning, only 24%.", topic: "A sample account's Reports by time of day: the open against late morning",
    assetId: TIMING, expectedTopic: "time_of_day", accent: "bad", lines: ["Open: 71% win.", "Late morning: only 24%."],
    opening: [h("Open · win rate", "71%", "good"), h("Late morning · win rate", "24%", "bad")],
    windows: [w("Reports · time of day", [r("Open", "9:30-10:30am · 106 trades", "$2,968", "good"), r("Late morning", "10:30am-12pm · 25 trades", "-$1,406", "bad")])],
    focus: [f(h("Open · 106 trades", "$2,968", "good"), 0, 0), f(h("Late morning · 25 trades", "-$1,406", "bad"), 0, 1)],
    details: { title: "Reports · time of day", rows: [["Open · hours", "9:30-10:30am", "good"], ["Late morning · hours", "10:30am-12pm", "bad"], ["Open · trades", "106", "good"]] },
    facts: ["timing.buckets"],
    say: ["Open wins 71%. Late morning, only 24%.", "Open: 106 trades made $2,968.", "But late morning lost $1,406.", "Fillbook's Reports sort trades by time.", "What time of day costs you?"],
    cap: ["Reports: time of day.", "Open: 106 trades, $2,968.", "Late morning: 25 trades.", "Reports sort trades by time.", "What time of day costs you?"],
    take: ["Open wins 71%.", "Open made $2,968 in 106 trades.", "Late morning lost $1,406.", "Reports sort trades by time.", "What time of day costs you?"],
  },
  // 16
  {
    slug: "six-vs-norm", title: "Normal: 2.7 trades. Last session: 6.", topic: "A sample account's Daily Brief: a session with more trades than the account's own normal pace",
    assetId: BEHAVIOR, expectedTopic: "overtrading", also: ["weak_hour"], accent: "bad", lines: ["Normal pace: 2.7 trades.", "But last session: 6."],
    opening: [h("Normal pace · per day", "2.7", "good"), h("Last session · trades", "6", "bad")],
    windows: [
      w("Daily Brief · the watch", [r("Normal pace", "trades per day", "2.7", "good"), r("Last session", "after a losing streak", "6", "bad")]),
      w("Daily Brief · the account", [r("Frequency", "vs the baseline", "+126%", "bad"), r("Buffer", "to the floor", "$1,682", "good"), r("Loss limit", "left today", "$1,100", "good")]),
    ],
    focus: [f(h("Last session · trades", "6", "bad"), 0, 1), f(h("Frequency vs baseline", "+126%", "bad"), 1, 0)],
    details: { title: "Daily Brief · the rest", rows: [["Buffer to the floor", "$1,682", "good"], ["Today's loss limit", "$1,100", "good"], ["Strongest window", "Open", "good"]] },
    facts: ["dashboard.overtrading_watch"],
    say: ["Normal pace: 2.7 trades a day.", "Last session: 6, after a losing streak.", "But frequency was up 126%.", "Fillbook's Daily Brief flags overtrading versus baseline.", "How many trades is your normal?"],
    cap: ["Daily Brief: pace watch.", "Last session: 6 trades.", "Frequency: up 126%.", "The Brief flags the pace.", "How many is your normal?"],
    take: ["Normal pace: 2.7 trades a day.", "Last session: 6 trades.", "Frequency was up 126%.", "The Brief flags overtrading versus baseline.", "How many trades is your normal?"],
  },
  // 17
  {
    slug: "690-left", title: "Funded 50K. Only $690 left.", topic: "A sample funded account's rules page: a small drawdown buffer beside a larger daily loss limit",
    assetId: DRAWDOWN, expectedTopic: "buffer", also: ["drawdown", "account_rules", "profit_target"], accent: "bad", dataLabel: EXAMPLE, lines: ["Funded 50K.", "Only $690 left."],
    opening: [h("Drawdown buffer", "$690", "bad"), h("Loss limit left today", "$1,200", "good")],
    windows: [w("Rules · Funded 50K", [r("Drawdown buffer", "trailing, with a bar", "$690", "bad"), r("Loss limit", "left today", "$1,200", "good")])],
    focus: [f(h("Drawdown buffer", "$690", "bad"), 0, 0), f(h("Today's loss limit left", "$1,200", "good"), 0, 1)],
    details: { title: "Rules · the rest", rows: [["Account", "Funded 50K", "good"], ["Account size", "$50,000", "good"], ["Profit target", "$3,000", "good"]] },
    facts: ["account.name_size", "rule.trailing_drawdown_buffer", "rule.daily_loss_limit_remaining", "account.profit_target_progress"],
    say: ["A funded 50K account. Only $690 left.", "Its drawdown buffer is just $690.", "But today's loss limit still shows $1,200.", "Fillbook's rules page shows both limits.", "Which number do you watch first?"],
    cap: ["Rules: Funded 50K.", "Drawdown buffer: $690.", "Today's loss limit: $1,200.", "The rules page shows both.", "Which do you watch first?"],
    take: ["A funded 50K account with $690 left.", "The drawdown buffer is $690.", "Today's loss limit shows $1,200.", "The rules page shows both limits.", "Which number do you watch first?"],
  },
  // 18
  {
    slug: "one-day-1788", title: "Month total $1,873. One day made $1,788.", topic: "A sample account's calendar: the best day against the whole month",
    assetId: CALENDAR, expectedTopic: "month_total", also: ["calendar"], accent: "bad", dataLabel: EXAMPLE, lines: ["Month total: $1,873.", "But one day made $1,788."],
    opening: [h("Best day", "$1,788", "good"), h("Month total", "$1,873", "good")],
    windows: [
      w("Calendar · the month", [r("Best day", "one day", "$1,788", "good"), r("Month total", "4 days · 8 trades", "$1,873", "good")]),
      w("Calendar · the other days", [r("Worst day", "one day", "-$139", "bad"), r("Green days", "of 4 days", "3/4", "good"), r("Average", "per trading day", "$468", "good")]),
    ],
    focus: [f(h("Best day", "$1,788", "good"), 0, 0), f(h("Worst day", "-$139", "bad"), 1, 0)],
    details: { title: "Calendar · the rest", rows: [["Trading days", "4", "good"], ["Trades", "8", "good"], ["Green days", "3 of 4", "good"]] },
    facts: ["month.total", "month.day_stats"],
    say: ["One day made $1,788 of the month.", "Four days, eight trades, $1,873.", "But the worst day lost $139.", "Fillbook's calendar shows best and worst days.", "Is one day carrying your month?"],
    cap: ["Calendar: best day.", "Month total: $1,873.", "Worst day: -$139.", "The calendar shows each day.", "One day carrying your month?"],
    take: ["One day made $1,788 of the month.", "The month totals $1,873.", "The worst day lost $139.", "The calendar shows best and worst days.", "Is one day carrying your month?"],
  },
  // 19
  {
    slug: "biggest-leak", title: "Biggest leak: stop adherence, -$7,571", topic: "A sample account's Intelligence page: the biggest leak beside the strongest setup",
    assetId: INTEL, expectedTopic: "leaks", also: ["edge", "intelligence", "account_health"], accent: "bad", dataLabel: EXAMPLE, lines: ["Biggest leak: -$7,571.", "It isn't the setup."],
    opening: [h("Biggest leak", "-$7,571", "bad"), h("Strongest setup · win rate", "78%", "good")],
    windows: [w("Intelligence · overview", [r("Biggest leak", "stop adherence", "-$7,571", "bad"), r("Strongest setup", "EMA Pullback · 9 trades", "78% win", "good")])],
    focus: [f(h("Strongest setup · win rate", "78%", "good"), 0, 1), f(h("Setup · trades", "9", "bad"), 0, 1)],
    details: { title: "Intelligence · the account", rows: [["Account health", "68/100", "good"], ["Drawdown buffer", "35%", "bad"], ["Consistency", "49%", "bad"]] },
    facts: ["insight.biggest_leak", "insight.strongest_edge", "account.health_summary"],
    say: ["Biggest leak: stop adherence, $7,571 lost.", "Strongest setup: EMA Pullback, 78% win.", "But it came from only 9 trades.", "Fillbook's Intelligence page names your biggest leak.", "What is your biggest leak?"],
    cap: ["Intelligence: biggest leak.", "Stop adherence: -$7,571.", "EMA Pullback: only 9 trades.", "The page names your leak.", "What is your biggest leak?"],
    take: ["The biggest leak is stop adherence.", "The strongest setup wins 78%.", "It came from only 9 trades.", "Intelligence names the biggest leak.", "What is your biggest leak?"],
  },
  // 20
  {
    slug: "moved-stop", title: "Moved the stop 4 times. Lost $656.", topic: "A sample account's Insights: trades tagged moved stop against trades tagged good discipline",
    assetId: INSIGHTS, expectedTopic: "mistake_tags", accent: "bad", lines: ["Moved the stop 4 times.", "Lost $656."],
    opening: [h("Moved stop · 4 trades", "-$656", "bad"), h("Good discipline · 12", "$828", "good")],
    windows: [w("Insights · tagged habits", [r("Moved stop", "4 trades · avg -$164", "-$656", "bad"), r("Good discipline", "12 trades · avg $69", "$828", "good")])],
    focus: [f(h("Moved stop · average", "-$164", "bad"), 0, 0), f(h("Good discipline · total", "$828", "good"), 0, 1)],
    details: { title: "Insights · other habits", rows: [["Chased price · 10 trades", "-$630", "bad"], ["Revenge trade · 5 trades", "-$605", "bad"], ["FOMO entry · 5 trades", "-$459", "bad"]] },
    facts: ["tags.all"],
    say: ["Four trades tagged moved stop. Lost $656.", "That averages $164 a trade.", "But 12 tagged good discipline made $828.", "Fillbook's Insights ranks tagged habits by cost.", "Which habit tops your cost list?"],
    cap: ["Insights: tagged habits.", "Moved stop: -$656, 4 trades.", "Good discipline: $828.", "Insights rank habits by cost.", "Which habit tops your list?"],
    take: ["Four trades tagged moved stop lost $656.", "That averages $164 a trade.", "Twelve tagged good discipline made $828.", "Insights rank tagged habits by cost.", "Which habit tops your cost list?"],
  },
  // 21
  {
    slug: "edge-score-67", title: "Edge Score: only 67", topic: "A sample account's Edge Score: the factors behind one score",
    assetId: EDGE_SCORE, expectedTopic: "edge_score", accent: "bad", lines: ["Edge Score: only 67.", "Trend: minus 20."],
    opening: [h("Edge Score · Developing", "67", "bad"), h("Rule adherence", "87", "good")],
    windows: [w("Edge map", [r("Rule adherence", "", "87", "good"), r("Profitability", "", "59", "bad")])],
    focus: [f(h("Rule adherence", "87", "good"), 0, 0), f(h("Profitability", "59", "bad"), 0, 1)],
    details: { title: "Edge map · the rest", rows: [["Risk control", "69", "good"], ["Consistency", "63", "bad"], ["Trend · last 3 weeks", "-20", "bad"]] },
    facts: ["edge.score", "edge.map"],
    say: ["Edge Score: only 67. Developing.", "Rule adherence scores 87.", "But profitability scores only 59.", "Fillbook gives one score for five factors.", "Which factor drags your score down?"],
    cap: ["Edge Score: 67, Developing.", "Rule adherence: 87.", "Profitability: 59.", "Five factors, one score.", "Which factor drags yours?"],
    take: ["The Edge Score is only 67.", "Rule adherence scores 87.", "Profitability scores only 59.", "One score covers five factors.", "Which factor drags your score down?"],
  },
  // 22
  {
    slug: "only-monday-lost", title: "Four days made money. Monday lost $57.", topic: "A sample account's Reports by day of the week: the one weekday that lost money",
    assetId: DOW, expectedTopic: "day_of_week", accent: "bad", lines: ["Four days made money.", "Monday lost $57."],
    opening: [h("Monday · 5 trades", "-$57", "bad"), h("Tuesday · 5 trades", "$157", "good")],
    windows: [w("Reports · day of week", [r("Monday", "5 trades", "-$57", "bad"), r("Tuesday", "5 trades", "$157", "good")])],
    focus: [f(h("Monday · 5 trades", "-$57", "bad"), 0, 0), f(h("Tuesday · 5 trades", "$157", "good"), 0, 1)],
    details: { title: "Reports · the other days", rows: [["Wednesday · 4 trades", "$61", "good"], ["Thursday · 4 trades", "$105", "good"], ["Friday · 4 trades", "$122", "good"]] },
    facts: ["dow.monday", "dow.all"],
    say: ["Four days made money. Monday lost $57.", "Monday: 5 trades, minus $57.", "But Tuesday made $157 in 5 trades.", "Fillbook's Reports break results out by weekday.", "Which weekday is your weak spot?"],
    cap: ["Reports: day of week.", "Monday: 5 trades, -$57.", "Tuesday: 5 trades, $157.", "Reports split by weekday.", "Which weekday is weakest?"],
    take: ["Four days made money.", "Monday lost $57 in 5 trades.", "Tuesday made $157 in 5 trades.", "Reports break results out by weekday.", "Which weekday is your weak spot?"],
  },
  // 23
  {
    slug: "52-vs-13", title: "One account is 52% to target. The other, 13%.", topic: "Two sample 50K accounts at a glance: progress to target on each",
    assetId: ACCOUNTS, expectedTopic: "accounts_overview", accent: "bad", lines: ["52% to target.", "The other: only 13%."],
    opening: [h("Behavior 50K · to target", "52%", "good"), h("Fixture 50K · to target", "13%", "bad")],
    windows: [
      w("Accounts at a glance", [r("Behavior 50K", "health 87", "52%", "good"), r("Fixture 50K", "health 80", "13%", "bad")]),
      w("Accounts · health", [r("Behavior 50K", "health score", "87", "good"), r("Fixture 50K", "health score", "80", "good")]),
    ],
    focus: [f(h("Behavior 50K · to target", "52%", "good"), 0, 0), f(h("Health · both accounts", "87 / 80", "good"), 1, 0)],
    details: { title: "Accounts · the rest", rows: [["Behavior 50K · buffer", "$1,682", "good"], ["Fixture 50K · buffer", "$1,725", "good"], ["Fixture 50K · best day", "46% of 40%", "bad"]] },
    facts: ["accounts.overview"],
    say: ["One account is 52% to target.", "The other is only 13%.", "But health reads 87 against 80.", "Fillbook shows every account at a glance.", "Which of your accounts lags?"],
    cap: ["Accounts at a glance.", "One account: 52% to target.", "Health: 87 against 80.", "Every account on one screen.", "Which of yours lags?"],
    take: ["One account is 52% to target.", "The other is only 13%.", "Health reads 87 against 80.", "Every account shows at a glance.", "Which of your accounts lags?"],
  },
  // 24
  {
    slug: "92-on-plan", title: "92% on plan. But the window is slipping.", topic: "A sample account's Plan vs reality: overall adherence beside the one rule that slips",
    assetId: PLANVS, expectedTopic: "plan_adherence", accent: "bad", lines: ["92% on plan.", "But the window is slipping."],
    opening: [h("Overall adherence", "92%", "good"), h("Trading window", "85%", "bad")],
    windows: [w("Plan vs reality", [r("Trading window", "111 of 131 in the window", "85%", "bad"), r("Max trades/day", "43 of 48 days", "90%", "good")])],
    focus: [f(h("Trading window", "85%", "bad"), 0, 0), f(h("Max trades per day", "90%", "good"), 0, 1)],
    details: { title: "Plan vs reality · status", rows: [["Overall adherence", "92%", "good"], ["Trading window", "Slipping", "bad"], ["Max trades per day", "On plan", "good"]] },
    facts: ["plan.adherence"],
    say: ["92% on plan. But one rule slips.", "Trading window: 85%, slipping.", "But max trades per day: 90%.", "Fillbook's Plan page scores each rule.", "Which rule do you slip on?"],
    cap: ["Plan vs reality.", "Trading window: 85%.", "Max trades per day: 90%.", "Plan page scores each rule.", "Which rule do you slip on?"],
    take: ["92% on plan.", "The trading window reads 85%, slipping.", "Max trades per day holds at 90%.", "Plan page scores each rule.", "Which rule do you slip on?"],
  },
  // 25
  {
    slug: "overtrading-days-17", title: "Flagged overtrading days: 0%. But now 17%.", topic: "A sample account's Progress: flagged overtrading days, baseline against recent, and the win rate beside it",
    assetId: PROGRESS, expectedTopic: "progress", accent: "bad", lines: ["Flagged overtrading days:", "0%. But now 17%."],
    opening: [h("Flagged overtrading days", "17%", "bad"), h("Baseline", "0%", "good")],
    windows: [w("Progress · behavior", [r("Overtrading days", "baseline to recent", "0% to 17%", "bad"), r("Win rate", "baseline to recent", "76% to 55%", "bad")])],
    focus: [f(h("Overtrading days · recent", "17%", "bad"), 0, 0), f(h("Win rate · recent", "55%", "bad"), 0, 1)],
    details: { title: "Progress · the rest", rows: [["Overtrading · baseline", "0%", "good"], ["Win rate · baseline", "76%", "good"], ["Revenge rate · recent", "6%", "bad"]] },
    facts: ["progress.behavior", "progress.win_rate"],
    say: ["Flagged overtrading days: 0% before, 17% now.", "Baseline 0%. Recent 17%.", "But the win rate fell too.", "Fillbook's Progress page tracks both over time.", "Do your busiest days help or hurt?"],
    cap: ["Progress: flagged days.", "Flagged days: 0% to 17%.", "Win rate fell too.", "Progress tracks both.", "Busiest days: help or hurt?"],
    take: ["Flagged overtrading days went from 0% to 17%.", "Baseline 0%, recent 17%.", "The win rate fell too.", "Progress tracks both over time.", "Do your busiest days help or hurt?"],
  },
  // 26
  {
    slug: "98-percent", title: "10 green days. 98% of the target. Not there yet.", topic: "A sample evaluation account's final-day dashboard: ten green days and a target not yet reached",
    assetId: FINALDAY, expectedTopic: "payout_readiness", accent: "bad", lines: ["10 green days. 98% of target.", "Not there yet."],
    opening: [h("Green days", "10/10", "good"), h("Profit target", "98%", "good")],
    windows: [
      w("Dashboard · September", [r("Month total", "10 days · 21 trades", "$2,940", "good"), r("Green days", "of 10 days", "10/10", "good")]),
      w("Rules · evaluation", [r("Profit target", "$3,000 target", "98%", "bad"), r("Drawdown buffer", "max, to the floor", "$4,940", "good"), r("Loss limit", "left today", "$1,000", "good")]),
    ],
    focus: [f(h("Made so far", "$2,940", "good"), 0, 0), f(h("Target · $3,000", "98%", "bad"), 1, 0)],
    details: { title: "Dashboard · the rest", rows: [["Best day", "$340", "good"], ["Average per trading day", "$294", "good"], ["Day streak", "10", "good"]] },
    facts: ["dashboard.finalday_summary", "rules.finalday_target", "dashboard.green_days", "rules.target_progress"],
    say: ["10 green days. 98% of the target.", "$2,940 made against a $3,000 target.", "But the target still isn't reached.", "Fillbook's dashboard shows the target progress.", "Would you trade on day eleven?"],
    cap: ["Dashboard: 98% of target.", "Made so far: $2,940.", "Target: $3,000.", "The dashboard tracks progress.", "Trade on day eleven?"],
    take: ["10 green days, 98% of the target.", "$2,940 made against a $3,000 target.", "The target still isn't reached.", "The dashboard shows the target progress.", "Would you trade on day eleven?"],
  },
  // 27
  {
    slug: "48-trades-88", title: "48 trades. Still 88% wins.", topic: "A sample account's Your Edge page: the strongest setup and the strongest window",
    assetId: YOUR_EDGE, expectedTopic: "edge", accent: "good", lines: ["48 trades. Still 88% wins.", "Which setup is it?"],
    opening: [h("Strongest setup · win rate", "88%", "good"), h("Best window · win rate", "71%", "good")],
    windows: [w("Intelligence · Your Edge", [r("Strongest setup", "Order Block Retest · 48", "88%", "good"), r("Strongest window", "Open · 106 trades", "71%", "good")])],
    focus: [f(h("Order Block Retest · win", "88%", "good"), 0, 0), f(h("Open · win rate", "71%", "good"), 0, 1)],
    details: { title: "Your Edge · the rest", rows: [["Setup · confidence", "High", "good"], ["Window · confidence", "High", "good"], ["Setup · win rate", "88%", "good"]] },
    facts: ["edge.strongest"],
    say: ["One setup: 48 trades, still 88% wins.", "Strongest setup: Order Block Retest.", "But the strongest window is Open.", "Fillbook's Your Edge page ranks both.", "What is your strongest setup?"],
    cap: ["Your Edge: strongest setup.", "Order Block Retest: 88%.", "Strongest window: Open, 71%.", "Your Edge ranks both.", "What is your strongest setup?"],
    take: ["One setup: 48 trades, still 88% wins.", "The strongest setup is Order Block Retest.", "The strongest window is Open.", "Your Edge ranks both.", "What is your strongest setup?"],
  },
  // 28
  {
    slug: "weak-hour", title: "Only 25% win in one hour. Overall: 62%.", topic: "A sample account's Insights: one weak hour against the overall win rate",
    assetId: INSIGHTS, expectedTopic: "time_of_day", also: ["overtrading"], accent: "bad", lines: ["Only 25% win in one hour.", "Overall: 62%."],
    opening: [h("Win rate · weak hour", "25%", "bad"), h("Win rate · overall", "62%", "good")],
    windows: [
      w("Insights · weak hour", [r("Weak hour", "11:00 · 20 timed trades", "25%", "bad"), r("Overall", "all timed trades", "62%", "good")]),
      w("Insights · the cost", [r("Net", "at that hour", "-$783", "bad"), r("Timed trades", "at that hour", "20", "bad")]),
    ],
    focus: [f(h("Weak hour · 20 trades", "25%", "bad"), 0, 0), f(h("Net · weak hour", "-$783", "bad"), 1, 0)],
    details: { title: "Insights · the rest", rows: [["Weak hour", "11:00", "bad"], ["Win rate · overall", "62%", "good"], ["Timed trades", "20", "bad"]] },
    facts: ["behavior.weak_hour"],
    say: ["One hour wins only 25%.", "That is across 20 timed trades.", "But overall, trades win 62%.", "Fillbook's Insights flags the weak hour.", "Which hour hurts you most?"],
    cap: ["Insights: weak hour.", "Weak hour: 25% win.", "Overall 62%. Net: -$783.", "Insights flags the weak hour.", "Which hour hurts most?"],
    take: ["One hour wins only 25%.", "That is across 20 timed trades.", "Overall, trades win 62%.", "Insights flags the weak hour.", "Which hour hurts you most?"],
  },
  // 29
  {
    slug: "24-wins-14-losses", title: "24 wins, 14 losses. Net $1,549.", topic: "A sample account's month overview: wins, losses and net P&L month to date",
    assetId: MONTH, expectedTopic: "month_total", accent: "good", dataLabel: EXAMPLE, lines: ["24 wins, 14 losses.", "But net: $1,549."],
    opening: [h("Wins · losses", "24 · 14", "good"), h("Net P&L · month to date", "$1,549", "good")],
    windows: [
      w("Overview · the trades", [r("Wins", "winning trades", "24", "good"), r("Losses", "losing trades", "14", "bad")]),
      w("Overview · the net", [r("Net P&L", "month to date", "$1,549", "good"), r("Total trades", "0 scratch", "38", "good")]),
    ],
    focus: [f(h("Winning trades", "24", "good"), 0, 0), f(h("Losing trades", "14", "bad"), 0, 1)],
    details: { title: "Overview · the rest", rows: [["Net P&L", "$1,549", "good"], ["Total trades", "38", "good"], ["Scratch", "0", "good"]] },
    facts: ["month.total_positive", "month.trade_count"],
    say: ["24 wins, 14 losses. Net: $1,549.", "38 trades, month to date.", "But 14 trades still lost.", "Fillbook's overview tallies wins, losses, net.", "What does your month tally?"],
    cap: ["Overview: month to date.", "24 wins, 14 losses.", "14 trades still lost.", "Overview tallies the month.", "What does your month tally?"],
    take: ["24 wins, 14 losses, net $1,549.", "38 trades, month to date.", "14 trades still lost.", "The overview tallies the month.", "What does your month tally?"],
  },
  // 30
  {
    slug: "84-percent", title: "$7,516 of $9,000. Still $1,484 to go.", topic: "A sample funded account's readiness page: progress to a larger target",
    assetId: PAYACCT, expectedTopic: "payout_readiness", accent: "bad", lines: ["$7,516 of $9,000.", "Still $1,484 to go."],
    opening: [h("Net P&L · target", "$7,516", "good"), h("Left to the target", "$1,484", "bad")],
    windows: [w("Readiness · the target", [r("Net P&L", "of $9,000 target", "$7,516", "good"), r("To go", "to the target", "$1,484", "bad")])],
    focus: [f(h("Net P&L · of $9,000", "$7,516", "good"), 0, 0), f(h("Left to the target", "$1,484", "bad"), 0, 1)],
    details: { title: "Readiness · the rest", rows: [["Progress", "84%", "good"], ["Rule breach", "None active", "good"], ["Account", "150K funded", "good"]] },
    facts: ["payouts.readiness", "payouts.to_go"],
    say: ["$7,516 made toward a $9,000 target.", "That is 84% of the way.", "But $1,484 is still to go.", "Fillbook's readiness page tracks the gap.", "How far along is your target?"],
    cap: ["Readiness: the target.", "Net P&L: $7,516 of $9,000.", "To go: $1,484.", "The readiness page tracks it.", "How far along are you?"],
    take: ["$7,516 made toward a $9,000 target.", "That is 84% of the way.", "$1,484 is still to go.", "The readiness page tracks the gap.", "How far along is your target?"],
  },
];

/** The 21 added concepts. Their ids continue the numbering of freshConcepts.ts (fresh-10 to fresh-30); the request order is set in motionPlans.ts. */
export const FRESH2_PILOTS: ScenePlan[] = FRESH2.map((c, i) => build(i + 10, c, "fresh", { hookFirst: true }));
export const FRESH2_CONCEPT_ORDER: string[] = FRESH2_PILOTS.map((p) => p.planId);

/**
 * The lane of every concept in the pool: "prop" = prop-firm rule pain, "own" = own money, own rules (no firm sets the limit). Test-checked:
 * the request order never runs more than two of one lane in a row.
 */
export const FRESH_LANES: Readonly<Record<string, "prop" | "own">> = {
  "fresh-01-two-limits": "prop", "fresh-02-plan-said-3": "prop", "fresh-03-one-day-46": "prop", "fresh-04-setup-lost-422": "prop", "fresh-05-below-the-floor": "prop",
  "fresh-06-five-revenge": "prop", "fresh-07-take-it-again": "own", "fresh-08-nobody-fines": "own", "fresh-09-win-rate-fell": "own",
  "fresh-10-eight-contracts": "prop", "fresh-11-two-accounts-one-trade": "prop", "fresh-12-one-red-day": "prop", "fresh-13-129-days": "prop", "fresh-14-won-then-lost": "prop",
  "fresh-15-open-vs-late-morning": "prop", "fresh-16-six-vs-norm": "prop", "fresh-17-690-left": "prop", "fresh-18-one-day-1788": "prop", "fresh-19-biggest-leak": "own",
  "fresh-20-moved-stop": "own", "fresh-21-edge-score-67": "own", "fresh-22-only-monday-lost": "own", "fresh-23-52-vs-13": "prop", "fresh-24-92-on-plan": "own",
  "fresh-25-overtrading-days-17": "own", "fresh-26-98-percent": "prop", "fresh-27-48-trades-88": "own",
  "fresh-28-weak-hour": "prop", "fresh-29-24-wins-14-losses": "own", "fresh-30-84-percent": "prop",
};
