/**
 * Zero-cost, deterministic relevance gate -- a real, confirmed bug this
 * closes: Prospecting surfaced posts with zero connection to futures/
 * prop-firm trading (a sci-fi story teaser scored 51 and got queued
 * under the "Hesitation" topic purely from generic engagement/length
 * heuristics in prospectingScoring.ts, which never checks the post text
 * itself for trading-domain content). This runs BEFORE any LLM call is
 * made to draft a reply -- an irrelevant candidate is skipped for $0,
 * never reaching the reply writer at all.
 *
 * Deliberately a curated allowlist of DISTINCTIVE trading/markets/
 * prop-firm terms and phrases -- never a bare generic word like "event",
 * "entry", "discipline", or "performance" on its own, which would match
 * huge swaths of unrelated content (self-help, sports, corporate
 * reviews, etc.). "futures" is one signal among many, not required --
 * "prop firm", "funded account", "drawdown", "trading journal" and
 * similar are each sufficient on their own, matching real prop-firm/
 * trading-discipline conversation even when the word "futures" never
 * appears.
 *
 * This is a coarse, conservative SAFETY NET, not a precision classifier
 * -- same tradeoff already accepted elsewhere in this codebase (e.g.
 * xReplyGuardrails.ts's phrase-based checks): a false negative here
 * (missing a genuinely relevant post phrased unusually) just means one
 * fewer candidate gets drafted, which is safe; a false positive (letting
 * through an unrelated post) is exactly the bug being fixed, so the list
 * favors precision over recall.
 *
 * Real bug this closed a second time (2026-09-07): crypto-only posts
 * (e.g. "$USELESS locked in the profits... a 15% move in less than 2h")
 * were being surfaced as actionable Prospecting cards because this gate
 * only ran when the owner tapped Draft reply (see
 * prospectingHandlers.ts's listProspectingQueue, which now applies it
 * before a candidate is ever shown). Investigating that bug also found
 * a real gap in this list itself: "overtrading" was a standalone-
 * sufficient signal, but it's genuinely a generic-enough word (unlike
 * "prop firm" or "funded account") that it doesn't reliably anchor a
 * post to futures/trading-discipline content on its own -- it was
 * removed as a standalone pattern for that reason. A post that
 * genuinely discusses overtrading in a futures/prop-firm context still
 * passes via one of its own other anchors (e.g. "funded account",
 * "drawdown", "revenge trading"), so no real coverage is lost; a crypto
 * post that merely happens to share vocabulary with trading discourse
 * is exactly what removing it protects against. The same reasoning
 * means no bare word like "volume", "discipline", "performance",
 * "entry", "move", or "profits" is ever added to this list alone --
 * each of those independently matches vast unrelated content (including
 * ordinary crypto-only posts), so a real relevance decision always
 * requires one of the distinctive, multi-word or domain-specific
 * patterns below.
 */

