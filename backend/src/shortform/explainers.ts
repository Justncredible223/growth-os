import { FRESH_PILOTS } from "./freshConcepts.js";
import { FRESH2_PILOTS } from "./freshConcepts2.js";
import type { Claim, SceneSpec, ScenePlan } from "./types.js";

/**
 * Explainers (owner decision, 2026-10-17): 30 videos of about 30-45 seconds that teach ONE rule each, replacing the 11-13 second
 * clips in the daily order.
 *
 * Why: on TikTok the hook-first clips doubled average watch time (1.67 s to 3.26 s) but views stayed near 120, because an
 * 11-second clip of app screens gives a stranger nothing to stay for. On YouTube, the Shorts that ever passed 400 views were
 * explainers people searched for. An explainer gives the viewer something to learn by staying.
 *
 * Shape (9 beats): the verified example's hook, first figure and "but" (beats 1-3, a product mock drawn from a recording's facts,
 * hook-first), then four teaching beats on plain text cards (what the rule is, why it matters, the trap, what to check), then the
 * example's product line and its closing question with the invitation (beats 8-9).
 *
 * The example beats are the source concept's own scenes, re-identified, so every figure keeps the evidence it was verified with. The
 * teaching beats are general and carry no figures from any account: they explain a rule, they never describe the viewer, promise a
 * result or say what to trade. Each teaching line is ONE spoken sentence, so a single ElevenLabs recording per video cuts cleanly at
 * the pauses between beats (scripts/splitVoiceRecordings.ts).
 */
export const EXPLAINER_SERIES = "Explained";
/** The ElevenLabs voice the explainers are recorded in (owner: a female voice, "the best one"; chosen 2026-10-17 as the most-used American female narration voice in the library). */
export const EXPLAINER_VOICE = "Jessica Anne Bogart - A VO Professional; now cloned!";
/** A teaching card holds about this long before the real narration length replaces it. */
export const TEACH_SECONDS = 4.5;

export interface TeachBeat {
  /** Up to 7 words and 34 characters (a text-only payoff card). */
  headline: string;
  /** Up to 110 characters. */
  caption: string;
  /** One spoken sentence. */
  say: string;
  take: string;
}

export interface ExplainerInput {
  slug: string;
  /** The verified concept whose example beats this explainer uses (a hook-first product mock). */
  source: string;
  title: string;
  topic: string;
  /** What the rule is, why it matters, the trap, what to check. */
  teach: [TeachBeat, TeachBeat, TeachBeat, TeachBeat];
  /**
   * A new opening card in place of the example's hook. Required when the example's short clip has already been posted: the same
   * hook would make the explainer a near-copy of a made video (conceptVariety.ts), and a follower has already seen that opening.
   */
  hook?: TeachBeat;
}

const SOURCES = new Map([...FRESH_PILOTS, ...FRESH2_PILOTS].map((p) => [p.planId, p] as const));

function retag(scene: SceneSpec, variationId: string, sceneId: string): SceneSpec {
  return {
    ...scene,
    sceneId,
    variationId,
    claims: scene.claims.map((c): Claim => ({ ...c, id: `${sceneId}-${c.id.split("-").pop()}` })),
  };
}

/** The label above each teaching card's headline, in order. */
export const TEACH_STEPS = ["The rule", "Why it matters", "The trap", "What to check"] as const;

function teachScene(t: TeachBeat, variationId: string, sceneId: string, template: SceneSpec, step: string): SceneSpec {
  return {
    teach: { step },
    sceneId,
    narration: t.say,
    takeaway: t.take,
    assetId: null,
    focalRegion: null,
    crop: null,
    aspectRatio: "source",
    layout: "payoff",
    payoff: { theme: "dark", motion: "pop", leadWithWords: true },
    headline: t.headline,
    captionText: t.caption,
    durationSeconds: TEACH_SECONDS,
    transition: { type: "fade", durationSeconds: 0.15 },
    disclosure: null,
    cta: null,
    platform: "both",
    experimentId: template.experimentId,
    variationId,
    expectedTopics: template.expectedTopics,
    claims: [{ id: `${sceneId}-c1`, type: "concept", text: `Explains a general trading rule in plain words: ${t.take}`, evidence: [] }],
    masks: [],
  };
}

export function buildExplainer(n: number, input: ExplainerInput): ScenePlan {
  const source = SOURCES.get(input.source);
  if (!source) throw new Error(`Explainer "${input.slug}": source concept "${input.source}" is not a fresh concept.`);
  if (source.scenes.length !== 5) throw new Error(`Explainer "${input.slug}": source "${input.source}" has ${source.scenes.length} beats, expected 5.`);
  const id = String(n).padStart(2, "0");
  const variationId = `explain-${id}`;
  const sid = (i: number) => `${variationId}-s${i}`;
  const [hook, first, turn, product, close] = source.scenes as [SceneSpec, SceneSpec, SceneSpec, SceneSpec, SceneSpec];
  const scenes: SceneSpec[] = [
    input.hook ? teachScene(input.hook, variationId, sid(1), hook, "") : retag(hook, variationId, sid(1)),
    retag(first, variationId, sid(2)),
    retag(turn, variationId, sid(3)),
    ...input.teach.map((t, i) => teachScene(t, variationId, sid(4 + i), hook, TEACH_STEPS[i]!)),
    retag(product, variationId, sid(8)),
    retag(close, variationId, sid(9)),
  ];
  return {
    ...source,
    planId: `explain-${id}-${input.slug}`,
    title: input.title,
    series: EXPLAINER_SERIES,
    topic: input.topic,
    variationId,
    ...(input.hook ? { hook: input.hook.headline } : {}),
    scenes,
  };
}

