/**
 * The Fillbook views a public reply may show someone, each tied to the trader problem it answers
 * (owner direction 2026-09-25: X replies read as conversation, not as "here is how Fillbook helps
 * with the exact problem you tweeted about"). Every "shows" line describes a real screen, verified
 * against the captured recordings in scripts/video-factory/assets/verified-manifest.json -- the same
 * screens the P1-P9 motion concepts in src/shortform/pilots.ts are built on. Add a view here only
 * after it has been checked against the live app the same way.
 */
export type ShowcaseAudience = "prop" | "own" | "both";

export interface FillbookShowcaseView {
  id: string;
  /**
   * Who the view is for: "prop" needs a firm's rules (drawdown floor, consistency cap, payouts, evaluations), "own" is for a
   * trader risking their own money in a personal broker account, "both" fits either. A reply never shows a "prop" view to a
   * self-funded trader or an "own" view to someone describing a firm's rules.
   */
  audience: ShowcaseAudience;
  /** Plain-language trader problems this view answers. */
  problems: string;
  /** What the screen actually shows, in words a reply can use. */
  shows: string;
}

export const FILLBOOK_SHOWCASE_VIEWS: readonly FillbookShowcaseView[] = [
  {
    id: "setup_breakdown",
    audience: "both",
    problems: "a green month or account that hides a losing setup; not knowing which setup makes or loses the money; 'my strategy works but I'm still down'",
    shows: "the By setup breakdown: every setup on its own row with its trade count, win rate and net P&L",
  },
  {
    id: "account_buffer",
    audience: "prop",
    problems: "confusing account balance with drawdown room; a trailing drawdown surprise; not knowing how much room is left today",
    shows: "each prop account's trailing drawdown buffer in dollars, today's loss limit remaining, and profit target progress, side by side",
  },
  {
    id: "size_vs_plan",
    audience: "both",
    problems: "sizing up after losses or on a hunch; breaking a max-contracts rule; 'same setup, bigger size'",
    shows: "the trading plan's max contracts per trade, next to a trade log that shows each trade's size and setup, so a 5-lot on a 3-contract plan is right there",
  },
  {
    id: "consistency_cap",
    audience: "prop",
    problems: "a consistency rule blocking or delaying a payout; one big day making up too much of the profit",
    shows: "account health flagging, as its most important action, when one day's share of total profit is over the firm's consistency cap (for example 46% against a 40% cap)",
  },
  {
    id: "rule_simulator",
    audience: "prop",
    problems: "wondering whether they'd pass a firm's evaluation; choosing between prop firms; confusion about a firm's rules",
    shows: "the rule simulator: it replays the trades they already logged against a firm's evaluation rules, including a firm they haven't signed up with, with a checklist for profit target, minimum days, drawdown, daily loss and consistency",
  },
  {
    id: "edge_score",
    audience: "both",
    problems: "not knowing whether they're actually improving; wanting one honest read on their trading beyond P&L",
    shows: "the Edge Score: one number blending profitability, consistency, risk control, and stop and rule adherence, with each part broken out and a trend over recent weeks",
  },
  {
    id: "daily_brief",
    audience: "both",
    problems: "starting the day without reviewing yesterday; trading outside their best hours; forgetting how much room is left before the session",
    shows: "the Daily Brief before the session: last session's result, the buffer left to the drawdown floor and today's loss limit, and their strongest time window with its win rate",
  },
  {
    id: "day_of_week",
    audience: "both",
    problems: "one day of the week that keeps costing them; 'I always lose on Mondays/Fridays'",
    shows: "P&L and trade count by day of week, using the session date, so the one red weekday stands out",
  },
  {
    id: "payout_timeline",
    audience: "prop",
    problems: "wondering how long until a payout; payout requirements they can't keep track of",
    shows: "the payout timeline: trading days to payout-ready at their current pace, a what-if for a different daily average, and a readiness checklist of the firm's payout requirements",
  },
  // ---- Traders risking their own money (personal futures account, no firm rules). Descriptions match the live screens
  // and their on-screen copy (Capital curve, Own-capital insights, Cost of trading), checked against the app 2026-10-07. ----
  {
    id: "capital_curve",
    audience: "own",
    problems: "not knowing their real return once deposits and withdrawals muddy the balance; topping up an account after losses so the drawdown disappears; 'am I actually up on my own account?'",
    shows: "the Capital curve: account value over time with the highest balance as a dashed line, the time-weighted return, and the largest drop from the peak, with deposits and withdrawals kept out of the return and the drawdown",
  },
  {
    id: "drawdown_odds",
    audience: "own",
    problems: "wondering how deep a drawdown could get on their own account; 'how many losers in a row can I survive'; a small account with no idea how fragile it is",
    shows: "Drawdown odds from their own history: their logged trades replayed in random order, showing how often the account fell at least a given percent from its highest point (labelled a what-if, not a forecast, and noisy with few trades)",
  },
  {
    id: "size_from_account",
    audience: "own",
    problems: "how many contracts to trade for their account size; sizing off a gut feeling or a fixed lot; risking too much of a small account on one trade",
    shows: "Size from your account value: the contracts allowed by a risk-per-trade percent and a max-margin percent the trader picks, for a chosen contract and stop in ticks (their numbers, not a recommendation)",
  },
  {
    id: "cost_of_trading",
    audience: "own",
    problems: "fees, data feed, platform and software eating a small account's profit; 'am I really profitable after costs?'; commissions on high-volume scalping",
    shows: "Cost of trading: fees paid by month and per contract as a share of gross profit, plus logged overhead (data, platform, VPS, education), so results show after overhead and whether the last few months covered it",
  },
  {
    id: "instrument_and_hours",
    audience: "own",
    problems: "which contract or time of day actually pays them; trading several futures all day with no idea which one makes the money",
    shows: "By instrument (win rate, net P&L, average win and loss, payoff and per-trade expectancy per contract, net of fees) and By time of day (New York entry hour), so the contract or hour that loses stands out",
  },
  {
    id: "margin_exposure",
    audience: "own",
    problems: "how much margin they actually use; holding overnight; margin-call worry on a personal account",
    shows: "Margin and exposure: using the day and overnight margin the trader enters themselves, the highest margin in use at one time as a share of starting capital and how many trades were held across the daily close (Fillbook does not supply margin figures and it is not a broker statement)",
  },
  // ---- Added 2026-10-12 to match the site (PRODUCT_FACTS.md in the fillbook repo, sections 3, 4, 6a to 6e, and the in-app
  // "What's new" entries through 2026-10-10). None of these says "real time" or "live": Fillbook works from synced closed
  // trades, and the claim rules in brandConstitution.ts block those words in a reply that names Fillbook. ----
  {
    id: "account_ledger",
    audience: "prop",
    problems: "no idea what an evaluation or funded account has cost against what it has paid out; resets, monthly fees and payouts scattered across emails; 'am I actually up after fees on this firm?'",
    shows: "the account ledger on Payouts: each account's fees and payouts in date order with a running balance, recurring monthly fees included, read-only and exportable to CSV or Excel",
  },
  {
    id: "evaluation_ev",
    audience: "prop",
    problems: "deciding whether the next evaluation is worth buying; paying for resets with no idea what an attempt really costs; 'how many tries will it take me?'",
    shows: "the expected-value card on Simulate: the break-even pass chance, expected value per attempt, expected attempts and expected spend to reach a funded account, from the fee, reset and payout numbers the trader enters (prefilled only from their own logged data or a reset fee the firm itself publishes), next to a pass probability worked out from their own trades (an estimate from their history, not a prediction)",
  },
  {
    id: "payout_scan",
    audience: "prop",
    problems: "a payout denied or delayed over a rule they did not know about; a news-window, overnight-holding or payout-buffer rule they missed; 'did I break something before I requested?'",
    shows: "the payout readiness scan on Rules: OK, Warning or Can't tell for consistency share, minimum trading days, an optional payout buffer, trades inside a news-blackout window around FOMC, CPI and jobs reports, positions held across the 6 PM ET rollover when overnight holding is banned, and a possible cross-account hedge, using only the rule values the trader typed in (it knows no firm's payout rules and says Can't tell when the data is not enough)",
  },
  {
    id: "review_queue",
    audience: "both",
    problems: "trades piling up unreviewed; never tagging setups or emotions so the reports stay empty; a journal that never gets done",
    shows: "the Review queue on Trades: the trades with no setup, tag, emotion or note, one decision at a time with keyboard shortcuts and a day streak, so the reports fill in as they go",
  },
  {
    id: "exit_efficiency",
    audience: "both",
    problems: "taking profits too early or giving winners back; 'I was right on direction but left money on the table'; a winner that turned into a loser",
    shows: "the Exit efficiency card in Reports: how much of each winner's best open profit was kept, how far trades went against them before the close in ticks per contract, and which losers gave back open profit (only for trades that carry MFE and MAE data, which today comes from the NinjaTrader add-on and not from CSV imports, and those add-on values are not yet checked against NinjaTrader's own figures, so call it a view of the data and never a measurement)",
  },
  {
    id: "mentor_link",
    audience: "both",
    problems: "wanting a coach or mentor to review their trades without handing over a login or screenshots; an accountability partner who asks to see the numbers",
    shows: "a read-only mentor link made in Settings: a page scoped to the accounts and date range the trader picks (equity curve, stats, calendar, setups, trade list) that opens with no account, expires in up to 90 days, can be revoked any time, and lets the mentor leave short comments on those trades",
  },
  {
    id: "auto_sync",
    audience: "both",
    problems: "re-typing or exporting trades by hand; 'does your journal import from Tradovate or NinjaTrader?'; a journal that falls behind the account",
    shows: "automatic trade import: Tradovate on a schedule plus a Sync now button, NinjaTrader 8 and Quantower through an add-on that sends each fill while the platform is running, and CSV import for other brokers and platforms (everything is built from the trades that arrived, so it can trail the broker)",
  },
  {
    id: "ai_assistant",
    audience: "both",
    problems: "wanting to ask an AI assistant questions about their own numbers instead of pasting CSVs into a chatbot",
    shows: "the connector for AI assistants (beta): Claude Code, Cursor or claude.ai can read the status, performance and trades of the accounts the trader chooses, read-only, with notes left out unless ticked (it is a way to ask questions about their own results, not a trading bot, and it gives no signals or advice)",
  },
];