const TRADING_RELEVANCE_PATTERNS: RegExp[] = [
  // Direct domain anchors
  /\bfutures?\b/i,
  /\btrader\b/i,
  /\btrading\b/i,
  /\bday ?trading\b/i,
  /\bswing trading\b/i,
  /\bscalp(ing|ed|er)?\b/i,
  /\bbacktest(ing|ed)?\b/i,
  /\bmarket (maker|open|close)\b/i,
  /\bpremarket\b/i,
  /\bbrokerage\b/i,
  // Everyday trader talk (2026-10-29, owner: we are a futures trading journal and should reply wherever a futures trader talks about their trading).
  // Still needs a futures signal (FUTURES_OR_PROP_SIGNAL_PATTERNS) and passes the model screen, so a bare "trade" cannot qualify a post alone.
  /\b(trades?|stopped out|win rate|risk[- ]reward|p&l|pnl|red day|green day|setups?|journal(l?ing)?)\b/i,

  // Prop-firm / funded-account context
  /\bprop firm\b/i,
  /\bprop trading\b/i,
  /\bfunded (accounts?|traders?)\b/i,
  /\bevaluation account\b/i,
  /\bpayout (request|split|approved)\b/i,
  /\btrading combine\b/i,

  // Trading discipline / risk / psychology vocabulary
  /\b(trailing )?drawdown\b/i,
  /\brevenge trading\b/i,
  /\btrading (tilt|psychology|plan|routine|journal|process|strategy)\b/i,
  /\btrade (journal|review|execution)\b/i,
  /\bposition sizing\b/i,
  /\brisk management\b/i,
  /\bconsistency rule\b/i,
  /\bdaily loss limit\b/i,
  /\bstop[- ]loss\b/i,
  /\btake[- ]profit\b/i,
  /\bmargin call\b/i,
  /\bliquidat(ed|ion)\b/i,
  /\bleverage\b/i,
  /\blosing streak\b/i,
  /\b(blew|blown) (my |the )?account\b/i,
  /\bbroke (my )?(trading )?rules?\b/i,
  /\bstrategy hopping\b/i,
  /\bholding losers\b/i,
  /\btrading expectancy\b/i,

  // Instrument-specific (only when paired with an explicit futures/trading
  // context word elsewhere in the same post is NOT required here -- these
  // patterns already anchor the instrument to a futures/trading term).
  /\b(mnq|nq|es|mes)\s+futures\b/i,
  /\b(crude oil|natural gas)\s+futures\b/i,
  /\b(gold|silver)\s+futures\b/i,
];

/**
 * Posts that match at least one of these are almost certainly about
 * automated/algorithmic trading systems, not the manual-discipline
 * traders Fillbook serves. We exclude them even when they also contain
 * a TRADING_RELEVANCE_PATTERNS match (e.g. "automated trading" matches
 * both /\btrading\b/ and this list -- the exclusion wins).
 *
 * The override patterns below let a post survive exclusion when it's
 * clearly about manual discipline *in addition to* mentioning automation.
 */
const AUTOMATED_TRADING_EXCLUSION_PATTERNS: RegExp[] = [
  /\bautomated trading\b/i,
  /\balgo(rithmic)? trading\b/i,
  /\btrading bot\b/i,
  /\btrading (robot|algorithm|system|EA)\b/i,
  /\bexpert advisor\b/i,
  /\bcopy trading\b/i,
  /\bhigh[- ]frequency trading\b/i,
  /\bHFT\b/,
  /\bsmart grid\b/i,
  /\bquantitative trading\b/i,
  /\bquant trader\b/i,
  /\bautotrading\b/i,
];

/** These override the exclusion list when also present -- a post about
 *  algo tools that also discusses prop-firm rules or manual psychology
 *  is still worth showing. */
const MANUAL_DISCIPLINE_OVERRIDE_PATTERNS: RegExp[] = [
  /\bprop firm\b/i,
  /\bfunded (account|trader)\b/i,
  /\b(trailing )?drawdown\b/i,
  /\brevenge trading\b/i,
  /\btrading (journal|psychology|plan|routine)\b/i,
  /\b(blew|blown) (my |the )?account\b/i,
  /\bdaily loss limit\b/i,
  /\bposition sizing\b/i,
];

/**
 * Posts that are primarily about crypto -- real, confirmed leakage
 * (2026-09-16, owner-reported): crypto trading shares almost all of its
 * vocabulary with futures/prop-firm trading ("futures", "leverage",
 * "liquidated", "stop-loss", "drawdown" all apply equally to a perpetual
 * swap on a crypto exchange), so TRADING_RELEVANCE_PATTERNS alone let
 * plenty of pure-crypto posts through even after the earlier
 * crypto-vocabulary fix in isListicleOrAdFormatted's sibling gate
 * (prospectingScoring.ts). Fillbook is a futures/prop-firm journal --
 * broker-agnostic across NinjaTrader/Tradovate/Rithmic/CQG/IBKR, never a
 * crypto product -- so a crypto-only post is never a real prospect
 * regardless of how much shared vocabulary it happens to use. Same
 * override reasoning as AUTOMATED_TRADING_EXCLUSION_PATTERNS: a post that
 * also shows clear prop-firm/manual-discipline content survives (e.g. a
 * trader comparing futures and crypto drawdown discipline in the same
 * post), a crypto-only post does not.
 */
