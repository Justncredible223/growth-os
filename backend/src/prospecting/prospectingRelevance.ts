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
  /\bforex\b/i,
  /\btrader\b/i,
  /\btrading\b/i,
  /\bday ?trading\b/i,
  /\bswing trading\b/i,
  /\bscalp(ing|ed|er)?\b/i,
  /\bbacktest(ing|ed)?\b/i,
  /\bstock market\b/i,
  /\boptions? market\b/i,
  /\bmarket (maker|open|close)\b/i,
  /\bpremarket\b/i,
  /\bbrokerage\b/i,

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
 * X search exclusions appended to every discovery query: asking X not to return crypto posts at all, so they never cost a read
 * or reach the filter. The query is wrapped in parentheses so an OR inside a topic query is excluded as a whole.
 */
export const CRYPTO_QUERY_EXCLUSIONS = "-crypto -bitcoin -btc -ethereum -solana -memecoin -altcoin -airdrop -defi -nft";
export function withCryptoExclusions(query: string): string {
  return `(${query}) ${CRYPTO_QUERY_EXCLUSIONS}`;
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
  return true;
}
