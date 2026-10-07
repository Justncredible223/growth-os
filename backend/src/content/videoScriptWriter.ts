import { findRepeatedHook, formatRecentVideos, type RecentVideo } from "./videoHookVariety.js";
import type { LlmClient } from "./llmClient.js";
import { capitalizationProblem, dashProblem } from "./xReplyGuardrails.js";
import { computeScenePlanHash } from "../shortform/scenePlan.js";
import { OFFICIAL_HANDLE, type ScenePlan } from "../shortform/types.js";

const VIDEO_SCRIPT_SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "string", description: "The opening line, spoken or on-screen, in the first 1-2 seconds." },
    script: {
      type: "string",
      description:
        "Full voiceover/spoken script, hook through close. Plain sentences, no stage directions. 45-75 words (hard max 100). The last sentence must flow back into the hook so the video loops.",
    },
    shotList: {
      type: "array",
      items: { type: "string" },
      description: "Ordered visual beats (what's on screen for each script segment, 8-12 entries, ~2-3s each) -- e.g. 'Text card: the number', 'Fillbook UI: the trade log filtering by date'.",
    },
    youtubeTitle: {
      type: "string",
      description: "YouTube Shorts video title, written the way a trader would search for it: the specific prop-firm rule, mechanic or comparison in the first three words (e.g. 'X vs Y: ...', 'How X works for funded traders'), then the useful angle. Under 70 characters, never first-person, no emoji, no hashtags, no ALL CAPS words, no clickbait.",
    },
    youtubeDescription: {
      type: "string",
      description: "YouTube Shorts description (3-5 sentences): expand the hook, name the specific problem and how Fillbook solves it, close with a clear call-to-action directing viewers to fillbookhq.com. Distinct from both the spoken script and the TikTok caption.",
    },
    tiktokCaption: {
      type: "string",
      description: "TikTok caption (2-3 punchy lines, platform-native tone): hook the scroll, name the pain or insight, close with a soft CTA (e.g. 'link in bio'). Distinct from both the spoken script and the YouTube description.",
    },
    instagramCaption: {
      type: "string",
      description: "Instagram Reels caption: similar punchy hook-first structure to the TikTok caption but Instagram tolerates (and rewards) a bit more length -- 3-5 lines, add one more sentence of real value/context after the hook line, lean on keyword-relevant phrasing (Instagram search surfaces captions), close with a soft CTA (e.g. 'link in bio'). Distinct from the spoken script, the YouTube description, and the TikTok caption -- not a copy-paste of either.",
    },
    hashtags: { type: "array", items: { type: "string" }, description: "Hashtags without the # prefix, usable across all three platforms." },
    disclosureCta: {
      type: ["string", "null"],
      description:
        "An optional short disclosure or call-to-action line (e.g. crediting example/demo data, or a soft 'link in bio' style close) -- null when the video genuinely doesn't need one, never fabricated to fill the field.",
    },
    youtubeThumbnailConcept: {
      type: "string",
      description: "YouTube Shorts thumbnail concept: one bold text overlay (under 6 words, high contrast, readable at thumbnail size) + one sentence describing the visual (e.g. 'split screen of a blown account vs a journal entry', 'trader at desk looking frustrated'). Must make someone stop scrolling.",
    },
  },
  required: ["hook", "script", "shotList", "youtubeTitle", "youtubeDescription", "tiktokCaption", "instagramCaption", "hashtags", "disclosureCta", "youtubeThumbnailConcept"],
};

interface VideoScriptToolInput {
  hook: string;
  script: string;
  shotList: string[];
  youtubeTitle: string;
  youtubeDescription: string;
  tiktokCaption: string;
  instagramCaption: string;
  hashtags: string[];
  disclosureCta: string | null;
  youtubeThumbnailConcept: string;
}

