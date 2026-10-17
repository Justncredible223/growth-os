/**
 * Search-friendly YouTube titles and descriptions for the verified concepts (2026-10-17).
 *
 * Why: YouTube Studio showed that about 23% of Shorts views come from YouTube search, and every Short over 400 views
 * (Sep 16 and Sep 21) had a title people search for ("Why Traders Break Their Rules", "Static vs Trailing Drawdown").
 * From late September the Shorts used the concept's number teaser as the title ("Won $3,100. Then lost $3,060."): a good
 * TikTok caption that nobody types into YouTube search, and Shorts views fell to about 7 a video, the last three 0 to 2.
 * The description was one template for every video, opening with the demo-data disclaimer.
 *
 * So each concept is matched, by its own title and topic, to the question a trader would actually search. The YouTube
 * title leads with that phrase and keeps the teaser after it; the description opens by explaining the topic and keeps
 * the demo-data disclosure, unchanged in substance, at the end. TikTok and Instagram captions are not touched.
 */

export interface SearchTopic {
  id: string;
  /** Matched against the concept's public title and topic, lower-cased. First rule that matches wins. */
  match: RegExp;
  /** What a trader would type into YouTube search. Starts the title. */
  phrase: string;
  /** A shorter lead used when the phrase plus the teaser would pass the title limit. */
  short: string;
  /** One or two plain sentences that open the description. No claims beyond the concept's own topic. */
  explainer: string;
}

/** Ordered: the more specific rules first. */
export const SEARCH_TOPICS: readonly SearchTopic[] = [
  {
    id: "consistency",
    match: /consistency[- ](cap|rule)|% of the profit|one day made|month total \$[\d,]+\. one day/,
    phrase: "Prop firm consistency rule explained",
    short: "Consistency rule",
    explainer: "Many prop firms cap how much of your total profit a single day can make. One big day can hold up a payout even on a profitable account.",
  },
  {
    id: "retake",
    match: /take (it|the trade|a trade) again|retake|you doubted|wouldn't take|already know your bad trades|one question after every trade/,
    phrase: "The post-trade question that finds your bad trades",
    short: "Post-trade review",
    explainer: "Asking one question after every trade, would I take it again, splits your results into trades worth repeating and trades that cost you.",
  },
  {
    id: "revenge",
    match: /revenge|after a loss|after the loss|sized up|trade after the loss|bigger position|loss, then/,
    phrase: "Revenge trading: how to spot it in your trades",
    short: "Revenge trading",
    explainer: "Revenge trades show up in a trade log as a bigger position opened soon after a loss.",
  },
  {
    id: "multi-account",
    match: /two accounts|both accounts|two funded accounts|two sample|accounts overview|account is 52%|closer to the line|health 87/,
    phrase: "Trading multiple prop firm accounts",
    short: "Multiple prop accounts",
    explainer: "Each prop account has its own buffer, loss limit and target, and the same trade on two accounts carries the same risk twice.",
  },
  {
    id: "size",
    match: /contract|size limit|same setup\. bigger size|plan said|broke the plan/,
    phrase: "Position sizing rules for futures traders",
    short: "Position sizing",
    explainer: "A written trading plan sets a maximum position size. Comparing each trade's size to that number shows the trades that broke it.",
  },
  {
    id: "plan",
    match: /on plan|the plan|outside (your|the) (window|plan)|inside the plan|off-plan|rule by rule|plan vs reality/,
    phrase: "How to follow your trading plan",
    short: "Trading plan rules",
    explainer: "Checking each rule of a trading plan against real trades shows which rule slips and what the trades outside the plan did.",
  },
  {
    id: "evaluation",
    match: /would your trades pass|evaluation rules|breach|prop firm before you pay/,
    phrase: "How to pass a prop firm evaluation",
    short: "Prop firm evaluation",
    explainer: "Replaying trades against a firm's evaluation rules shows whether they would have passed, which is different from not breaching.",
  },
  {
    id: "overtrading",
    match: /overtrad|busy day|more trades|norm of|trades after a|normal day is|normal: |2\.7|pace up|trade count/,
    phrase: "How to stop overtrading futures",
    short: "Overtrading",
    explainer: "Knowing your normal number of trades a day makes the overtrading sessions obvious, and those sessions tend to end red.",
  },
  {
    id: "daily-loss",
    match: /loss limit|left today|two limits|limit before the open|\$1,000 today/,
    phrase: "Daily loss limit vs drawdown buffer",
    short: "Daily loss limit",
    explainer: "A prop account has two numbers before the first trade: the room above the drawdown floor and today's loss limit. The smaller one is the one that applies today.",
  },
  {
    id: "payout",
    match: /payout|target|trading days|readiness|green days/,
    phrase: "Prop firm payout and profit target rules",
    short: "Prop firm payout rules",
    explainer: "A payout depends on several requirements at once, such as the profit target and minimum trading days, each tracked on its own.",
  },
  {
    id: "trailing-drawdown",
    match: /drawdown|floor|buffer|room is left|room left|balance isn't|\$690 left/,
    phrase: "Trailing drawdown explained",
    short: "Trailing drawdown",
    explainer: "A trailing drawdown floor follows your best balance, so being up on the account is not the same as having room left.",
  },
  {
    id: "stop",
    match: /stop/,
    phrase: "Moving your stop loss: what it really costs",
    short: "Moving your stop loss",
    explainer: "Tagging the trades where you moved your stop turns a habit into a dollar figure.",
  },
  {
    id: "time-of-day",
    match: /hour|the open|open wins|late morning|11:00|o'clock|your best window|strongest window|in one window|time of day/,
    phrase: "Best time of day to trade futures",
    short: "Best time to trade futures",
    explainer: "Splitting results by time of day often shows one strong window and one hour that gives the gains back.",
  },
  {
    id: "weekday",
    match: /monday|tuesday|weekday|day of the week/,
    phrase: "Which day of the week do you trade worst",
    short: "Worst trading day of the week",
    explainer: "Splitting results by weekday can show one day that loses while the rest of the week is green.",
  },
  {
    id: "win-rate",
    match: /win rate and (up|down)|% win rate|win rate fell|win rate 76|fell 21 points|baseline|old self/,
    phrase: "Why win rate doesn't equal profit",
    short: "Win rate vs profit",
    explainer: "Win rate counts trades, not dollars. The size of the wins and losses decides whether a high or low win rate makes money.",
  },
  {
    id: "setup",
    match: /setup/,
    phrase: "How to find your best trading setup",
    short: "Best trading setup",
    explainer: "Grouping trades by setup shows which one actually pays and which one quietly loses, even inside a good overall record.",
  },
  {
    id: "score",
    match: /edge score|health|score|rule adherence/,
    phrase: "Trading performance score explained",
    short: "Trading score",
    explainer: "One score that blends profitability, consistency, risk control and rule adherence shows which habit is weakest, not just which trade.",
  },
  {
    id: "habits",
    match: /habit|tag|fomo|chased|chasing|leak|mistake/,
    phrase: "Trading habits that cost you money",
    short: "Costly trading habits",
    explainer: "Tagging trades by habit and adding up each tag's result ranks your mistakes by what they cost.",
  },
  {
    id: "month",
    match: /month|green|red day|lost \$\d+ in \d+ trades|best day|worst day|won \$/,
    phrase: "What your trading P&L doesn't show",
    short: "Trading P&L",
    explainer: "A month total or a big day can hide the trades and days that cost money.",
  },
];