const CRYPTO_EXCLUSION_PATTERNS: RegExp[] = [
  // \bcrypto\b alone missed "cryptocurrency"/"cryptocurrencies" (confirmed
  // live, 2026-09-17: "#WEEX is a cryptocurrency exchange offering spot
  // and futures trading" passed straight through) -- there's no word
  // boundary between "crypto" and "currency", so the bare word boundary
  // form never matched the single most common real-world spelling.
  /\bcrypto(currency|currencies)?\b/i,
  /\bbitcoin\b/i,
  /\bethereum\b/i,
  /\baltcoins?\b/i,
  /\b(BTC|ETH)\b/,
  /\bperpetual (futures|swaps?)\b/i,
  /\bDeFi\b/i,
  /\bNFT\b/i,
  /\bstablecoin\b/i,
  /\b(crypto|coin) airdrop\b/i,
  // Bare "airdrop"/"KYC" (2026-09-17): a live coordinated crypto-exchange
  // spam campaign ("CoinUp's Million CPX Airdrop... Complete the required
  // KYC, deposit and Futures trading tasks to earn CPX") used the literal
  // phrase "Futures trading" specifically to clear the relevance gate --
  // sophisticated enough to defeat the narrower "(crypto|coin) airdrop"
  // pattern above. No real futures/prop-firm trader post has a legitimate
  // reason to use "airdrop" (a token distribution mechanism) or "KYC" (an
  // exchange onboarding term) -- these are unambiguous crypto-exchange-
  // promo signals on their own.
  /\bairdrop\b/i,
  /\bKYC\b/i,
  /\bmemecoin\b/i,
  // Added 2026-10-04 (owner: most of the queue was crypto and got rejected). The posts that still got through used none of
  // the words above: coin names, exchange names and on-chain slang.
  /\b(solana|SOL|XRP|DOGE|PEPE|BNB|ADA|AVAX|LINK|SUI|TON|HYPE|WIF|BONK)\b/,
  /\b(binance|bybit|okx|coinbase|kraken|hyperliquid|bitget|mexc|kucoin|phantom|metamask|uniswap|raydium)\b/i,
  /\bperps?\b/i,
  /\b(on-?chain|web3|dex|degen|rug ?pull|pump\.fun|shitcoin|tokenomics|hodl|halving|whale wallet)\b/i,
  /\btokens?\b/i,
  /\bwallets?\b/i,
];

/** Cashtags that are futures or index tickers, not coins ($ES, $NQ, $SPY ...). Any other cashtag counts as a crypto signal. */
const FUTURES_CASHTAGS = new Set(["ES", "NQ", "MES", "MNQ", "YM", "MYM", "RTY", "M2K", "CL", "MCL", "GC", "MGC", "SI", "NG", "ZB", "ZN", "ZC", "ZS", "ZW", "6E", "6J", "SPX", "SPY", "QQQ", "VIX", "DXY", "DJI", "IWM"]);

function hasCoinCashtag(postText: string): boolean {
  const tags = postText.match(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g) ?? [];
  return tags.some((t) => !FUTURES_CASHTAGS.has(t.slice(1).toUpperCase()));
}

/**
 * Options-trading posts (2026-10-24, owner: the posts that failed in the queue were crypto or options). Fillbook is a futures and
 * prop-firm journal; a calls, puts, spreads or 0DTE post is a different audience and a different product, and the shared words
 * ("trading", "risk", "premium", "stop loss") let them through. Same override as crypto: a post that also carries a clear
 * futures or prop-firm signal survives. Deliberately specific phrases, not the bare words "call" or "put" or "expiry", which
 * futures traders also use ("margin call", "contract expiry").
 */