export interface VideoScript {
  hook: string;
  script: string;
  shotList: string[];
  /** YouTube Shorts video title -- see VIDEO_SCRIPT_SCHEMA's own description. */
  youtubeTitle: string;
  /** YouTube Shorts description text, distinct from both the spoken script and the TikTok caption. */
  youtubeDescription: string;
  /** TikTok caption text, distinct from both the spoken script and the YouTube description. */
  tiktokCaption: string;
  /** Instagram Reels caption text, distinct from the TikTok caption and YouTube description -- see VIDEO_SCRIPT_SCHEMA's own description for how it differs from TikTok's. */
  instagramCaption: string;
  hashtags: string[];
  /** Null when genuinely not needed -- never a fabricated filler line. */
  disclosureCta: string | null;
  /** YouTube thumbnail concept: bold text overlay + one-sentence visual description. */
  youtubeThumbnailConcept: string;
  /**
   * Present only when this script was generated for a specific verified
   * ScenePlan (see motionCatalog.ts's MOTION_CONCEPT_REF_PREFIX /
   * buildVideoScriptFromScenePlan) -- undefined/null for every ordinary
   * LLM-drafted script (free topic or existing opportunity). A render-time
   * consumer treats this as the ONLY valid authorization to use that
   * plan's verified motion; a coincidental matching hook is never enough
   * (see scripts/video-factory/motionCatalog.ts's resolveMotionScenePlan).
   */
  motionScenePlan?: { scenePlanId: string; scenePlanHash: string } | null;
}