/** Used when nothing else matches. */
export const FALLBACK_TOPIC: SearchTopic = {
  id: "journal",
  match: /.^/,
  phrase: "Futures trading journal: what your trades show",
  short: "Trading journal",
  explainer: "A trading journal turns your own trade history into numbers you can act on.",
};

export const YOUTUBE_TITLE_MAX = 70;

export function searchTopicFor(title: string, topic: string): SearchTopic {
  const text = `${title} ${topic}`.toLowerCase();
  return SEARCH_TOPICS.find((t) => t.match.test(text)) ?? FALLBACK_TOPIC;
}

/**
 * "Prop firm consistency rule explained: One day made 46% of the profit". When that passes the limit the short lead is
 * tried ("Consistency rule: ..."), so titles stay distinct; the phrase alone is the last resort.
 */
export function youtubeSearchTitle(title: string, topic: string): string {
  const match = searchTopicFor(title, topic);
  const teaser = title.trim().replace(/[.!?]+$/, "");
  for (const lead of [match.phrase, match.short]) {
    const combined = `${lead}: ${teaser}`;
    if (combined.length <= YOUTUBE_TITLE_MAX) return combined;
  }
  return match.phrase;
}

/**
 * Opens with what the video is about, in searchable words; then this example; then the same demo-data disclosure the
 * template carried, so nothing a viewer reads is presented as real results.
 */
export function youtubeSearchDescription(title: string, topic: string, handle: string): string {
  const { explainer } = searchTopicFor(title, topic);
  const example = topic.trim().replace(/[.]+$/, "");
  return [
    explainer,
    `In this example: ${example}.`,
    `Every number shown is demo data from a sample Fillbook account, not a real trader's results. Fillbook is a trading journal: log your own trades and check them against your own rules. ${handle}`,
  ].join("\n\n");
}
