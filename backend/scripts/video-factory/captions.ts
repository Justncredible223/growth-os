import type { CaptionCue, WordCue } from "./types.js";

/**
 * voiceover.ts sends "Fillbook" to TTS as "Fill-book", which the WordBoundary stream reports as one cue ("Fill-book",
 * "Fill-book's"); this turns it back into "Fillbook" so it displays and highlights as the brand name. It also merges an
 * adjacent "Fill" + "book" pair (word-cue files made when the name was spoken as two words) into one cue spanning both
 * words' combined time range. Matches on bare letters only (strips punctuation) so a "Fill book." at a sentence end
 * still merges.
 */
export function mergeBrandNameWordCues(wordCues: WordCue[]): WordCue[] {
  const merged: WordCue[] = [];
  for (let i = 0; i < wordCues.length; i++) {
    const current = wordCues[i]!;
    const next = wordCues[i + 1];
    const currentBare = current.text.replace(/[^a-zA-Z]/g, "").toLowerCase();
    const nextBare = next?.text.replace(/[^a-zA-Z]/g, "").toLowerCase();
    if (next && currentBare === "fill" && nextBare === "book") {
      merged.push({ text: "Fillbook", startSeconds: current.startSeconds, endSeconds: next.endSeconds });
      i++;
    } else if (/fill-book/i.test(current.text)) {
      merged.push({ ...current, text: current.text.replace(/fill-book/gi, "Fillbook") });
    } else {
      merged.push(current);
    }
  }
  return merged;
}

/** A gap this long between two spoken words reads as a natural phrase boundary -- mirrors how a human captioner would chunk a sentence, not an arbitrary fixed word count. */
const PAUSE_BREAK_SECONDS = 0.35;

/** Sized so a phrase reads as one short on-screen line at 1080px/64pt, similar sizing rationale to the old sentence-splitting cap. */
const MAX_PHRASE_CHARS = 34;
const MAX_PHRASE_WORDS = 6;

/**
 * Groups flat word-level timing into short on-screen phrases (2-6 words),
 * breaking at natural speech pauses before falling back to a max-length
 * cap. Each phrase becomes one stationary on-screen caption line, with
 * word-by-word highlighting applied within it (see buildWordHighlightCues).
 */
export function groupWordsIntoPhrases(words: WordCue[]): WordCue[][] {
  const phrases: WordCue[][] = [];
  let current: WordCue[] = [];
  let currentChars = 0;

  for (const word of words) {
    const prev = current[current.length - 1];
    const gap = prev ? word.startSeconds - prev.endSeconds : 0;
    const wouldExceed = currentChars + word.text.length + 1 > MAX_PHRASE_CHARS || current.length >= MAX_PHRASE_WORDS;
    if (current.length > 0 && (gap >= PAUSE_BREAK_SECONDS || wouldExceed)) {
      phrases.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(word);
    currentChars += word.text.length + 1;
  }
  if (current.length > 0) phrases.push(current);
  return phrases;
}

/**
 * Brand cyan, ASS BGR (matches the old Hook style colour), plus a 14% scale-up -- the active-word "pop" look
 * (2026-09-28, owner request) used for whichever word is currently being spoken. \fscx/\fscy are RESET, not
 * relative, so every highlighted word snaps to exactly 114% regardless of any earlier override in the same line.
 */
const HIGHLIGHT_COLOR_ONLY = "\\c&H00EED322&";
const HIGHLIGHT_COLOR_TAG = `${HIGHLIGHT_COLOR_ONLY}\\fscx114\\fscy114`;
/** Both styles' own PrimaryColour is white (see ASS_HEADER) and their own scale is 100 -- this override switches a word back to both once it's no longer the active one. */
const BASE_COLOR_TAG = "\\c&H00FFFFFF&\\fscx100\\fscy100";

/**
 * Builds one Dialogue line per word within a phrase: the full phrase text
 * is shown throughout the phrase's duration, with only the
 * currently-spoken word's colour swapped to the highlight via an inline
 * ASS override tag -- the TikTok/CapCut "active word" caption look. One
 * Dialogue line per word (rather than ASS's built-in \k karaoke tag) so the
 * highlighted word is exactly and deterministically the one currently
 * being spoken, with no dependence on how a given libass build interprets
 * \k timing.
 *
 * Each word's display window is extended to the next word's start time
 * (rather than its own real end time) so there's no blank-caption flicker
 * during the brief natural articulation gaps between words in the same
 * phrase.
 */
export function buildWordHighlightCues(phrase: WordCue[], style: "Hook" | "Caption"): CaptionCue[] {
  const escapedWords = phrase.map((w) => escapeAssText(w.text));
  return phrase.map((word, i) => {
    const text = escapedWords.map((w, j) => (j === i ? `{${HIGHLIGHT_COLOR_TAG}}${w}{${BASE_COLOR_TAG}}` : w)).join(" ");
    const start = word.startSeconds;
    const nextWord = phrase[i + 1];
    const end = nextWord ? nextWord.startSeconds : word.endSeconds;
    return { text, startSeconds: start, endSeconds: end, style };
  });
}

/** Per-word pop for the hook headline: an ASS \t transform, so the word grows 20% over 110ms from the moment its own Dialogue line starts. */
const HEADLINE_POP_TAG = "\\t(0,110,\\fscx120\\fscy120)";

function normalizeForMatch(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9$%]/g, "");
}