export const SHOWCASE_NONE = "none";

/** The ids a reply's `showcase` field may take. */
export const SHOWCASE_IDS: readonly string[] = [...FILLBOOK_SHOWCASE_VIEWS.map((view) => view.id), SHOWCASE_NONE];

/** The views as a prompt block. */
export function formatShowcaseViews(): string {
  const section = (heading: string, audience: ShowcaseAudience): string =>
    `${heading}\n` +
    FILLBOOK_SHOWCASE_VIEWS.filter((view) => view.audience === audience)
      .map((view) => `- ${view.id}: for ${view.problems}. Fillbook shows ${view.shows}.`)
      .join("\n");
  return [
    section("Fit anyone (prop-firm or own money):", "both"),
    section("Only for a trader dealing with a prop firm's rules (a firm's drawdown floor, consistency cap, payouts or evaluation):", "prop"),
    section("Only for a trader risking their own money in a personal broker account (no firm rules involved):", "own"),
  ].join("\n\n");
}

/**
 * How a reply shows Fillbook, shared by cold (Prospecting) and inbound replies on X. Replaces the
 * "mention it almost as an aside, and only when earned" guidance, which produced replies that read
 * as friendly conversation with no reason to try the product.
 */
export const SHOWCASE_REPLY_GUIDANCE = `YOUR JOB IN THIS REPLY: when their post describes a problem Fillbook answers, show them what Fillbook would
show them about that exact problem. The goal is a reader thinking "I want to see that for my own trades."
A post also fits a view when it explains, asks about, or complains about a rule or habit that view tracks: a thread
explaining trailing vs static drawdown fits account_buffer; a list of live-trading weaknesses like size creeping up
fits size_vs_plan or setup_breakdown.

Some traders use a prop firm and some trade their own money in a personal broker account (self-funded). Read which
one they are from the post: a firm's name, an eval, a payout, a drawdown floor or a consistency rule means prop firm;
"my own money", "my live account", "self-funded", margin, deposits or withdrawals, account size or costs means own
money. Only show a view marked for their kind of trader. If you cannot tell, choose a view that fits anyone, or leave
Fillbook out. Never talk to a self-funded trader about firm rules, and never talk to a prop trader about their capital.

The Fillbook views you may show (the ONLY product capabilities you may describe):
${formatShowcaseViews()}

When one of these views fits their problem:
1. First, one specific, useful point about their situation: the rule, the number, or what is likely going on.
   Plain and short.
2. Then one sentence that names Fillbook and describes concretely what that view would show them, in the terms
   of their post. "Fillbook's By setup view would put that ORB on its own row with its own win rate and net P&L,
   so a green month can't hide it" is the shape. "We track that in Fillbook" is too vague to make anyone curious.
3. The Fillbook sentence is the point of the reply, not an aside. Pick exactly ONE view. Describe what it shows;
   never promise what it will do for them, and never invent numbers about their account.

Worked examples (write your own for the actual post, never copy these):
Their post: "Up on the month but some of my trades just keep bleeding and I can't tell which."
Reply: "Usually it's one setup eating what the others make. Fillbook splits every trade by setup with its own win
rate and net P&L, so the one that's bleeding sits at the top of the list."
Their post: "Passed my eval, requested a payout, got denied for the consistency rule. Nobody warned me."
Reply: "That rule usually measures your best day's share of total profit, so one big day late in the eval does it.
Fillbook's account health puts that share next to your firm's cap before you ever hit request."
Their post: "Been adding to my live account every time I take a bad week. No idea if I'm actually up."
Reply: "Deposits make a bad week look smaller than it was. Fillbook's capital curve keeps deposits and withdrawals out
of the return, so the line only moves on your trading and the drop from your peak stays visible."

When NO view fits (a market call, news, a meme, a pure price question, small talk), just answer or react well and
leave Fillbook out entirely. Never name Fillbook without one of the views above: a vague "Fillbook puts every trade in
one place" line is neither a view nor a reason to look. Forcing a view onto a post it doesn't fit reads as spam and
costs trust.

Hard rules, no exceptions:
- No link unless the link policy below allows it, and no call to action: never "check it out", "try it", "sign up",
  "learn more", "DM me", "click here", "link in bio", discount talk or urgency. Showing the view is the pitch.
- Never claim a personal trading result, a customer or user result, or a capability that is not in the list above
  or the verified knowledge given to you.
- For a trader on their own money: never tell them how many contracts to trade, how much to risk or hold, whether
  to deposit or withdraw, or anything about taxes. Describe the numbers Fillbook shows from what they logged, and
  that is all.
- Essentials plan (live, verified; it was called Own Capital until 2026-10-11): Fillbook has a plan for traders on their
  own money called Essentials, $14.99 a month. Do not bring up a plan or a price on your own (owner direction
  2026-10-15: replies that read as a price list cost followers). Say it only when a trader on their own money asked what
  it costs, which plan has a view, or whether it is free, and only for the views marked for a trader on their own money
  (capital_curve, drawdown_odds, size_from_account, cost_of_trading, instrument_and_hours, margin_exposure). Then state
  it once, flatly, for example "It's on the Essentials plan, $14.99 a month." Never as an invitation, and never call it
  cheap, a deal or a bargain.
  Never mention it to a prop-firm trader or when no view is shown, and never say Essentials includes auto_sync,
  mentor_link, ai_assistant, account_ledger, payout_scan or evaluation_ev: those sit on higher plans, so for them
  name no plan at all. Never name any other plan or price, never quote an annual price, and never mention a free
  trial or a discount.
- Never impersonate an individual trader or conceal that this is the Fillbook account replying. The voice sounds
  like a real person, but the affiliation is never hidden or denied.`;