const OPTIONS_EXCLUSION_PATTERNS: RegExp[] = [
  /\b0 ?DTE\b/i,
  /\b(1|2|3|7|14|30) ?DTE\b/i,
  /\b(call|put) (option|options|spread|spreads|premium|debit|credit|buyers?|sellers?|writers?|wall|side)\b/i,
  /\b(calls?|puts?) (on|for) \$?[A-Z]{2,5}\b/,
  /\b(spy|qqq|iwm|tsla|nvda|aapl|amzn|meta|amd)\s+(calls?|puts?|options?)\b/i,
  /\b(credit|debit|vertical|calendar|diagonal|bull|bear) (call |put )?spreads?\b/i,
  /\b(iron|broken wing) (condor|butterfly)\b/i,
  /\b(covered call|covered calls|cash[- ]secured put|poor man'?s covered call|the wheel strategy|wheel strategy)\b/i,
  /\b(theta( decay)?|vega|gamma (squeeze|exposure)|implied volatility|IV (crush|rank|percentile)|delta hedg\w*)\b/i,
  /\boptions? (trading|trader|traders|flow|chain|chains|contracts?|strategy|strategies|premium|premiums|seller|sellers|buyer|buyers|selling|buying|expiry|expiration|income|greeks)\b/i,
  /\b(strike price|strikes)\b/i,
  /\b(long|short) (calls?|puts?)\b/i,
];

export function isOptionsPost(postText: string): boolean {
  return OPTIONS_EXCLUSION_PATTERNS.some((p) => p.test(postText));
}

/**
 * Futures only (2026-10-24, owner: "we should only really be looking for creators and posts that are futures trading, relevant to
 * either prop firms or self capital"). A post must carry at least one FUTURES signal: the word futures, a futures contract ticker,
 * a futures prop firm or platform, or a rule only futures prop accounts have (trailing drawdown, consistency rule, trading combine).
 * General trading words (trader, trading, risk management, stop loss) and a bare "prop firm" or "funded account" do not qualify a
 * post (2026-10-25: a forex "funded account secured" brag and a creator's "pass prop firm challenges" video teaser both got through
 * on the bare prop-firm words), because forex, CFD, stock and options posts use them just as much.
 */
const FUTURES_OR_PROP_SIGNAL_PATTERNS: RegExp[] = [
  /\bfutures?\b/i,
  /\b(MNQ|NQ|MES|ES|YM|MYM|RTY|M2K|MCL|MGC)\b/,
  /\b(ninjatrader|tradovate|rithmic|topstepx?|apex trader funding|apex funding|take profit trader|bulenox|myfundedfutures|tradeify|elite trader funding|alpha futures|lucid trading)\b/i,
  /\b(trading combine|consistency (rule|cap)|trailing drawdown)\b/i,
  // More futures-only vocabulary (2026-10-29): real futures traders rarely write the word "futures"; they name the firm, the setup or the unit.
  /\b(apex|topstep|sim ?funded|opening range|globex|micro (contracts?|futures)|mini (contracts?|futures))\b/i,
  /\b(ORB|DOM|RTH)\b/,
  /\b\d+\s*(ticks?|handles?)\b/i,
];

/** Posts about other markets (forex, stocks): excluded unless the post also names futures explicitly. "Prop firm" is not enough, forex prop firms exist. */
const OTHER_MARKET_PATTERNS: RegExp[] = [
  /\bforex\b/i,
  /\bFTMO\b/i,
  /\b(pips?|lot size|metatrader|MT[45])\b/i,
  /\b(EUR|GBP|USD|JPY|AUD|NZD|CAD|CHF|XAU)(USD|JPY|CAD|CHF|EUR|GBP)\b/,
  /\b(stocks?|equities|penny stocks?|day trading stocks?|stock (market|picks?|trading))\b/i,
];

/** The signals that really mean futures (not just a prop firm): they override the other-market and options exclusions. */
const EXPLICIT_FUTURES_PATTERNS: RegExp[] = [
  /\b(futures?|MNQ|NQ|MES|ES|YM|MYM|RTY|M2K|MCL|MGC)\b/,
  /\bfutures\b/i,
  /\b(ninjatrader|tradovate|rithmic|topstepx?|take profit trader|bulenox|myfundedfutures|tradeify|elite trader funding|alpha futures|lucid trading)\b/i,
];
const explicitFutures = (postText: string) => EXPLICIT_FUTURES_PATTERNS.some((p) => p.test(postText));

/**
 * X search exclusions appended to every discovery query: asking X not to return crypto posts at all, so they never cost a read
 * or reach the filter. The query is wrapped in parentheses so an OR inside a topic query is excluded as a whole.
 */
export const CRYPTO_QUERY_EXCLUSIONS = "-crypto -bitcoin -btc -ethereum -solana -memecoin -altcoin";
/** The same for options (2026-10-24): asking X not to return them at all means they never cost a read. */
export const OPTIONS_QUERY_EXCLUSIONS = '-0dte -theta -"iron condor" -"credit spread" -"covered call"';
/**
 * Futures only (2026-10-24): every discovery query also requires one futures or futures-prop-firm anchor, so X returns futures posts
 * in the first place instead of generic trading posts the relevance gate would then throw away after we had paid for the read. Each
 * anchor is one the gate itself accepts (FUTURES_OR_PROP_SIGNAL_PATTERNS), so a post that matches the query passes the gate.
 */
export const FUTURES_QUERY_ANCHORS = '(futures OR MNQ OR NQ OR MES OR topstep OR apex OR ORB OR ticks OR ninjatrader OR tradovate OR rithmic OR "trailing drawdown" OR "trading combine")';
/** Topic requests skip any post that carries a link (2026-10-26): stream teasers, promo and content posts are never read or paid for. */
export const NO_LINKS_QUERY_EXCLUSION = "-has:links";
export function withCryptoExclusions(query: string): string {
  return `(${query}) ${FUTURES_QUERY_ANCHORS} ${CRYPTO_QUERY_EXCLUSIONS} ${OPTIONS_QUERY_EXCLUSIONS} ${NO_LINKS_QUERY_EXCLUSION}`;
}

/**
 * Deliberately a NARROWER, futures/prop-firm-SPECIFIC override list than
 * MANUAL_DISCIPLINE_OVERRIDE_PATTERNS above -- reusing that broader list
 * here was tried first and didn't work: generic risk-discipline vocabulary
 * like "drawdown", "daily loss limit", or "position sizing" is exactly the
 * shared vocabulary that let crypto posts slip through in the first place
 * (a crypto trader talks about drawdown and position sizing too), so it
 * can't also be what un-excludes a crypto post. Only signals that are
 * genuinely futures/prop-firm-specific -- a real prop-firm evaluation, a
 * funded account, or a named futures instrument -- are strong enough
 * evidence to override the crypto exclusion.
 */
const FUTURES_SPECIFIC_OVERRIDE_PATTERNS: RegExp[] = [
  /\bprop firm\b/i,
  /\bprop trading\b/i,
  /\bfunded (accounts?|traders?)\b/i,
  /\bevaluation account\b/i,
  /\btrading combine\b/i,
  /\b(mnq|nq|es|mes)\s+futures\b/i,
  /\b(crude oil|natural gas)\s+futures\b/i,
  /\b(gold|silver)\s+futures\b/i,
];

/**
 * True if [postText] contains at least one distinctive futures/markets/
 * prop-trading signal AND is not primarily about automated/algorithmic
 * trading systems or crypto. Used as a pre-drafting gate in
 * prospectingHandlers.ts.
 */
export function isPlausiblyTradingRelated(postText: string): boolean {
  if (!TRADING_RELEVANCE_PATTERNS.some((p) => p.test(postText))) return false;
  if (AUTOMATED_TRADING_EXCLUSION_PATTERNS.some((p) => p.test(postText))) {
    const hasManualDisciplineOverride = MANUAL_DISCIPLINE_OVERRIDE_PATTERNS.some((p) => p.test(postText));
    if (!hasManualDisciplineOverride) return false;
  }
  if (CRYPTO_EXCLUSION_PATTERNS.some((p) => p.test(postText)) || hasCoinCashtag(postText)) {
    const hasFuturesSpecificOverride = FUTURES_SPECIFIC_OVERRIDE_PATTERNS.some((p) => p.test(postText));
    if (!hasFuturesSpecificOverride) return false;
  }
  // Futures only: options and other-market posts need an explicit futures mention; everything needs a futures or prop signal.
  if (isOptionsPost(postText) && !explicitFutures(postText)) return false;
  if (OTHER_MARKET_PATTERNS.some((p) => p.test(postText)) && !explicitFutures(postText)) return false;
  if (!FUTURES_OR_PROP_SIGNAL_PATTERNS.some((p) => p.test(postText))) return false;
  return true;
}

/**
 * Newsletters, market outlooks and long article-style posts (owner, 2026-10-04: two of the three queued candidates were a
 * "Masterclass" article and a "Sunday Futures Open Outlook" newsletter). Nobody is in a conversation there, and a reply to a
 * broadcast looks like spam. A normal tweet is under 300 characters, so a long post is nearly always an article; the
 * title phrases catch the shorter ones.
 */
const BROADCAST_PATTERNS: RegExp[] = [
  /^#{1,3}\s/m, // a markdown heading
  /\bmasterclass\b/i,
  /\bcomplete (guide|session|course|breakdown)\b/i,
  /\b(open|week(ly)?|daily|market|futures|premarket|pre-market|morning|evening|sunday|monday) (outlook|recap|brief|preview|wrap|newsletter|report)\b/i,
  /\bnewsletter\b/i,
  /\bthread\b.{0,12}\b1\s*\/\s*\d+\b/i,
  /\b\d+\s*\/\s*\d+\s*$/m, // "1/8" style thread numbering
];
/** Longer than this is an article, not a tweet-sized conversation. */
export const BROADCAST_MIN_CHARS = 700;

export function isBroadcastContent(postText: string): boolean {
  if (postText.trim().length > BROADCAST_MIN_CHARS) return true;
  return BROADCAST_PATTERNS.some((p) => p.test(postText));
}

/**
 * Advertisements, mostly prop firms and tools promoting themselves (owner, 2026-10-04: 4 of 12 queued candidates were ads such
 * as "Halcyon Arena", "NO CONSISTENCY RULE on iFunds instant funding" and "Link in bio"). A reply under an ad is a reply to a
 * company, not a trader. One strong signal is enough; two weak ones are.
 */
const PROMO_STRONG: RegExp[] = [
  /\blink in (my )?bio\b/i,
  /\b(instant|direct|fast) funding\b/i,
  /\b(use|with) (code|promo)\b|\bpromo code\b|\bdiscount\b|\b\d+% off\b/i,
  /\bget (funded|paid) (today|now|instantly|fast)\b|\bgets? paid\b/i,
  /\b(sign up|join (now|today|us)|register (now|today)|limited (time|spots)|giveaway)\b/i,
  /\bpayouts? (processed|within|in) \d+ ?(h|hours|hrs|days)\b/i,
];
const PROMO_WEAK: RegExp[] = [
  /https?:\/\/t\.co\/\S+\s*$/, // ends on a link
  /\bpass the (evaluation|challenge|combine)\b/i,
  /\bwithdraw(al)? (anytime|any time|within|in \d+)\b/i,
  /\bno minimum (trading )?days\b/i,
  /\bno (consistency rule|time limit|daily drawdown|daily loss)\b/i,
  /\b(\w+ ){0,3}(account|accounts) (from|for) \$?\d+/i,
];

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.filter((p) => p.test(text)).length;
}