/**
 * Pairs a scene's authored headline with the real spoken timing of its first words, or returns null when they don't
 * line up word for word (case and punctuation aside). Verified-motion hooks usually open the narration with the
 * headline itself ("Same setup. Bigger size." spoken, then the detail); a headline that is only a paraphrase of the
 * speech, or spells a number differently ("5" vs "Five"), would highlight the wrong words, so it gets no highlighting
 * at all and the caller keeps the plain static headline.
 */
export function alignHeadlineToSpeech(headline: string, spoken: WordCue[]): WordCue[] | null {
  const headlineWords = headline.trim().split(/\s+/).filter(Boolean);
  if (headlineWords.length === 0 || spoken.length < headlineWords.length) return null;
  for (let i = 0; i < headlineWords.length; i++) {
    const want = normalizeForMatch(headlineWords[i]!);
    if (want === "" || want !== normalizeForMatch(spoken[i]!.text)) return null;
  }
  return headlineWords.map((text, i) => ({ text, startSeconds: spoken[i]!.startSeconds, endSeconds: spoken[i]!.endSeconds }));
}

export interface HeadlineWordVariant {
  /** The headline as ASS markup with exactly one word highlighted (none, for the closing tail). */
  markup: string;
  startSeconds: number;
  endSeconds: number;
}

/**
 * One variant of the headline per spoken word: that word is brand cyan and pops in, the others stay white. Times are
 * on the video timeline (`sceneStart` + each word's own offset). The first variant starts at the scene's own start so the
 * headline is on screen from frame one, each variant runs to the next word's start (no flicker in the gaps), and a final
 * un-highlighted tail holds the finished headline until the scene ends.
 */
export function buildHeadlineWordVariants(words: WordCue[], sceneStart: number, sceneEnd: number): HeadlineWordVariant[] {
  const escaped = words.map((w) => escapeAssText(w.text));
  const clamp = (t: number) => Math.min(Math.max(t, sceneStart), sceneEnd);
  const variants: HeadlineWordVariant[] = words.map((word, i) => {
    const markup = escaped.map((w, j) => (j === i ? `{${HIGHLIGHT_COLOR_ONLY}${HEADLINE_POP_TAG}}${w}{${BASE_COLOR_TAG}}` : w)).join(" ");
    const start = i === 0 ? sceneStart : clamp(sceneStart + word.startSeconds);
    const next = words[i + 1];
    const end = next ? clamp(sceneStart + next.startSeconds) : clamp(sceneStart + word.endSeconds);
    return { markup, startSeconds: start, endSeconds: end };
  });
  const last = variants[variants.length - 1]!;
  if (sceneEnd - last.endSeconds > 0.02) variants.push({ markup: escaped.join(" "), startSeconds: last.endSeconds, endSeconds: sceneEnd });
  return variants.filter((v) => v.endSeconds - v.startSeconds > 0.005);
}

/**
 * Builds the final caption cue list from real word-level timing: words are
 * grouped into short phrases, and the first phrase (the hook, spoken first
 * by construction -- videoScriptWriter puts it at the start of `script`)
 * is tagged with the larger "Hook" style.
 */
