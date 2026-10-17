import type { ScenePlan } from "./types.js";

/**
 * Story scorecard: does this concept give a stranger a reason to watch to the end? Every other check in the pipeline
 * (claims, evidence, layout, safe zones) asks whether a video is CORRECT; none asked whether it is WORTH WATCHING, which
 * is how a list of four unrelated numbers reached a render (TikTok average watch time 1.3-3.0s, most viewers gone by 0:02).
 *
 * It is deterministic and cheap, so it can run on every plan before anything renders. It scores structure, not taste: a
 * high score means the concept has the parts short videos that hold viewers tend to have (a hook with stakes and a
 * number, one idea, plain words, a turn, a payoff, a loop). It cannot promise a video will be viral, and the real
 * measure stays the platforms' own retention numbers.
 */
export type StoryGrade = "A+" | "A" | "B" | "C" | "D";

export interface StoryCriterion {
  key: string;
  label: string;
  points: number;
  max: number;
  /** Why it lost points, or what earned them. */
  note: string;
}

export interface StoryScore {
  planId: string;
  score: number;
  grade: StoryGrade;
  criteria: StoryCriterion[];
  /** The weakest criteria, worst first, as plain instructions for whoever rewrites the concept. */
  fixes: string[];
}

export const STORY_GRADE_CUTOFFS: ReadonlyArray<readonly [StoryGrade, number]> = [["A+", 92], ["A", 85], ["B", 70], ["C", 55]];