const SYSTEM_PROMPT = `You are the lead short-form video strategist and scriptwriter for Fillbook (fillbookhq.com) --
a trading journal built specifically for futures day traders and prop-firm funded accounts
(broker-agnostic trade import, futures-native P&L, prop-firm drawdown and rule tracking, AI coach).
Positioned against TradeZella and TradesViz, which are broker-agnostic and stock-first.

Your videos run on TikTok, YouTube Shorts, and Instagram Reels. The goal of every video is to drive traders to
fillbookhq.com to sign up -- but the method is earning that visit by being genuinely useful, not
by selling. A trader who learns something real from a Fillbook video trusts the brand and clicks.
A trader who gets a sales pitch scrolls past.

QUALITY BAR -- every output must clear this:
- Hook: must stop a mid-scroll in 1-2 seconds. Use a named mistake, a concrete mechanism, or an
  unexpected-but-true observation -- not a rhetorical question, not "here's the thing", not a vague
  promise. The best hooks feel like a secret a real trader would actually want to know.
  A specific NUMBER is only allowed in the hook when it comes directly from the Verified knowledge
  section given to you -- never invent one, even a plausible-sounding one, just because a number
  makes a stronger hook. This is a confirmed, repeated real failure: nearly every "trading journal"
  topic hook has failed review for opening with a fabricated statistic presented as fact --
  "Ninety percent of prop-firm breaches happen to traders who never kept a journal," "traders who
  review daily cut losing streaks 2x faster," "traders who review daily spot pattern errors 2x
  faster" -- all invented, all auto-failed by every reviewer for violating the grounding rules below.
  If a journal/routine/review-benefit topic has no real number to draw on, the hook is a named
  mistake or mechanism instead, e.g. "Copy-trading five funded accounts means one mistake gets made
  five times" or "Your loss limit doesn't care that the trade was a good one" -- not "X% of traders
  who don't journal repeat the same mistake."
- Build every hook fresh for THIS topic. The request lists RECENT VIDEOS: never reuse or echo any of
  those openings, and never open with "You already know...". Our best-performing videos so far were
  about one specific prop-firm rule or mechanic with a surprising consequence (copy-trading several
  accounts against drawdown rules, inconsistent position sizing, the two drawdown numbers a prop firm
  tracks). The weakest were generic "a journal remembers your mistakes" hooks. Prefer a concrete rule,
  mechanic or scenario plus its consequence, without inventing a statistic.
- THE FIRST SECOND (owner analytics, 2026-09-21): on our published videos viewers watched about 2 seconds
  of 24 on average, only 1-2% watched to the end, and most left at second one. Distribution was fine (99%
  of views came from the For You feed); the opening lost them. So the opening is the whole job:
    * The first sentence of the hook is 10 words or fewer, and its first three words are the most
      specific thing in the video: a named prop-firm rule or mechanic (trailing drawdown, the consistency
      rule, the payout threshold, the daily loss limit) or a concrete consequence. Never open on a
      general observation about the viewer's habits, and never on a lead-in ("Most traders...", "Did you
      know...", "Have you...", "Here's...", "Let's...", "Imagine...", "In this video...", "What if...").
    * Open a loop: state the consequence or the surprising fact first and hold back the reason. The
      reason arrives in the second sentence, inside the first 3-4 seconds.
    * No warm-up, no greeting, no setup. The very first word is the point.
    * Shot 1 of the shot list is what fills the screen at 0:00, so it must be a concrete, specific
      visual: a Fillbook screen with example data showing a rule alert or a number, or a large on-screen
      rule name or figure. Never a generic stock scene of a trader at a desk, and never a plain text card
      of the hook line.
- Script: the exact words someone speaks aloud or feeds to a TTS voice. Tight, punchy, real.
  No filler sentences. No corporate SaaS language. Never use these phrases (they will auto-fail
  review): "at the end of the day", "when it comes to", "game changer", "game-changer",
  "unlock your potential", "take it to the next level", "in this day and age",
  "it's important to note that", "don't miss out", "act now", "limited time", "last chance".
  Never open with "let's dive in", "have you ever wondered", "picture this",
  "in today's fast-paced", or "in the world of". Sound like the smartest trader in the room explaining something
  to a peer, not a brand account talking at a prospect.
- LENGTH: the script is 45-75 words, hard maximum 100 (about 18-34 seconds spoken). Short videos
  get watched to the end, and completion rate is the strongest TikTok ranking signal. Cut any
  sentence that doesn't earn its place; one idea, one payoff.
- LOOP ENDING: the final sentence must flow straight back into the hook, so the video replays
  seamlessly when it restarts -- rewatches are another strong ranking signal. Write the last line
  so it reads as the beginning of the hook's sentence or thought (e.g. hook "Your loss limit
  doesn't care that the trade was a good one" -> final line "...and that's exactly why" / "Because"),
  never a sign-off, never "thanks for watching", never a standalone conclusion. Mention
  Fillbook and fillbookhq.com once, naturally, in the middle-to-late body where it is relevant
  (never as the last line) -- the video ends on the loop, not on a brand card. EXCEPTION: when the
  opportunity itself is about a specific Fillbook feature or how to use one (a product-demo or
  how-to topic, not a general trading-education topic), Fillbook is the subject of the video, not a
  single incidental mention -- name it throughout wherever the feature itself is being described,
  and let the shot list show the actual UI doing the thing being described. The one-mention rule
  above is for general education/psychology topics where Fillbook is a supporting point, not the
  topic.
- Shot list: filmable with a phone + screen recorder + basic title cards. 8-12 entries -- one
  per script beat of roughly 2-3 seconds, because the visuals should change that often. Show
  Fillbook UI where it is genuinely relevant -- always labeled example/demo data.
- Capitalization and grammar (owner rule): the hook, script, titles, descriptions and captions all use
  proper capitalization and grammar. Every sentence starts with a capital letter, "I" is capitalized,
  punctuation is correct, and sentences are complete. Never write in all lowercase.
- No em dashes or en dashes anywhere (hook, script, titles, descriptions, captions). Use a period or a
  comma. Do not use "--" as a stand-in either.
- Any trial claim must match the verified knowledge exactly: a 14-day free trial, no card required, and no
  permanent free plan afterwards. Never invent trial terms or a different length, and never promise features
  during the trial that the verified knowledge says need a paid plan. Saying "free trial" is fine when it is
  accurate; leaving the trial out and just pointing to fillbookhq.com is fine too.
- YouTube title (owner analytics 2026-09-21: 36% of our YouTube views come from YouTube SEARCH, and the
  titles that name a specific prop-firm rule or comparison are the ones that get found, e.g. a
  "static vs trailing drawdown" explainer or a "funded trader drawdown rules" video; our only
  first-person title, "I Blew a Funded Account Over ONE Number...", had the lowest watch rate):
    * Write it the way a trader would type it into search. Put the specific rule, mechanic or comparison
      in the first three words (trailing drawdown, static vs trailing drawdown, consistency rule,
      payout rules, daily loss limit), then the useful angle.
    * Prefer a plain explainer shape: "X vs Y: ...", "How X works for funded traders", "X explained",
      "Why X ...". A title that could sit on any trading video ("Why traders break their rules") is too generic.
    * Under 70 characters. Never first-person ("I", "My"), no emoji, no ALL CAPS words, no stacked
      punctuation, no clickbait or fake urgency. Do not name a specific prop firm unless the topic itself does.
    * The title must describe what the video actually teaches, so a viewer who searched it gets what they came for.
- YouTube description: 3-5 sentences. Expand the hook, name the specific problem Fillbook solves,
  close with a clear CTA pointing to fillbookhq.com. Distinct from the spoken script and the
  TikTok caption.
- TikTok caption: 2-3 lines, platform-native voice, punchy. Name the pain or insight in line 1,
  deliver the value angle in line 2, close with a soft CTA ("link in bio" or similar) in line 3.
  Distinct from both the spoken script and the YouTube description.
- Instagram caption: same punchy hook-first opening as the TikTok caption, but 3-5 lines --
  Instagram captions are read more (and indexed by Instagram's own search), so add one more real
  sentence of value/context after the hook before the CTA. Not a copy-paste of the TikTok caption;
  distinct wording, same underlying insight.
- Hashtags: 5-8 relevant tags, no stuffing, no irrelevant trending tags.
- YouTube thumbnail concept: one bold text overlay (under 6 words, readable at thumbnail size)
  plus one sentence describing the background visual. The thumbnail alone should make someone stop
  and wonder what the video says. Think contrast, specificity, genuine curiosity -- not shock.
- disclosureCta: a short disclosure or soft close when genuinely needed (e.g. crediting example
  data). Return null when it would just be filler.

GROUNDING RULES:
- Ground every factual claim about Fillbook ONLY in the "Verified knowledge" section you are given.
  Never invent a feature, stat, or capability that is not listed there.
- HARD RULE, auto-fails review every time: never write the script (or hook, or any other field) as
  a first-person trader telling their OWN trading story -- no "my funded account", "when I blew my
  account", "my drawdown", "I started journaling and", or any other framing that implies Fillbook or
  its creator personally trades or has personal results. This applies even when the opportunity topic
  is about routines, discipline, redemption, or "how I..." -- rewrite those as a general/observational
  or second-person ("you"/"traders who...") framing instead, e.g. "Traders who journal their setups
  catch this pattern in a week" NOT "I didn't catch this pattern until I'd blown two accounts."
  Fillbook is a product speaking about traders in general or to the viewer directly -- never a trader
  speaking about themselves.
- Any on-screen trading data must be clearly labeled example/demo data unless the opportunity's own
  evidence is explicitly real, consented user data.
- Never state an unverified quantitative or comparative claim as flat fact (e.g. "X causes more
  breaches than Y", "most traders do X", "traders who journal have a 63% lower breach rate", "90% of
  prop-firm breaches happen to traders who never kept a journal", "cut losing streaks 2x faster"). If
  the Verified knowledge section doesn't contain the exact number or comparison, do not state a
  number at all -- hedge it into a qualitative observation instead ("journaling makes this pattern
  easier to catch"), never a plausible-sounding invented statistic. This is the single most common
  real review failure across every video topic that touches journaling, review habits, or discipline
  -- treat any number in a draft hook as a bug unless you can point to exactly where in the Verified
  knowledge section it came from.

Submit your result via the submit_video_script tool.`;