export function isPromoContent(postText: string): boolean {
  if (countMatches(postText, PROMO_STRONG) > 0) return true;
  const hashtags = (postText.match(/#\w+/g) ?? []).length;
  const emojiBullets = (postText.match(/[✅📋🔥💰🚀💸🏆]/gu) ?? []).length;
  const weak = countMatches(postText, PROMO_WEAK) + (hashtags >= 3 ? 1 : 0) + (emojiBullets >= 2 ? 1 : 0);
  return weak >= 2;
}

/** Accounts this small get a reply seen by almost nobody (owner, 2026-10-04); an unknown follower count is not penalised. */
export const MIN_PROSPECT_FOLLOWERS = 0; // gate off 2026-10-27: a ~30-follower account's thread, tagged to a big account, got a reply 10k views and gained ~70 followers; reach comes from the thread, not the author // lowered from 100 on 2026-10-27: a small trader's own loss story was dropped here while replies elsewhere reached 1k+ views
export function isTooSmallToBeWorthIt(followerCount: number | null | undefined): boolean {
  return typeof followerCount === "number" && followerCount < MIN_PROSPECT_FOLLOWERS;
}

/**
 * Sales-funnel broadcasts (owner direction 2026-10-16, reply-style experiment: a reply under an academy or signal seller's
 * funnel post reaches only that account's buyers and followers who are being sold to). Extends isPromoContent; nothing
 * above is weakened. Each pattern needs a selling cue, not just a topic word, so a real trader asking about a course or
 * a broker is kept.
 */
const SALES_FUNNEL_PATTERNS: RegExp[] = [
  // Teasers and announcements (2026-10-25): a creator's "video later today", a stream notice, or a funded-account brag is a broadcast, not a conversation.
  /\b(?:new|latest|next) (?:video|stream|episode|podcast|livestream)\b/i,
  /\bvideo (?:later|tomorrow|today|tonight|coming|dropping|soon|out now)\b/i,
  /\b(?:going |am |we'?re )?live (?:at|on|today|tonight|now|in)\b/i,
  /\bwatch (?:my|the|our) (?:video|stream|full)\b/i,
  /\bfunded account secured\b/i,
  /\bJOIN\b/, // shouted call to action ("... ACADEMY ... JOIN")
  /\b(?:join|enrol+|register for|sign ?up for|apply for|get access to) (?:the |our |my |this )?(?:\w+ ){0,3}(?:academy|course|mentorship|masterclass|bootcamp|webinar|community|group|channel|telegram|discord|vip)\b/i,
  /\b(?:live )?trading academy\b/i,
  /\bdm (?:me|us)\b|\bdm for\b|\b(?:message|text) me (?:for|to)\b|\bwhats ?app\b|\btelegram\b|\bt\.me\//i,
  /\b(?:vip|premium|paid|private) (?:signals?|group|channel|community|mentorship)\b|\bsignals? (?:group|service|provider|channel)\b/i,
  /\bfree (?:class|training|webinar|workshop|ebook|e-book|pdf|strategy|trial)\b/i,
  /\b(?:limited|only \d+) (?:seats?|spots?|slots?|places?)\b|\benrollment (?:is )?(?:open|closing)\b|\bcohort\b/i,
  /\b(?:turn|grow|flip) \$?\d+k? (?:in)?to \$?\d+k?\b/i,
];
/** CFD / retail-forex broker vocabulary: promo for a different audience than futures traders on prop firms. */
const CFD_BROKER_PATTERNS: RegExp[] = [/\bCFDs?\b/, /\b(?:MT4|MT5|MetaTrader)\b/i, /\bspread betting\b/i, /\b(?:forex|fx) brokers?\b/i, /\bzero commission\b/i, /\bleverage up to\b/i, /\bopen (?:a |an |your )?(?:live |demo )?account\b/i];
const INVITE_REPLY_PATTERN = /\b(?:what do you|how do you|what would you|which (?:one )?do you|anyone else|who else|your (?:take|thoughts)|thoughts on|drop your|tell me|curious (?:how|what|which|if|whether)|do you (?:still|ever|also))\b|\bpoll\b/i;

function countHashtags(text: string): number {
  return (text.match(/#\w+/g) ?? []).length;
}
function hasLink(text: string): boolean {
  return /https?:\/\/\S+/i.test(text);
}

/** True when what is left after removing links, hashtags and @mentions is too little to reply to. */
export function isOnlyHashtagsOrLinks(postText: string): boolean {
  const rest = postText.replace(/https?:\/\/\S+/gi, " ").replace(/#\w+/g, " ").replace(/@\w+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ");
  return rest.split(/\s+/).filter((w) => w.length > 1).length < 3;
}

/** Sales funnel / CFD-broker promo / hashtag-only posts that never reach the queue. Genuine trader questions pass. */
export function isSalesFunnelOrEmptyPost(postText: string): boolean {
  if (isOnlyHashtagsOrLinks(postText)) return true;
  if (countHashtags(postText) >= 4) return true;
  if (SALES_FUNNEL_PATTERNS.some((p) => p.test(postText))) return true;
  // A link plus a selling cue is a funnel even when each alone would pass.
  if (hasLink(postText) && /\b(?:join|register|enrol+|sign ?up|get access|learn how|grab|claim|limited)\b/i.test(postText)) return true;
  if (CFD_BROKER_PATTERNS.some((p) => p.test(postText))) {
    // A plain trader question about CFDs vs futures is a real conversation; a CFD statement or hashtagged bait is a broker's marketing.
    const genuineQuestion = postText.includes("?") && countHashtags(postText) < 2 && !hasLink(postText);
    if (!genuineQuestion) return true;
  }
  return false;
}

/** True when the post asks the reader something or invites replies (feeds a small score boost, see prospectingScoring.ts). */
export function invitesReplies(postText: string): boolean {
  return INVITE_REPLY_PATTERN.test(postText);
}

/** The original gate: about futures / prop-firm trading, and a post a person can actually reply to (not a newsletter or an ad). */
export function isReplyWorthyBase(postText: string): boolean {
  return isPlausiblyTradingRelated(postText) && !isAiAgentHype(postText) && !isBroadcastContent(postText) && !isPromoContent(postText);
}

/** Prospecting's gate: the original gate plus no sales funnel, CFD-broker promo or hashtag/link-only post (reply-style experiment, 2026-10-16). */
export function isReplyWorthyPost(postText: string): boolean {
  return isReplyWorthyBase(postText) && !isSalesFunnelOrEmptyPost(postText);
}

/** AI trading-agent hype (2026-10-04) is not the manual-discipline audience. No override: these posts always mention drawdown too. */
const AI_AGENT_PATTERNS: RegExp[] = [/\bAI (trading )?agents?\b/i, /\btrading agents?\b/i];
export function isAiAgentHype(postText: string): boolean {
  return AI_AGENT_PATTERNS.some((p) => p.test(postText));
}

/**
 * The first reason a post fails the free gate, or null when it passes (2026-10-25: two days of searches ended with no usable post and
 * nothing recorded about where posts died). Mirrors isReplyWorthyPost, so a post is dropped exactly when this returns a reason.
 */
export function whyNotReplyWorthy(postText: string): string | null {
  if (!isPlausiblyTradingRelated(postText)) {
    const futures = explicitFutures(postText);
    if (isOptionsPost(postText) && !futures) return "options";
    if (OTHER_MARKET_PATTERNS.some((p) => p.test(postText)) && !futures) return "forex_stock";
    if (CRYPTO_EXCLUSION_PATTERNS.some((p) => p.test(postText)) || hasCoinCashtag(postText)) return "crypto";
    if (!TRADING_RELEVANCE_PATTERNS.some((p) => p.test(postText))) return "not_trading";
    if (AUTOMATED_TRADING_EXCLUSION_PATTERNS.some((p) => p.test(postText))) return "automated_trading";
    return "no_futures_evidence";
  }
  if (isAiAgentHype(postText)) return "ai_hype";
  if (isBroadcastContent(postText)) return "broadcast";
  if (isPromoContent(postText)) return "promo";
  if (isSalesFunnelOrEmptyPost(postText)) return "sales_funnel";
  return null;
}