/** Words that put something at risk or set two facts against each other. */
const TENSION = /\b(still|but|yet|then|instead|only|hides?|hidden|blocks?|blocked|breach\w*|blow\w*|lose|loses|losing|lost|loss|cost\w*|wrong|trap|unravel\w*|undone|fail\w*|risk\w*|trouble|closer to|away|isn'?t|doesn'?t|can'?t|won'?t|never|no longer|not)\b/i;
/** Phrases that promise an answer the viewer has to stay for. */
const OPEN_LOOP = /\?|\b(here'?s what|here'?s why|which one|how much|how far|what (?:it|this|that)|why|the rule|the (?:one|only)|what does|would you)\b/i;
/** Words that turn a fact into a consequence in the middle of the video. */
const TURN = /\b(but|then|until|only|still|yet|instead|so|because|which means|that'?s why|once)\b/i;

/**
 * Trading terms a new viewer will not know, each with the phrasing that actually explains it. A neighbouring word is not an
 * explanation: "loss limit" says nothing about what a "floor" is, so the patterns ask for the explaining phrase itself.
 */
const JARGON: ReadonlyArray<{ term: RegExp; name: string; gloss: RegExp }> = [
  { term: /\bfloor\b/i, name: "floor", gloss: /\b(lowest (?:your|the) (?:balance|account)|can'?t (?:go|fall|drop|dip) below|(?:falls?|drops?|dips?) below|account (?:is )?(?:closed|gone|over)|closes? the account|the (?:minimum|lowest) (?:it|your account) can)\b/i },
  { term: /\bdrawdown\b/i, name: "drawdown", gloss: /\b(?:falls?|drops?|dips?) (?:from|below) (?:your |the |its )?(?:peak|high)|below (?:your |the |its )?peak|allowed to (?:lose|fall|drop)|how far (?:you|it) can (?:fall|drop|lose)\b/i },
  { term: /\bbuffer\b/i, name: "buffer", gloss: /\b(?:room to (?:lose|fall|drop)|how much (?:you can )?(?:lose|fall|drop)|allowed to (?:lose|fall|drop))\b/i },
  { term: /\btrailing\b/i, name: "trailing", gloss: /\b(?:follows (?:your |the |its )?peak|set by (?:your |the |its |the account'?s )?(?:own )?peak|moves? up with|rises? with|never comes? back down)\b/i },
  { term: /\bconsistency (?:rule|cap)\b/i, name: "consistency rule", gloss: /\b(?:single day|one day|percent of (?:your |the )?(?:total )?profit|% of (?:your |the )?(?:total )?profit|share of (?:your |the )?(?:total )?profit)\b/i },
  { term: /\br-?multiple\b/i, name: "R-multiple", gloss: /\b(?:times (?:your |the )?risk|multiple of (?:your |the )?risk|measured in risk)\b/i },
  { term: /\bedge score\b/i, name: "Edge Score", gloss: /\b(?:score out of|out of 100|one score for)\b/i },
];

const wordsOf = (t: string): string[] => t.trim().split(/\s+/).filter(Boolean);
const figuresOf = (t: string): string[] => t.match(/-?\$?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9$%\s]/g, " ").replace(/\s+/g, " ").trim();

function grade(score: number): StoryGrade {
  for (const [g, cutoff] of STORY_GRADE_CUTOFFS) if (score >= cutoff) return g;
  return "D";
}

export function scoreStory(plan: ScenePlan): StoryScore {
  const criteria: StoryCriterion[] = [];
  const add = (key: string, label: string, max: number, points: number, note: string) =>
    criteria.push({ key, label, max, points: Math.max(0, Math.min(max, Math.round(points))), note });

  const hook = plan.hook.trim();
  const hookWords = wordsOf(hook);
  const firstScene = plan.scenes[0]!;
  const allNarration = plan.scenes.map((s) => s.narration).join(" ");

  // 1. HOOK (40)
  const hasTension = TENSION.test(hook);
  const hasContrast = /[.!?]\s+\S/.test(hook) && hasTension; // two beats that pull against each other
  add("hook_stakes", "Hook puts something at risk", 15, hasContrast ? 15 : hasTension ? 10 : 0, hasContrast ? "A contrast: two beats that pull against each other." : hasTension ? "There is a risk word, but no second beat." : "The hook states a fact. Nothing is at risk and nothing is surprising.");
  const figs = figuresOf(hook);
  add("hook_number", "Hook has a concrete number", 10, figs.length >= 1 ? 10 : 0, figs.length ? `Uses ${figs.slice(0, 3).join(", ")}.` : "No specific number in the hook.");
  const loop = OPEN_LOOP.test(hook) || (hasContrast && figs.length > 0);
  add("hook_curiosity", "Hook opens a question the viewer wants answered", 10, loop ? 10 : hasTension ? 4 : 0, loop ? "It raises a question or a surprise." : "Nothing makes a stranger ask \"why?\" or \"how?\".");
  add("hook_short", "Hook is short enough to land in one breath", 5, hookWords.length <= 9 ? 5 : hookWords.length <= 12 ? 3 : 0, `${hookWords.length} words.`);

  // 2. ONE IDEA, IN PLAIN WORDS (25)
  const evidenceHeadlineFigures = new Set(plan.scenes.filter((s) => s.assetId).flatMap((s) => figuresOf(s.headline)).map((f) => f.replace(/^-/, "")));
  const figureCount = evidenceHeadlineFigures.size;
  add("one_idea", "One idea, not a list of numbers", 10, figureCount <= 2 ? 10 : figureCount === 3 ? 6 : figureCount === 4 ? 2 : 0, `${figureCount} different figures shown across the evidence scenes${figureCount > 3 ? " (a list, not a story)" : ""}.`);
  const unglossed = JARGON.filter((j) => j.term.test(hook + " " + firstScene.headline) && !j.gloss.test(allNarration.replace(j.term, " ")));
  add("plain_words", "Jargon is explained in plain words", 10, unglossed.length === 0 ? 10 : Math.max(0, 10 - unglossed.length * 5), unglossed.length ? `"${unglossed.map((j) => j.name).join('", "')}" is used up front and never explained.` : "No unexplained trading terms up front.");
  const worst = Math.max(...plan.scenes.map((s) => wordsOf(s.headline).length));
  add("words_per_screen", "Few words on screen", 5, worst <= 7 ? 5 : worst <= 9 ? 3 : 0, `At most ${worst} words on one screen.`);

  // 3. ARC (20)
  const middle = plan.scenes.slice(1, Math.max(2, plan.scenes.length - 1)).map((s) => s.narration).join(" ");
  const hasTurn = TURN.test(middle);
  add("turn", "There is a turn in the middle", 10, hasTurn ? 10 : 0, hasTurn ? "A middle line turns a fact into a consequence." : "The middle only lists facts; nothing turns them into a consequence.");
  const last = plan.scenes[plan.scenes.length - 1]!;
  const hookTokens = new Set(norm(hook).split(" ").filter((w) => w.length > 3));
  const lastTokens = norm(`${last.narration} ${last.headline}`).split(" ");
  const echoes = figuresOf(hook).some((f) => `${last.narration} ${last.headline}`.includes(f)) || lastTokens.filter((w) => hookTokens.has(w)).length >= 2;
  add("loop_back", "The ending loops back to the hook", 5, echoes ? 5 : 0, echoes ? "The last scene repeats the hook's figure or words." : "The ending never returns to the hook, so nothing rewards a rewatch.");
  add("payoff", "It ends on a clear next step", 5, last.cta ? 5 : 0, last.cta ? "Closes with the invitation." : "No closing invitation.");

  // 4. LENGTH AND PACE (15)
  const total = plan.scenes.reduce((n, s) => n + s.durationSeconds, 0);
  const pace = total / plan.scenes.length;
  // An explainer (explainers.ts) teaches one rule over about 30-45 seconds; a clip states one finding in 12-20.
  if (plan.series === "Explained") {
    add("length", "30 to 45 seconds (explainer)", 8, total >= 28 && total <= 45 ? 8 : total > 45 && total <= 55 ? 4 : 0, `${total.toFixed(1)}s planned.`);
    add("pace", "A new beat every 2.5 to 5.5 seconds (explainer)", 7, pace >= 2.5 && pace <= 5.5 ? 7 : pace > 5.5 && pace <= 7 ? 3 : pace < 2.5 ? 3 : 0, `${pace.toFixed(1)}s per scene on average.`);
  } else {
  add("length", "12 to 20 seconds", 8, total >= 12 && total <= 20 ? 8 : total > 20 && total <= 26 ? 4 : total >= 9 && total < 12 ? 4 : 0, `${total.toFixed(1)}s planned.`);
  add("pace", "A new beat every 1.8 to 3.5 seconds", 7, pace >= 1.8 && pace <= 3.5 ? 7 : pace > 3.5 && pace <= 5 ? 3 : pace < 1.8 ? 3 : 0, `${pace.toFixed(1)}s per scene on average.`);
  }

  const score = criteria.reduce((n, c) => n + c.points, 0);
  const fixes = [...criteria]
    .filter((c) => c.points < c.max)
    .sort((a, b) => b.max - b.points - (a.max - a.points))
    .slice(0, 3)
    .map((c) => `${c.label}: ${c.note}`);
  return { planId: plan.planId, score, grade: grade(score), criteria, fixes };
}

/**
 * The render bar (owner decision, 2026-09-30): only concepts that grade A or A+ are ever rendered. A concept below it is
 * not offered in the app, is not drafted by the campaign step, and is refused by the render worker even if it was
 * approved earlier, so no route reaches a render without clearing it.
 */
export const MIN_RENDER_GRADE: StoryGrade = "A";
export const MIN_RENDER_SCORE = 85;

export interface RenderBarResult {
  ok: boolean;
  score: number;
  grade: StoryGrade;
  fixes: string[];
}

export function renderBar(plan: ScenePlan): RenderBarResult {
  const s = scoreStory(plan);
  return { ok: s.score >= MIN_RENDER_SCORE, score: s.score, grade: s.grade, fixes: s.fixes };
}

/** The refusal shown to the owner or written to the render log: what the score is, what the bar is, and what to change. */
export function renderBarRefusal(plan: ScenePlan, result: RenderBarResult = renderBar(plan)): string {
  return (
    `"${plan.planId}" grades ${result.grade} (${result.score}/100); only ${MIN_RENDER_GRADE} and A+ (${MIN_RENDER_SCORE}+) are rendered. ` +
    `Fix first: ${result.fixes.join(" | ") || "no single fix stands out; rework the concept"}`
  );
}

/** Throws the refusal above when a plan is below the bar. Used by the campaign step and the render worker. */
export function assertMeetsRenderBar(plan: ScenePlan): void {
  const result = renderBar(plan);
  if (!result.ok) throw new Error(`Story bar not met: ${renderBarRefusal(plan, result)}`);
}