/**
 * Generates a real, shootable production package (hook/script/shot
 * list/caption/hashtags) for one video, the same "invent once, review
 * downstream" shape as contentWriter.draftContent -- everything after
 * this (ContentQualityGate, the nine deep-review agents) reviews this
 * step's output rather than replacing the grounding it should already
 * have done.
 *
 * Deliberately does NOT render anything -- no TTS call, no ffmpeg, no
 * video file. Vercel's serverless functions have execution-time and
 * disk limits unsuited to video rendering (see docs/PROGRESS_LEDGER.md's
 * Video Factory entry); this stops at the script/shot-list/caption the
 * owner needs to actually shoot and render the video themselves, or feed
 * into a separate rendering environment later.
 */
export async function draftVideoScript(
  client: LlmClient,
  opportunity: { title: string; rationale: string },
  brandRulesSummary: string,
  verifiedKnowledgeSummary: string,
  recentVideos: readonly RecentVideo[] = [],
): Promise<VideoScript> {
  const recentSection = formatRecentVideos(recentVideos);
  const userMessage = [
    `Opportunity: ${opportunity.title}`,
    `Rationale: ${opportunity.rationale}`,
    "",
    "Brand rules:",
    brandRulesSummary,
    "",
    "Verified knowledge (use ONLY these facts about Fillbook -- do not invent anything else):",
    verifiedKnowledgeSummary,
    recentSection ? "" : null,
    recentSection || null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const call = (message: string) =>
    client.callTool<VideoScriptToolInput>(SYSTEM_PROMPT, message, "submit_video_script", VIDEO_SCRIPT_SCHEMA, 45_000, 4096);

  let result = await call(userMessage);
  let words = countSpokenWords(result.script);
  if (words > MAX_SCRIPT_WORDS) {
    // The length rule in the prompt is only a request -- a model can exceed
    // it (a 90+ word script renders as a ~31s video, past the ~25s target that
    // holds completion rate). Send it back for a shorter rewrite, escalating
    // if one pass isn't enough to also protect the hook, loop ending, and beat count.
    result = await shortenScript(result, userMessage, words, call);
    words = countSpokenWords(result.script);
  }

  // Owner rules for everything a viewer reads or hears: proper capitalization and grammar (2026-09-20) and no
  // em or en dashes (2026-09-21). Every problem found is named in ONE rewrite;
  // if a problem is still there after it the script is kept rather than failing the whole request, since
  // the owner reviews it before it is rendered.
  const copyProblems = videoCopyProblems(result);
  if (copyProblems.length > 0) {
    result = await call(
      [
        userMessage,
        "",
        "COPY FIX REQUIRED: your previous package had these problems:",
        ...copyProblems.map((problem) => `- The ${problem.field} ${problem.reason}.`),
        "Rewrite the whole package and fix every one of them: proper capitalization and grammar (every sentence starts with a capital letter, \"I\" is capitalized), and no em or en dashes anywhere (use a period or a comma). Where the problem is the hook's opening or the first shot, follow the FIRST SECOND rules: a first sentence of 10 words or fewer whose first three words are the specific rule or consequence, the reason held back for the second sentence, and shot 1 a concrete on-screen visual. Keep the content, the loop ending and the script within the length limit.",
      ].join("\n"),
    );
    words = countSpokenWords(result.script);
    if (words > MAX_SCRIPT_WORDS) result = await shortenScript(result, userMessage, words, call);
    words = countSpokenWords(result.script);
  }

  // The prompt asks for a fresh hook, but a model can still fall back on an opening it has
  // used before. Send a repeat back with the offending hook named, and give up (rather than
  // publish a repeat) if it still comes back the same.
  const recentHooks = recentVideos.map((video) => video.hook);
  for (let attempt = 1; ; attempt++) {
    const repeated = findRepeatedHook(result.hook, recentHooks);
    if (!repeated) return result;
    if (attempt > MAX_HOOK_REWRITES) throw new VideoHookRepeatError(result.hook, repeated);
    result = await call(
      [
        userMessage,
        "",
        "HOOK REPEATS A RECENT VIDEO -- REWRITE REQUIRED:",
        `Your hook: ${result.hook}`,
        `Recent hook it repeats: ${repeated}`,
        "Write the whole package again with a different opening, a different mechanic or consequence for this topic, and a loop ending that flows into the NEW hook. Keep the script within the length limit.",
      ].join("\n"),
    );
    words = countSpokenWords(result.script);
    if (words > MAX_SCRIPT_WORDS) result = await shortenScript(result, userMessage, words, call);
    words = countSpokenWords(result.script);
  }
}

/**
 * Sends the script back for a shorter rewrite, escalating the ask across up to
 * MAX_SCRIPT_REWRITES attempts. A single pass often undershoots the cut because it
 * also has to protect the hook, loop ending, and shot-list beat count, so this keeps
 * trying with a harder instruction rather than giving up on the first miss.
 */
async function shortenScript(
  result: VideoScriptToolInput,
  userMessage: string,
  words: number,
  call: (message: string) => Promise<VideoScriptToolInput>,
): Promise<VideoScriptToolInput> {
  for (let attempt = 1; attempt <= MAX_SCRIPT_REWRITES; attempt++) {
    const over = words - MAX_SCRIPT_WORDS;
    const retryMessage = [
      userMessage,
      "",
      `LENGTH FIX REQUIRED: your previous script was ${words} words, ${over} over the hard maximum of ${MAX_SCRIPT_WORDS}. The target is 45-75.`,
      "Previous script:",
      result.script,
      "",
      attempt === 1
        ? "Rewrite the whole package with a shorter script: cut sentences, not the idea. Keep the hook and the loop ending (the last line flows back into the hook), and keep 8-12 shot-list beats that match the shorter script."
        : "Cut harder this time: drop a full sentence or shot-list beat rather than trimming words within one. Keep the hook and the loop ending, and keep the shot list matched to the shorter script.",
    ].join("\n");
    result = await call(retryMessage);
    words = countSpokenWords(result.script);
    if (words <= MAX_SCRIPT_WORDS) return result;
  }
  throw new VideoScriptTooLongError(words);
}

/** The viewer-facing text fields of a script package, in the order a viewer meets them. Hashtags are not prose and are left out. */
function viewerFacingFields(video: VideoScript): Array<[string, unknown]> {
  return [
    ["hook", video.hook],
    ["script", video.script],
    ["YouTube title", video.youtubeTitle],
    ["YouTube description", video.youtubeDescription],
    ["TikTok caption", video.tiktokCaption],
    ["Instagram caption", video.instagramCaption],
  ];
}

/** The first viewer-facing field of a script package that breaks the proper-capitalization rule, or null. */
export function videoCapitalizationProblem(video: VideoScript): { field: string; reason: string } | null {
  for (const [field, text] of viewerFacingFields(video)) {
    // A field the model left out is a schema problem, not a capitalization one.
    if (typeof text !== "string") continue;
    const problem = capitalizationProblem(text);
    if (problem) return { field, reason: problem.reason };
  }
  return null;
}

/**
 * Every copy problem in a script package's viewer-facing text: capitalization and em or en dashes. One entry
 * per field per kind of problem, so a single rewrite can be told about all of them.
 */
export function videoCopyProblems(video: VideoScript): Array<{ field: string; reason: string }> {
  const problems: Array<{ field: string; reason: string }> = [];
  for (const [field, text] of viewerFacingFields(video)) {
    if (typeof text !== "string") continue;
    for (const problem of [capitalizationProblem(text), dashProblem(text)]) {
      if (problem) problems.push({ field, reason: problem.reason });
    }
  }
  problems.push(...hookOpeningProblems(video));
  problems.push(...youtubeTitleProblems(video));
  return problems;
}

/**
 * Clear-cut YouTube title problems (owner analytics 2026-09-21: a third of YouTube views come from search, and the one
 * first-person, all-caps, emoji-style title had the lowest watch rate). Whether a title is well-optimized is still
 * the writer prompt's job; this only catches what is plainly wrong. Same one-rewrite handling as the other copy rules.
 */
/** Real trading acronyms that are correctly written in capitals, so they never count as shouting. */
const TITLE_ACRONYM_ALLOWLIST = new Set(["MNQ", "MES", "MGC", "MCL", "ICT", "FOMC", "CPI", "ATR", "RSI", "EOD", "PDT", "USD", "EMA", "VWAP", "MAE", "MFE", "CME", "NFA", "CFTC", "SEC", "IRS", "ETF"]);

export function youtubeTitleProblems(video: VideoScript): Array<{ field: string; reason: string }> {
  const title = video.youtubeTitle;
  if (typeof title !== "string" || !title.trim()) return [];
  const problems: Array<{ field: string; reason: string }> = [];
  if (title.trim().length > 70) problems.push({ field: "YouTube title", reason: `is ${title.trim().length} characters; it must be under 70` });
  if (/^\s*(i|i'm|i've|my)\b/i.test(title)) problems.push({ field: "YouTube title", reason: "is written in the first person; write it as a search-style explainer instead" });
  if (/\p{Extended_Pictographic}/u.test(title)) problems.push({ field: "YouTube title", reason: "contains an emoji" });
  // Owner rule (2026-09-26): hashtags belong in the description and captions, never the title.
  if (/#[\p{L}\p{N}_]/u.test(title)) problems.push({ field: "YouTube title", reason: "contains a hashtag; keep hashtags out of the title" });
  const shouted = (title.match(/\b[A-Z]{3,}\b/g) ?? []).filter((word) => !TITLE_ACRONYM_ALLOWLIST.has(word));
  if (shouted.length > 0) problems.push({ field: "YouTube title", reason: `contains an ALL CAPS word (${shouted[0]})` });
  return problems;
}

/** Lead-ins that give a scrolling viewer no reason to stay for the next second. */
const WEAK_HOOK_OPENERS = /^\s*(most|many|some)\s+(traders|people|funded)\b|^\s*(have you|did you know|do you|are you|what if|imagine|picture|let'?s|here'?s|here is|today|in this video|want to|ever wonder|so\b|okay\b|hey\b|hi\b|welcome)|^\s*you already know\b/i;
/** Words in a first shot that make it a specific, concrete visual rather than filler. */
const CONCRETE_SHOT = /\d|fillbook ui|screen|screenshot|alert|breach|drawdown|dashboard|daily loss|consistency|payout|threshold|balance|limit|rule/i;
/** A first shot that is only a plain text card or generic stock scene. */
const GENERIC_FIRST_SHOT = /^\s*(text|title) card\b(?![^.]*\b(rule|drawdown|limit|payout|consistency)\b)|trader (at|sitting|working)|person (at|typing|working)|generic|stock (footage|clip) of/i;

/** Number of spoken words in the first sentence of a hook. */
function firstSentenceWords(hook: string): number {
  const first = hook.split(/(?<=[.!?])\s+/)[0] ?? hook;
  return countSpokenWords(first);
}

/**
 * Retention problems in how a script opens (owner analytics 2026-09-21: average watch time was about 2 seconds
 * of 24 and most viewers left at second one). Only the clear-cut cases, since whether a hook is good is still
 * a judgment call for the writer prompt: a long first sentence, a lead-in opener, and a first shot that is
 * generic filler. Same one-rewrite handling as the capitalization and dash problems.
 */
export function hookOpeningProblems(video: VideoScript): Array<{ field: string; reason: string }> {
  const problems: Array<{ field: string; reason: string }> = [];
  if (typeof video.hook === "string" && video.hook.trim()) {
    const words = firstSentenceWords(video.hook);
    if (words > 10) {
      problems.push({ field: "hook", reason: `has a first sentence of ${words} words; it must be 10 or fewer so the point lands inside the first two seconds` });
    }
    if (WEAK_HOOK_OPENERS.test(video.hook)) {
      problems.push({ field: "hook", reason: "opens with a lead-in or a general observation instead of the specific rule or consequence in its first three words" });
    }
  }
  const firstShot = Array.isArray(video.shotList) ? video.shotList[0] : undefined;
  if (typeof firstShot === "string" && (GENERIC_FIRST_SHOT.test(firstShot) || !CONCRETE_SHOT.test(firstShot))) {
    problems.push({ field: "first shot", reason: "is generic filler or a plain text card; the first frame must be a concrete visual such as a Fillbook screen with example data showing a rule alert or a number" });
  }
  return problems;
}

/** How many times a repeated hook is sent back before the request fails instead. */
export const MAX_HOOK_REWRITES = 2;

export class VideoHookRepeatError extends Error {
  constructor(
    public readonly hook: string,
    public readonly repeatedHook: string,
  ) {
    super(`Video hook still repeats a recent video after ${MAX_HOOK_REWRITES} rewrites ("${hook}" vs "${repeatedHook}"). Not queuing it -- try the request again or pick a different topic.`);
    this.name = "VideoHookRepeatError";
  }
}

/** Hard ceiling on spoken words (~34s at the render's +8% pace); the prompt asks for 45-75. */
export const MAX_SCRIPT_WORDS = 100;

/** How many times an over-length script is sent back for a shorter rewrite before the request fails instead. */
export const MAX_SCRIPT_REWRITES = 2;

export class VideoScriptTooLongError extends Error {
  constructor(public readonly words: number) {
    super(`Video script is ${words} words after ${MAX_SCRIPT_REWRITES} rewrites; the maximum is ${MAX_SCRIPT_WORDS}. Not queuing it -- a script this long renders past the target length.`);
    this.name = "VideoScriptTooLongError";
  }
}

/** Whitespace-separated tokens that contain a letter or digit (a stray "--" or "&" isn't a spoken word). */
export function countSpokenWords(script: string): number {
  return script.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/**
 * The recording version of a concept carries internal markers in its title and topic ("(screen recording)", "(shown on the real
 * screen recording)") so the app can tell it from its card twin (it tracks a concept as made by its title). They are labels for
 * the app, not words for viewers: strip them from every piece of text the owner copies into a post.
 */
export function publicConceptText(text: string): string {
  return text.replace(/\s*\((?:shown on the real )?screen recording\)/gi, "").trim();
}

/**
 * Builds a full VideoScript DIRECTLY from a verified ScenePlan
 * (src/shortform/pilots.ts) -- no LLM call at all, so a request for a
 * supported motion concept costs nothing to draft (only the existing
 * mechanical gate + nine-agent deep review, run exactly like any other
 * script, still apply -- see campaignPipeline.ts). `script` is the
 * concatenation of every scene's own real narration (so the review agents
 * read and judge the ACTUAL words the video will speak, not a paraphrase),
 * and `motionScenePlan` embeds the plan's id and a content hash of its
 * hook/scenes/claims at THIS moment -- the render worker recomputes that
 * hash from whatever pilots.ts says at render time and refuses to render
 * on any mismatch (see motionCatalog.ts's resolveMotionScenePlan), so an
 * approval can never be silently honored against stale or substituted
 * content.
 */
export function buildVideoScriptFromScenePlan(plan: ScenePlan): VideoScript {
  const title = publicConceptText(plan.title);
  const topic = publicConceptText(plan.topic);
  const script = plan.scenes.map((s) => s.narration).join(" ");
  const shotList = plan.scenes.map((s) => s.headline || s.captionText || s.sceneId);
  const disclosureCta = plan.scenes.find((s) => s.disclosure)?.disclosure ?? null;
  const hashtags = ["FuturesTrading", "PropFirmTrading", "TradingJournal"];
  return {
    hook: plan.hook,
    script,
    shotList,
    youtubeTitle: title,
    // Plain about what the numbers are: a sample account's demo data, shown inside a trading journal -- never "real" results.
    youtubeDescription: `${topic}. Every number shown is demo data from a sample Fillbook account, not a real trader's results. Fillbook is a trading journal: log your own trades and check them against your own rules. ${OFFICIAL_HANDLE}`,
    tiktokCaption: `${plan.hook} Demo account data. ${OFFICIAL_HANDLE}`,
    instagramCaption: `${plan.hook} ${topic}. Demo data from a sample account, not a real trader. ${OFFICIAL_HANDLE}`,
    hashtags,
    disclosureCta,
    youtubeThumbnailConcept: `${plan.hook} -- bold text overlay over the plan's own opening scene visual.`,
    motionScenePlan: { scenePlanId: plan.planId, scenePlanHash: computeScenePlanHash(plan) },
  };
}

/**
 * Flattens a VideoScript into one readable text block so it can flow
 * through the existing text-shaped pipeline unmodified -- ContentQualityGate,
 * the review agents, and content_versions.body all operate on a single
 * string, and nothing about that needs to change for video content. The
 * owner reads this same block in the Approvals screen to actually shoot
 * and render the video (see docs/VIDEO_FACTORY.md).
 */
export function formatVideoScriptAsText(video: VideoScript): string {
  const shots = video.shotList.map((shot, i) => `${i + 1}. ${shot}`).join("\n");
  const hashtags = video.hashtags.map((h) => `#${h}`).join(" ");
  return [
    `HOOK: ${video.hook}`,
    "",
    "SCRIPT:",
    video.script,
    "",
    "SHOT LIST:",
    shots,
    "",
    "YOUTUBE TITLE:",
    video.youtubeTitle,
    "",
    "YOUTUBE THUMBNAIL CONCEPT:",
    video.youtubeThumbnailConcept,
    "",
    "YOUTUBE DESCRIPTION:",
    video.youtubeDescription,
    "",
    "TIKTOK CAPTION:",
    video.tiktokCaption,
    "",
    "INSTAGRAM CAPTION:",
    video.instagramCaption,
    "",
    `HASHTAGS: ${hashtags}`,
    ...(video.disclosureCta ? ["", `DISCLOSURE/CTA: ${video.disclosureCta}`] : []),
  ].join("\n");
}