export function buildCaptionCues(wordCues: WordCue[]): CaptionCue[] {
  if (wordCues.length === 0) return [];
  const phrases = groupWordsIntoPhrases(wordCues);
  const hookPhraseCount = countHookPhrases(phrases);
  return phrases.flatMap((phrase, i) => buildWordHighlightCues(phrase, i < hookPhraseCount ? "Hook" : "Caption"));
}

/** No phrase starting at or after this is ever part of the hook, even without a sentence break. */
const HOOK_MAX_START_SECONDS = 3.2;
/** When the word text carries no sentence punctuation, the hook is whatever phrases start inside this window. */
const HOOK_FALLBACK_WINDOW_SECONDS = 2.4;

/**
 * How many leading phrases make up the hook -- the whole first spoken
 * sentence, not just its first 2-6 words, so the entire hook line gets the
 * big centered treatment for the first ~2-3 seconds. Ends at the first
 * phrase whose last word carries sentence-ending punctuation; edge-tts word
 * boundaries often omit punctuation, so it falls back to a time window.
 */
function countHookPhrases(phrases: WordCue[][]): number {
  let count = 0;
  for (const phrase of phrases) {
    if (phrase[0]!.startSeconds >= HOOK_MAX_START_SECONDS) break;
    count++;
    if (/[.!?]["')\]]*$/.test(phrase[phrase.length - 1]!.text)) return count;
  }
  const inWindow = phrases.filter((p) => p[0]!.startSeconds < HOOK_FALLBACK_WINDOW_SECONDS).length;
  return Math.max(1, inWindow);
}

/**
 * NO LONGER USED by the render pipeline (retired: a silent end card is dead
 * time that lowers completion rate and breaks looping -- videos now end on
 * the last spoken line, which flows back into the hook). Kept for reference.
 *
 * A brief brand card ("FILLBOOK" / "fillbookhq.com") shown during the
 * silence pad already reserved at the end of every render for the closing
 * caption to breathe (see render-single.ts/index.ts's SILENCE_PAD_SECONDS)
 * -- reuses that existing dead-air window rather than extending the
 * video's total duration. Middle-centered (the "Outro" style's own
 * Alignment=5, distinct from Caption/Hook's bottom-anchored Alignment=2)
 * so it reads as a deliberate closing beat, not another caption line.
 */
export function buildOutroCue(totalDurationSeconds: number, silencePadSeconds: number): CaptionCue {
  const text = `FILLBOOK\\N{\\fs40\\c&H00FFFFFF&}fillbookhq.com`;
  return {
    text,
    startSeconds: Math.max(0, totalDurationSeconds - silencePadSeconds),
    endSeconds: totalDurationSeconds,
    style: "Outro",
  };
}

/** ASS uses centisecond precision and H:MM:SS.CC, not SRT's HH:MM:SS,mmm. */
export function secondsToAssTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const centiseconds = Math.round((totalSeconds - Math.floor(totalSeconds)) * 100);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

/**
 * Escapes a single word's text for a literal ASS Dialogue line. `{`/`}`
 * open override blocks in ASS -- stripping them (never expected in real
 * TTS word text) is simpler and safer than trying to escape-and-preserve
 * them. Applied per-word, before buildWordHighlightCues wraps the active
 * word in its own override braces, so those wrapper braces are never
 * stripped by this call.
 */
export function escapeAssText(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\r\n|\n/g, "\\N");
}

/**
 * Known-good header from ~/fillbookhq/docs/social/VIDEO_PRODUCTION_WORKFLOW.md:
 * PlayResX/PlayResY MUST match the render resolution (this is what fixed
 * the libass clipping bug), Alignment=5 (middle-center) avoids
 * margin-from-edge ambiguity. Hook and Caption now share the same white
 * PrimaryColour -- the brand-cyan pop lives entirely in the per-word
 * override tags in buildWordHighlightCues, so "highlighted" always means
 * the same thing regardless of which style a phrase uses; only Hook's
 * larger fontsize sets it apart. A third "SceneLabel" style (see scenes.ts)
 * reuses the same subtitles-filter mechanism for on-screen scene text,
 * since drawtext segfaults on this ffmpeg build.
 *
 * Fontname is the bundled "Poppins ExtraBold" (see render.ts's
 * FONT_ASSET_PATH/fontsdir wiring), not Arial/Verdana -- ubuntu-latest
 * (where every real render actually runs) has neither of those installed,
 * so libass was silently substituting its own default sans-serif fallback
 * before this; bundling a specific bold, rounded font makes captions look
 * deliberately designed rather than like whatever happened to be on the
 * rendering machine, and thicker Outline/Shadow give the text more pop
 * against busy stock-footage backgrounds.
 *
 * Hook (2026-09-19): 92pt and middle-centered (Alignment=5) instead of
 * sharing Caption's bottom-anchored spot -- the first spoken sentence is
 * the scroll-stopper, so it reads as a big title card in the middle of the
 * frame for its ~2-3s, then captions drop to the bottom strip.
 *
 * Caption MarginV=450 (2026-09-22, raised from 400, itself raised from 320):
 * owner-reported on real TikTok uploads -- 320 (~17% of the 1920px canvas)
 * was tuned against TikTok's username/description text alone, and 400
 * (~21%) still left the caption's top edge (measured: extends ~60px above
 * the margin, i.e. to ~460px from the bottom) inside the worst-case combined
 * UI band (a 2-3 line description plus the music/sound attribution row can
 * run to ~450-510px). 450px (~23%) pushes the caption's own top edge to
 * ~510px, clear of that worst case. UI_BOTTOM_BAND in render.ts (the dark
 * band reserved below UI-screenshot scenes) is raised to match -- see the
 * comment there. SceneLabel (top-anchored, MarginV=140) and Outro
 * (middle-centered) are unaffected -- neither sits in TikTok's bottom UI
 * strip.
 */
const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Poppins ExtraBold,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,2,2,170,170,450,1
Style: Hook,Poppins ExtraBold,92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,8,3,5,170,170,0,1
Style: SceneLabel,Poppins ExtraBold,48,&H00F4F6FA,&H00F4F6FA,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,5,2,8,80,80,140,1
Style: Outro,Poppins ExtraBold,92,&H00EED322,&H00EED322,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,7,3,5,170,170,0,1
Style: Card,Poppins ExtraBold,76,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,8,170,170,0,1
Style: CardLabel,Poppins ExtraBold,30,&H00DED4C9,&H00DED4C9,&H00362A1D,&H00362A1D,1,0,0,0,100,100,2,0,3,14,0,8,80,80,168,1
Style: Pay,Poppins ExtraBold,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,8,150,150,0,1
Style: Chart,Poppins ExtraBold,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

export interface SceneLabelCue {
  label: string;
  startSeconds: number;
  endSeconds: number;
  style?: "SceneLabel" | "CardLabel";
}

/**
 * Assembles the full .ass file: caption dialogue (bottom-safe, per
 * MarginV=450 in the Caption/Hook styles) plus scene-label dialogue (top
 * third, MarginV=140 in the SceneLabel style) so the two never overlap --
 * preserving TikTok/Shorts UI safe zones (avoids the bottom
 * caption/engagement-bar area and the very top status-bar area).
 *
 * A caption cue's `text` is already fully-formed ASS markup (see
 * buildWordHighlightCues) -- interpolated directly, not re-escaped, since
 * re-escaping would strip the inline colour override braces it depends on.
 */
export function buildAssFile(captionCues: CaptionCue[], sceneLabelCues: SceneLabelCue[]): string {
  const captionLines = captionCues.map(
    (cue) => `Dialogue: ${cue.layer ?? 0},${secondsToAssTime(cue.startSeconds)},${secondsToAssTime(cue.endSeconds)},${cue.style},,0,0,${cue.marginV ?? 0},,${cue.text}`,
  );
  const sceneLines = sceneLabelCues.map(
    (cue) =>
      `Dialogue: 1,${secondsToAssTime(cue.startSeconds)},${secondsToAssTime(cue.endSeconds)},${cue.style ?? "SceneLabel"},,0,0,0,,${escapeAssText(cue.label)}`,
  );
  return [ASS_HEADER, ...sceneLines, ...captionLines].join("\n") + "\n";
}