/** True for an explainer plan. */
export function isExplainerPlan(plan: ScenePlan): boolean {
  return plan.series === EXPLAINER_SERIES;
}

/**
 * The 30, in day order. The examples not yet posted come first (days 1-21); the nine whose short versions already went out
 * (Oct 8-16) follow, so the first three weeks show no example a follower has seen.
 */
export const EXPLAINERS: readonly ExplainerInput[] = [
  {
    slug: "copy-trading-risk",
    source: "fresh-11-two-accounts-one-trade",
    title: "Copying one trade to two accounts copies the loss too",
    topic: "Copying a trade across prop accounts: the same size on each account means the same loss on each",
    teach: [
      { headline: "Copying a trade copies the risk.", caption: "The same size on two accounts is the same loss twice.", say: "Copying one trade to two accounts copies the risk as well as the reward.", take: "A copied trade carries its risk to every account." },
      { headline: "Each account has its own limit.", caption: "One loss can fit one account's room and break another's.", say: "Each account has its own loss limit, so one loss can fit one account and break another.", take: "Every account has its own room." },
      { headline: "The trap: sizing for the big one.", caption: "The account with the least room left sets a safe size.", say: "The trap is sizing for the account with the most room, when the one with the least room sets the safe size.", take: "Size for the account with the least room." },
      { headline: "Check every account first.", caption: "Look at each account's buffer and today's loss limit before copying.", say: "Before copying a trade, check each account's buffer and today's loss limit.", take: "Check each account before copying." },
    ],
  },
  {
    slug: "consistency-rule",
    source: "fresh-03-one-day-46",
    title: "The consistency rule: when your best day is too big",
    topic: "A prop firm consistency rule caps how much of the total profit one day can make",
    teach: [
      { headline: "One day can't be the whole month.", caption: "A consistency rule caps one day's share of your total profit.", say: "A consistency rule caps how much of your total profit any single day is allowed to make.", take: "A consistency rule caps one day's share of profit." },
      { headline: "Why firms use it.", caption: "It separates steady trading from one lucky day.", say: "Firms use it to tell steady trading apart from one big day that carried the account.", take: "The rule looks for steady results." },
      { headline: "The trap: one huge day.", caption: "A big win can push one day over the cap even when the account is up.", say: "The trap is one huge day, because it can push that day over the cap even while the account is profitable.", take: "A big day can break the rule." },
      { headline: "Know your cap before you scale.", caption: "Divide your best day by total profit and compare it with your firm's cap.", say: "Divide your best day by your total profit and compare it with your firm's cap.", take: "Check your best day's share against the cap." },
    ],
  },
  {
    slug: "moving-stops",
    source: "fresh-20-moved-stop",
    title: "What moving your stop loss actually costs",
    topic: "Tagging trades where the stop was moved, and what those trades added up to",
    teach: [
      { headline: "A stop is a decision made calm.", caption: "You set it before the trade, when nothing is at stake yet.", say: "A stop loss is a decision you make before the trade, while you are still calm.", take: "A stop is set before the pressure." },
      { headline: "Moving it changes the trade.", caption: "A wider stop means a bigger loss than the one you planned for.", say: "Moving it during the trade turns a planned loss into a bigger one you never sized for.", take: "A moved stop means an unplanned loss." },
      { headline: "The trap: it feels like one trade.", caption: "Each move feels small. Added up, the tag shows the real cost.", say: "The trap is that each move feels like a one-off, until the tagged trades are added up.", take: "Small moves add up." },
      { headline: "Tag every moved stop.", caption: "Tag the trade each time, then total the tag once a week.", say: "Tag each trade where you moved the stop, then total that tag once a week.", take: "Tag it, then total it." },
    ],
  },
  {
    slug: "time-of-day",
    source: "fresh-15-open-vs-late-morning",
    title: "Your best and worst time of day to trade",
    topic: "Splitting a sample account's trades by time of day: the open against late morning",
    teach: [
      { headline: "Results change by the hour.", caption: "Volume and movement differ through the session, and so do results.", say: "Markets move differently through the session, so the same setup can work at one hour and fail at another.", take: "The hour changes the result." },
      { headline: "Totals hide the weak hour.", caption: "A good month can sit on top of one hour that keeps losing.", say: "A good total can hide one hour that keeps giving back what the rest of the day made.", take: "A total hides the weak hour." },
      { headline: "The trap: trading out of boredom.", caption: "Quiet hours invite trades that were never part of the plan.", say: "The trap is staying at the screen after the move is over and trading because nothing is happening.", take: "Quiet hours invite extra trades." },
      { headline: "Split your trades by hour.", caption: "Group a month of trades by entry time and compare win rate and P&L.", say: "Group a month of your trades by entry time and compare each hour's win rate and P&L.", take: "Compare results hour by hour." },
    ],
  },
  {
    slug: "win-rate-drop",
    source: "fresh-09-win-rate-fell",
    title: "Why a win rate drops, and how to find out",
    topic: "Comparing recent trading against an account's own baseline to see what changed",
    teach: [
      { headline: "Your baseline is your normal.", caption: "Your own past results are the fairest thing to compare against.", say: "Your baseline is how you traded before, and it is the fairest thing to compare yourself against.", take: "Compare against your own past." },
      { headline: "A drop has a cause.", caption: "When the win rate falls, something in how you trade usually changed.", say: "When a win rate falls, something in how you trade has usually changed with it.", take: "A falling win rate has a cause." },
      { headline: "The trap: blaming the market.", caption: "The market changes, but so do size, timing and habits.", say: "The trap is blaming the market first, before checking whether your own size, timing or habits moved.", take: "Check your habits before the market." },
      { headline: "Compare recent with baseline.", caption: "Put the last few weeks next to your normal and look at what moved.", say: "Put your last few weeks next to your normal and look at which numbers moved together.", take: "Look at what moved together." },
    ],
  },
  {
    slug: "drawdown-vs-loss-limit",
    source: "fresh-17-690-left",
    title: "Drawdown buffer vs daily loss limit on a funded account",
    topic: "A funded account's drawdown buffer next to its daily loss limit, and which one runs out first",
    teach: [
      { headline: "Two limits, two jobs.", caption: "The buffer is room above the floor. The loss limit resets each day.", say: "A funded account has two limits: the room above the drawdown floor, and a daily loss limit that resets.", take: "Buffer and loss limit are different." },
      { headline: "The smaller one is the real limit.", caption: "Whichever runs out first ends the day or the account.", say: "Whichever of the two is smaller is the one that actually limits how much you can lose today.", take: "The smaller limit is the real one." },
      { headline: "The trap: watching only one.", caption: "A daily limit can still show room after the buffer is nearly gone.", say: "The trap is watching only the daily limit, which can still show room after the buffer is nearly gone.", take: "Watch both numbers." },
      { headline: "Check both before the open.", caption: "Write down the buffer and today's loss limit, then trade the smaller.", say: "Before the open, write down the buffer and today's loss limit, and treat the smaller one as your limit.", take: "Treat the smaller number as the limit." },
    ],
  },
  {
    slug: "one-day-carries-month",
    source: "fresh-18-one-day-1788",
    title: "When one trading day carries your whole month",
    topic: "A sample account's month where one day made almost all of the profit",
    teach: [
      { headline: "A month is many days.", caption: "The total can come from steady days or from one big one.", say: "A month's total can come from many steady days, or almost entirely from one big day.", take: "Look at where the total came from." },
      { headline: "One big day is fragile.", caption: "Remove that day and the month looks very different.", say: "When one day carries the month, taking that single day away changes the whole picture.", take: "One-day months are fragile." },
      { headline: "The trap: expecting it again.", caption: "A big day can set a size or a target that the next days chase.", say: "The trap is expecting that day again, and sizing up the next days to chase it.", take: "Don't chase the big day." },
      { headline: "Check your month without it.", caption: "Subtract your best day from the total and see what is left.", say: "Subtract your best day from the month and see what the rest of your trading made.", take: "Subtract the best day." },
    ],
  },
  {
    slug: "edge-score",
    source: "fresh-21-edge-score-67",
    title: "One score for how you trade, and what drags it down",
    topic: "An Edge Score that blends profitability, consistency, risk control and rule adherence",
    teach: [
      { headline: "P&L is one part of trading.", caption: "Profit, consistency, risk and rule-following each tell you something.", say: "Profit is only one part of how you trade, next to consistency, risk control and following your rules.", take: "Profit is one part of the picture." },
      { headline: "A blended score shows balance.", caption: "Strong rules with weak profit is a different problem from the reverse.", say: "A blended score shows whether those parts are in balance, or whether one is pulling the rest down.", take: "Look for the weakest part." },
      { headline: "The trap: fixing the strong part.", caption: "It is easier to polish what already works than to face the weak spot.", say: "The trap is working on the part that is already strong, because the weak one is less fun to look at.", take: "Work on the weakest part." },
      { headline: "Find your lowest factor.", caption: "Start with the factor that scores lowest and work on that one.", say: "Find the factor that scores lowest and make that one the focus for the next few weeks.", take: "Start with the lowest factor." },
    ],
  },
  {
    slug: "normal-trade-count",
    source: "fresh-16-six-vs-norm",
    title: "How many trades a day is normal for you?",
    topic: "A session with far more trades than the account's own normal pace",
    teach: [
      { headline: "You have a normal pace.", caption: "Your average trades per day is a baseline you can measure.", say: "Your average number of trades a day is a normal pace you can actually measure.", take: "Your pace is measurable." },
      { headline: "Busy days stand out.", caption: "A session far above that pace is worth a second look.", say: "A session far above that pace stands out, and it is worth a second look before the next one.", take: "Unusual days deserve a look." },
      { headline: "The trap: trading to win it back.", caption: "After a losing run, extra trades can feel like the fix.", say: "The trap is adding trades after a losing run to win it back, which is a possible sign of overtrading.", take: "More trades rarely undo a loss." },
      { headline: "Set a daily trade cap.", caption: "Pick a number near your normal pace and stop when you reach it.", say: "Pick a daily trade cap near your normal pace and stop for the day when you reach it.", take: "Cap trades near your normal." },
    ],
  },
  {
    slug: "weak-hour",
    source: "fresh-28-weak-hour",
    title: "The one hour of the day that loses",
    topic: "A sample account's weakest hour compared with its overall win rate",
    teach: [
      { headline: "Every hour has its own record.", caption: "Your overall win rate is an average across very different hours.", say: "Your overall win rate is an average of hours that can perform very differently.", take: "Each hour has its own record." },
      { headline: "One hour can drag the rest.", caption: "A weak hour can give back what the good hours made.", say: "One weak hour can quietly give back what the good hours made.", take: "A weak hour gives gains back." },
      { headline: "The trap: it feels random.", caption: "Losses in the same hour look random until they are grouped.", say: "The trap is that losses in the same hour feel random until you group them together.", take: "Group losses by hour." },
      { headline: "Find your weakest hour.", caption: "Sort your trades by entry hour and look at the lowest win rate.", say: "Sort your trades by entry hour and look at the hour with the lowest win rate.", take: "Sort by entry hour." },
    ],
  },
  {
    slug: "weekday-results",
    source: "fresh-22-only-monday-lost",
    title: "Which weekday is losing you money?",
    topic: "A sample account's profit by day of the week, and the one weekday that lost money",
    teach: [
      { headline: "Weekdays trade differently.", caption: "News, volume and your own routine change from day to day.", say: "Each weekday brings different news, volume and routine, so results can differ by day.", take: "Days of the week differ." },
      { headline: "A weekly total hides one day.", caption: "Four good days can cover for one day that keeps losing.", say: "A good weekly total can hide one day that keeps losing week after week.", take: "A total hides a weak day." },
      { headline: "The trap: never checking.", caption: "Without splitting by day, the pattern stays invisible.", say: "The trap is never splitting results by weekday, so the pattern never shows up.", take: "Split by weekday." },
      { headline: "Split a month by weekday.", caption: "Total each weekday's P&L over a month and compare them.", say: "Total each weekday's P&L over a month and see whether one day stands apart.", take: "Compare weekday totals." },
    ],
  },
  {
    slug: "losing-setup",
    source: "fresh-04-setup-lost-422",
    title: "A good win rate can hide a losing setup",
    topic: "A sample account's setup report: its weakest setup inside a good overall win rate",
    teach: [
      { headline: "A setup is a repeatable trade.", caption: "Grouping trades by setup shows what each pattern really does.", say: "A setup is a trade you repeat, so grouping trades by setup shows what each one really does.", take: "Group trades by setup." },
      { headline: "One setup can lose on its own.", caption: "A strong overall record can sit on top of one losing setup.", say: "A strong overall win rate can sit on top of one setup that loses money on its own.", take: "One setup can lose alone." },
      { headline: "The trap: it's a favorite.", caption: "A setup you like can keep getting taken long after it stops paying.", say: "The trap is a setup you like, which keeps getting taken long after it stopped paying.", take: "Favorites need checking too." },
      { headline: "Rank your setups by P&L.", caption: "List each setup's trades, win rate and P&L, worst first.", say: "List each setup with its trade count, win rate and P&L, and start with the worst one.", take: "Start with the worst setup." },
    ],
  },
  {
    slug: "profit-target",
    source: "fresh-30-84-percent",
    title: "How close is close to a prop firm profit target?",
    topic: "A sample funded account's progress toward its profit target, and the gap still left",
    teach: [
      { headline: "A target is a finish line.", caption: "Evaluations and payouts often need a set amount of profit first.", say: "A profit target is the amount an account has to make before a payout or a pass.", take: "A target is a set amount." },
      { headline: "The last part is the hardest.", caption: "Near the end, every trade feels like it could finish the job.", say: "The last part of a target is often the hardest, because every trade starts to feel decisive.", take: "The end of a target is tense." },
      { headline: "The trap: rushing the gap.", caption: "Sizing up to close the gap can undo weeks of progress.", say: "The trap is sizing up to close the gap faster, which can undo weeks of progress in one day.", take: "Don't rush the last stretch." },
      { headline: "Track the gap, not the dream.", caption: "Write down the amount left and your normal daily pace.", say: "Write down the amount left and your normal daily pace, and let the gap close at that pace.", take: "Close the gap at your pace." },
    ],
  },
  {
    slug: "wins-and-losses",
    source: "fresh-29-24-wins-14-losses",
    title: "Wins, losses and net: reading your monthly tally",
    topic: "A sample account's month overview: wins, losses and net P&L month to date",
    teach: [
      { headline: "Three numbers tell the month.", caption: "Wins, losses and net together show how the month was made.", say: "Wins, losses and net profit together show how a month was actually made.", take: "Read all three numbers." },
      { headline: "Losses are part of the plan.", caption: "A profitable month still has losing trades in it.", say: "Even a profitable month is full of losing trades, and that is normal.", take: "Losing trades are normal." },
      { headline: "The trap: chasing a perfect month.", caption: "Trying to avoid every loss leads to cutting winners short.", say: "The trap is trying to avoid every loss, which tends to cut winners short as well.", take: "Accept the losses." },
      { headline: "Check average win vs loss.", caption: "Compare the size of an average win with an average loss.", say: "Compare the size of your average win with your average loss, not just how many of each you had.", take: "Compare sizes, not just counts." },
    ],
  },
  {
    slug: "multiple-accounts",
    source: "fresh-23-52-vs-13",
    title: "Trading two prop accounts: which one is behind?",
    topic: "Two sample prop accounts: progress to target and account health side by side",
    teach: [
      { headline: "Each account is its own race.", caption: "Two accounts can have different targets, rules and progress.", say: "Each prop account is its own race, with its own target, rules and progress.", take: "Accounts progress separately." },
      { headline: "Health and progress differ.", caption: "An account can be further along and still be less healthy.", say: "An account can be further from its target and still be in better health than the other.", take: "Progress and health differ." },
      { headline: "The trap: one plan for both.", caption: "The same trade can be fine for one account and too big for another.", say: "The trap is running one plan for both, when the same trade can suit one account and not the other.", take: "Plan per account." },
      { headline: "Review each account weekly.", caption: "Look at target progress and health for each account on its own.", say: "Once a week, review each account's target progress and health on its own.", take: "Review accounts one by one." },
    ],
  },
  {
    slug: "payout-pace",
    source: "fresh-13-129-days",
    title: "How far is your payout at your current pace?",
    topic: "A sample payout timeline: days to payout-ready at the current daily pace",
    teach: [
      { headline: "Pace turns a target into time.", caption: "Your average daily profit tells you roughly how long a target takes.", say: "Your average daily profit turns a target into time, so you can see roughly how long it will take.", take: "Pace turns targets into time." },
      { headline: "Payouts have more than one rule.", caption: "Trading days, targets and consistency can all need to be met.", say: "A payout can need several rules met at once, like trading days, a target and consistency.", take: "Payouts need several rules." },
      { headline: "The trap: forcing the pace.", caption: "Trying to shorten the timeline usually means bigger size.", say: "The trap is trying to shorten the timeline, which usually means trading bigger than your plan.", take: "Don't force the pace." },
      { headline: "Check each payout rule.", caption: "List every rule your firm needs and where you stand on each.", say: "List every rule your firm needs for a payout and check where you stand on each one.", take: "Check every payout rule." },
    ],
  },
  {
    slug: "trading-plan-rules",
    source: "fresh-24-92-on-plan",
    title: "Following your trading plan, rule by rule",
    topic: "Checking every trading plan rule against real trades to see which one slips",
    teach: [
      { headline: "A plan is a set of rules.", caption: "Trading window, max trades and size limits are each a rule.", say: "A trading plan is a set of separate rules, like a trading window, a trade limit and a size limit.", take: "A plan is several rules." },
      { headline: "One rule usually slips first.", caption: "An overall score can look high while one rule keeps slipping.", say: "An overall plan score can look high while one rule keeps slipping underneath it.", take: "Find the rule that slips." },
      { headline: "The trap: an average hides it.", caption: "Good adherence on easy rules covers for the hard one.", say: "The trap is an average, because good marks on the easy rules cover for the hard one.", take: "Averages hide weak rules." },
      { headline: "Score each rule separately.", caption: "Check each rule against your trades and fix the lowest one first.", say: "Score each rule against your trades on its own and fix the lowest one first.", take: "Fix the lowest rule first." },
    ],
  },
  {
    slug: "near-the-target",
    source: "fresh-26-98-percent",
    title: "98% of the target is not a pass",
    topic: "A sample evaluation account near the end: ten green days and a target not yet reached",
    teach: [
      { headline: "Almost there is not there.", caption: "An evaluation counts the target as reached or not reached.", say: "An evaluation counts the target as reached or not, so almost there still means not yet.", take: "Almost there is not passed." },
      { headline: "The last day carries pressure.", caption: "Close to the line, one trade can feel like the whole evaluation.", say: "Close to the line, one trade starts to feel like the whole evaluation.", take: "The last trades feel heavier." },
      { headline: "The trap: a big final trade.", caption: "Going big to finish can turn a near pass into a loss.", say: "The trap is one big final trade to finish it, which can turn a near pass into a step back.", take: "Don't size up to finish." },
      { headline: "Trade the last day normally.", caption: "Keep your usual size and let the target come at your pace.", say: "Keep your usual size on the final days and let the target arrive at your normal pace.", take: "Keep your usual size." },
    ],
  },
  {
    slug: "trailing-floor",
    source: "fresh-05-below-the-floor",
    title: "Trailing drawdown explained: how the floor moves",
    topic: "A trailing drawdown floor set by the account's peak, and an account that fell below it",
    teach: [
      { headline: "The floor follows your peak.", caption: "A trailing floor moves up with your best balance, never back down.", say: "A trailing drawdown floor follows your peak balance up, and it never comes back down.", take: "The floor follows the peak." },
      { headline: "Up money, less room.", caption: "After a big day, the floor rises and the room left can shrink.", say: "So after a big winning day the floor rises with it, and your room to lose can shrink.", take: "A big day raises the floor." },
      { headline: "The trap: watching the balance.", caption: "A balance that is up says nothing about the distance to the floor.", say: "The trap is watching the balance, which can be up while the distance to the floor is small.", take: "Watch the distance to the floor." },
      { headline: "Know your floor every morning.", caption: "Write down where the floor is and how far the balance is above it.", say: "Every morning, write down where the floor is and how far your balance sits above it.", take: "Check the floor daily." },
    ],
  },
  {
    slug: "busy-days",
    source: "fresh-25-overtrading-days-17",
    title: "Do your busiest trading days help or hurt?",
    topic: "Flagged overtrading days, baseline against recent, and the win rate beside them",
    teach: [
      { headline: "Busy days can be flagged.", caption: "Days far above your normal trade count can be flagged for review.", say: "A day far above your normal trade count can be flagged as a possible overtrading day.", take: "Unusually busy days get flagged." },
      { headline: "Watch the trend, not one day.", caption: "A rising share of busy days says more than any single session.", say: "A rising share of flagged days says more than any single busy session.", take: "Watch the share over time." },
      { headline: "The trap: busy feels productive.", caption: "More trades can feel like more effort, not more risk.", say: "The trap is that a busy day feels productive, even when the extra trades add risk.", take: "Busy is not productive." },
      { headline: "Compare busy days with normal.", caption: "Put the win rate of flagged days next to your normal days.", say: "Put the win rate of your flagged days next to your normal days and compare them.", take: "Compare flagged and normal days." },
    ],
  },
  {
    slug: "best-setup-and-window",
    source: "fresh-27-48-trades-88",
    title: "Finding your best setup and your best time",
    topic: "A sample account's strongest setup and strongest trading window",
    teach: [
      { headline: "Your edge has a shape.", caption: "It usually lives in a few setups at certain times of day.", say: "An edge usually lives in a few setups, traded at certain times of the day.", take: "An edge has setups and times." },
      { headline: "Sample size matters.", caption: "A high win rate over many trades says more than over a few.", say: "A strong win rate over many trades tells you more than the same rate over a handful.", take: "More trades, more trust." },
      { headline: "The trap: trading everything.", caption: "Taking every pattern spreads your attention thin.", say: "The trap is taking every pattern you see, which spreads attention away from what works.", take: "Focus beats variety." },
      { headline: "Name your top setup and time.", caption: "Find the setup and window with the most trades and best results.", say: "Find the setup and time window with the most trades and the best results, and name them.", take: "Name your best setup and time." },
    ],
  },
  {
    slug: "after-a-loss",
    hook: { headline: "A loss. Then size up 2.5x?", caption: "The trade right after a loss is the one worth watching.", say: "Right after a loss, a 2.5x position, and that pattern is worth a look.", take: "The trade after a loss deserves attention." },
    source: "fresh-06-five-revenge",
    title: "Possible revenge trades: what to check after a loss",
    topic: "Trades opened soon after a loss at a larger size, flagged as possible revenge trades",
    teach: [
      { headline: "The trade after a loss is risky.", caption: "Right after a loss is when size and speed tend to jump.", say: "The trade right after a loss is where size and speed tend to jump.", take: "Watch the trade after a loss." },
      { headline: "Size is the tell.", caption: "A bigger position minutes after a loss is worth a review.", say: "A bigger position opened minutes after a loss is a possible revenge trade worth a review.", take: "Bigger size after a loss is a flag." },
      { headline: "The trap: making it back fast.", caption: "Winning it back quickly feels like fixing the loss.", say: "The trap is wanting the money back quickly, which makes a larger trade feel like the fix.", take: "Fast recovery adds risk." },
      { headline: "Set a pause after losses.", caption: "Decide in advance how long you wait before the next trade.", say: "Decide in advance how long you will wait after a loss before taking the next trade.", take: "Pause after a loss." },
    ],
  },
  {
    slug: "position-size-plan",
    hook: { headline: "Max 3 contracts. But 5 got traded?", caption: "A plan's size limit only works if every trade keeps to it.", say: "A plan allowed 3 contracts, but a trade used 5, so what went wrong?", take: "Size can drift past the plan." },
    source: "fresh-02-plan-said-3",
    title: "Position sizing: when the trade is bigger than the plan",
    topic: "A trade larger than the trading plan's maximum contracts",
    teach: [
      { headline: "A size limit is a plan rule.", caption: "Your plan sets the most contracts any one trade may use.", say: "A size limit is the plan rule that sets the most contracts any one trade may use.", take: "The plan sets a max size." },
      { headline: "Size sets the loss.", caption: "Two extra contracts can turn a normal loss into a big one.", say: "Size decides how big a loss gets, so a couple of extra contracts can change a whole day.", take: "Size decides the loss." },
      { headline: "The trap: confidence.", caption: "Size tends to grow on the trades that feel most certain.", say: "The trap is confidence, because size tends to grow on the trades that feel most certain.", take: "Confidence grows size." },
      { headline: "Compare size with the plan.", caption: "Check every trade's contracts against the plan's maximum.", say: "Check every trade's contract count against your plan's maximum, once a day.", take: "Check size against the plan." },
    ],
  },
  {
    slug: "would-you-take-it-again",
    hook: { headline: "84% won. The rest only 18%. Why?", caption: "A single yes or no after each trade splits your results in two.", say: "One group of trades won 84% and the rest only 18%, and one question split them.", take: "One question sorts your trades." },
    source: "fresh-07-take-it-again",
    title: "The post-trade question that finds your bad trades",
    topic: "Trades split by whether the trader would take them again, and what each group did",
    teach: [
      { headline: "Ask one question after a trade.", caption: "Would I take this exact trade again? Answer yes or no.", say: "After each trade, ask one question: would I take this exact trade again?", take: "Ask if you'd take it again." },
      { headline: "Your gut already knows.", caption: "That answer separates planned trades from impulse trades.", say: "That honest answer tends to separate your planned trades from the unplanned ones.", take: "The answer sorts your trades." },
      { headline: "The trap: judging by the result.", caption: "A lucky win on a bad trade still gets a no.", say: "The trap is judging by the result, because a lucky win on a bad trade should still get a no.", take: "Judge the decision, not the result." },
      { headline: "Compare the yes and no trades.", caption: "After a month, compare the results of each group.", say: "After a month, compare the results of your yes trades with your no trades.", take: "Compare the two groups." },
    ],
  },
  {
    slug: "two-limits",
    hook: { headline: "$1,725 of room. But only $1,000?", caption: "A prop account has two limits before the first trade of the day.", say: "There is $1,725 of room, but only $1,000 to lose today, so which one decides?", take: "Two limits, one ends the day." },
    source: "fresh-01-two-limits",
    title: "Two limits on your account: which one decides today?",
    topic: "The buffer to the drawdown floor against today's loss limit",
    teach: [
      { headline: "Two limits before the open.", caption: "Room above the floor, and a loss limit that resets each day.", say: "Before the open, a prop account has two limits: room above the floor, and today's loss limit.", take: "There are two limits." },
      { headline: "The smaller one decides.", caption: "Whichever is smaller is how much you can actually lose today.", say: "Whichever of the two is smaller is how much you can actually lose today.", take: "The smaller limit decides." },
      { headline: "The trap: reading one number.", caption: "Plenty of daily room can hide a thin buffer, and the reverse.", say: "The trap is reading just one number, when plenty of daily room can hide a thin buffer.", take: "Read both limits." },
      { headline: "Write both down each morning.", caption: "Note both limits and treat the smaller as today's stop.", say: "Each morning, note both limits and treat the smaller one as today's line.", take: "Treat the smaller as today's line." },
    ],
  },
  {
    slug: "worst-day",
    hook: { headline: "Lost $1,504 in a day. Then?", caption: "A long run of green days can be undone by one large loss.", say: "Losing $1,504 in a single day of a green month, how much does that undo?", take: "One red day can undo a month." },
    source: "fresh-12-one-red-day",
    title: "How big is your worst trading day?",
    topic: "A month of green days and the one red day that took a large share back",
    teach: [
      { headline: "Your worst day matters most.", caption: "Many green days can be undone by one large red one.", say: "Your worst day can matter more than many good ones, because one large red day can undo them.", take: "The worst day matters." },
      { headline: "Win streaks hide risk.", caption: "Long streaks make a single big loss feel impossible.", say: "A long green streak makes one big loss feel impossible, right up until it happens.", take: "Streaks hide risk." },
      { headline: "The trap: no daily stop.", caption: "Without a daily stop, a red day has no floor of its own.", say: "The trap is trading without a daily stop, so a bad day has nothing to end it.", take: "Have a daily stop." },
      { headline: "Know your worst-day size.", caption: "Compare your worst day with your average green day.", say: "Compare your worst day with your average green day and see how many good days it equals.", take: "Measure your worst day." },
    ],
  },
  {
    slug: "biggest-leak",
    hook: { headline: "A $7,571 leak. Not the setup.", caption: "A leak is a repeated cost, and it is easy to miss in the totals.", say: "The biggest leak cost $7,571, and it was not the setup.", take: "Leaks are habits." },
    source: "fresh-19-biggest-leak",
    title: "Find your biggest trading leak",
    topic: "An account's biggest leak beside its strongest setup",
    teach: [
      { headline: "A leak is a repeated cost.", caption: "It is a habit that costs money again and again.", say: "A leak is a habit that costs money again and again, not one bad trade.", take: "A leak repeats." },
      { headline: "Small trades, big total.", caption: "A leak hides in many small losses that add up.", say: "A leak usually hides in many small losses that only look large once they are added up.", take: "Leaks hide in totals." },
      { headline: "The trap: chasing new setups.", caption: "Looking for a new edge is easier than fixing a leak.", say: "The trap is hunting for a new setup, when fixing one leak can matter more.", take: "Fixing a leak can beat a new setup." },
      { headline: "Total your costs by habit.", caption: "Tag your losing trades by cause and add up each tag.", say: "Tag your losing trades by cause and add up each tag to find the biggest one.", take: "Add up each tag." },
    ],
  },
  {
    slug: "oversized-trade",
    hook: { headline: "8 contracts. Two tags. Lost $400.", caption: "A trade can carry more than one tag, and each tag is a reason to look.", say: "One trade with 8 contracts picked up two tags and lost $400.", take: "Two tags call for a review." },
    source: "fresh-10-eight-contracts",
    title: "One oversized trade: what the tags tell you",
    topic: "One trade tagged as possibly revenge and oversized, and what it cost",
    teach: [
      { headline: "Tags turn trades into data.", caption: "Labelling trades lets you count habits instead of guessing.", say: "Tagging trades turns habits into something you can count instead of guess about.", take: "Tags make habits countable." },
      { headline: "Two tags on one trade.", caption: "When a trade gets two warning tags, it is worth a review.", say: "When one trade carries two warning tags, it is worth reviewing before the next session.", take: "Two tags deserve a review." },
      { headline: "The trap: skipping the tag.", caption: "Leaving out a tag on a bad trade hides the pattern later.", say: "The trap is skipping the tag on a trade you'd rather forget, which hides the pattern later.", take: "Tag the bad trades too." },
      { headline: "Review tagged trades weekly.", caption: "Each week, look at the trades with the most tags first.", say: "Each week, review the trades that carry the most tags first.", take: "Review the most-tagged trades." },
    ],
  },
  {
    slug: "one-trade-undoes-month",
    hook: { headline: "A $3,100 day. Then a $3,060 loss?", caption: "When one trade is large enough, it can decide the month on its own.", say: "A $3,100 day, then a $3,060 loss, so what was left of the month?", take: "One trade can decide a month." },
    source: "fresh-14-won-then-lost",
    title: "Could one trade undo your month?",
    topic: "A big winning day and a big losing day that nearly cancel out",
    teach: [
      { headline: "Big days cut both ways.", caption: "The size that makes a big win can make an equal loss.", say: "The size that makes a big winning day can make an equally big losing day.", take: "Big size cuts both ways." },
      { headline: "One trade, one month.", caption: "A single trade can be the difference between up and flat.", say: "When one trade is that large, it can decide the whole month on its own.", take: "One trade can decide a month." },
      { headline: "The trap: size after a win.", caption: "A big win makes the next big size feel safe.", say: "The trap is that a big win makes the next big size feel safe.", take: "Wins make size feel safe." },
      { headline: "Cap risk per trade.", caption: "Set a maximum loss per trade as a share of your account.", say: "Set a maximum loss for any single trade, as a share of your account, and keep to it.", take: "Cap the loss per trade." },
    ],
  },
  {
    slug: "trading-window",
    hook: { headline: "Off hours lost $39. Who checks?", caption: "With your own money there is no firm checking your hours.", say: "Trades outside the planned hours lost $39 each, so who checks?", take: "Only you enforce your hours." },
    source: "fresh-08-nobody-fines",
    title: "Trading outside your planned hours",
    topic: "Trades outside the planned session against trades inside it, for a self-funded trader",
    teach: [
      { headline: "Your plan has a window.", caption: "A trading window sets the hours your plan says to trade.", say: "A trading window is the set of hours your plan says you trade, and nothing outside them.", take: "The plan has set hours." },
      { headline: "Own money, no one checks.", caption: "Without a firm's rules, only you hold yourself to the plan.", say: "With your own money there is no firm checking, so only you hold yourself to that window.", take: "Only you enforce your plan." },
      { headline: "The trap: one more trade.", caption: "Off-hours trades often start as just one more.", say: "The trap is one more trade after the window closes, which quietly becomes a habit.", take: "One more trade becomes a habit." },
      { headline: "Compare inside vs outside.", caption: "Split your trades by inside and outside the window and compare.", say: "Split your trades into inside and outside your window and compare the two results.", take: "Compare inside and outside." },
    ],
  },
];

export const EXPLAINER_PILOTS: ScenePlan[] = EXPLAINERS.map((e, i) => buildExplainer(i + 1, e));
export const EXPLAINER_ORDER: string[] = EXPLAINER_PILOTS.map((p) => p.planId);

/**
 * The 20 explainers that go out (owner decision, 2026-10-17: ten days go to the strategy videos instead). Left out: number 5 (the
 * lowest story score) and 22-30, the ones built on clips already posted. They stay resolvable but are not offered.
 */
export const EXPLAINERS_OFFERED: readonly string[] = EXPLAINER_ORDER.filter((_, i) => i !== 4 && i < 21);
