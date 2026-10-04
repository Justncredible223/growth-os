import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessRunner } from "./processRunner.js";
import { VideoFactoryError } from "./types.js";
import type { WordCue } from "./types.js";

/**
 * Reverted from "en-US-AndrewMultilingualNeural" back to the original
 * "en-US-AndrewNeural" (2026-09-17) -- the Multilingual HD tier reads a
 * noticeably more natural/expressive cadence, but confirmed by ear on a
 * real render to mispronounce the plain word "book" with a long, foreign
 * "oo" (like the "oo" in "food") instead of the short vowel in "a book
 * you read." That looks like a real quirk of that voice's multilingual
 * phoneme handling specifically -- "book" is about as common an English
 * word as exists, so a standard (non-multilingual) neural voice reading
 * it correctly is the expected case, not a coincidence. Same free
 * edge-tts, no API key, no cloned/real-person voice identity per
 * ~/fillbookhq/docs/social/VIDEO_PRODUCTION_WORKFLOW.md's guardrail --
 * override only if you deliberately want voice variety (see
 * `edge-tts --list-voices` for other free options), and re-verify "book"
 * by ear before ever switching back to a Multilingual-tier voice.
 */
export const DEFAULT_VOICE = "en-US-AndrewNeural";

/**
 * Voice choice re-confirmed 2026-09-19: stay on the standard AndrewNeural.
 * It is the only voice verified by ear to say "book" (and so "Fillbook")
 * correctly; every Multilingual-tier voice (Andrew/Brian/Ava/Emma
 * Multilingual) shares the phoneme defect above and is ruled out for this
 * brand. Other standard voices (Christopher, Guy, Brian, ...) are untested
 * for "book" -- check it by ear before adopting one.
 *
 * The pace is what changed: edge-tts `rate` is relative to the voice's
 * default, so "+8%" reads a touch faster without changing pronunciation.
 * A brisker read holds attention and shortens the video (completion rate
 * is the strongest TikTok ranking signal). Set "+0%" for the old pace.
 */
export const DEFAULT_RATE = "+8%";

export interface VoiceoverResult {
  mp3Path: string;
  wordCues: WordCue[];
  durationSeconds: number;
}

/** Network-side edge-tts failures seen in practice (e.g. "NoAudioReceived" that then succeeds on the next try). */
const TRANSIENT_TTS_ERROR = /NoAudioReceived|WebSocket|ClientConnector|ServerDisconnected|TimeoutError|timed out|Connection reset|\b50[234]\b/i;
export const TTS_RETRY_DELAYS_MS: readonly number[] = [2000, 5000];

const WORD_TIMING_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "edge_tts_words.py");

/**
 * "Fillbook" is sent to TTS as "Fill-book". Spelled as one word, the voice reads the second half like "bewk"
 * (the owner heard this in the narrated mock samples, 2026-10-03, after choosing the one-word spelling by ear on
 * 2026-09-30). The owner listened to six spellings in the same voice and pace ("Fillbook", "Fill book", "Fill-book",
 * "Fillbuk", "Fil book", "Fill, book") and picked the hyphenated one as the best reading.
 *
 * "FillbookHQ" becomes "Fill-book HQ": run together, the voice reads "HQ" as part of the word. Captions and on-screen
 * text are unaffected: the word-timing stream reports the hyphenated word as one cue, and mergeBrandNameWordCues turns
 * it back into "Fillbook" for display.
 */
export function respellFillbookForTts(text: string): string {
  return text.replace(/\b(fill)(book)(hq)?\b/gi, (_m, fill: string, book: string, hq?: string) => `${fill}-${book}${hq ? " HQ" : ""}`);
}

/**
 * Runs edge_tts_words.py against the approved script text, via a script
 * file (not inline text) so arbitrary punctuation/quotes never need
 * shell-escaping -- same reasoning as the old CLI-based `--file` flag.
 * Calls the edge_tts Python library directly (through this helper script)
 * rather than the edge-tts CLI, because only the library's WordBoundary
 * stream gives real per-word timing -- the CLI's --write-subtitles only
 * ever produced sentence-level SRT cues, not enough to drive word-by-word
 * highlighted captions (see captions.ts's buildWordHighlightCues).
 */
export async function generateVoiceover(
  scriptText: string,
  outDir: string,
  runner: ProcessRunner,
  voice: string = DEFAULT_VOICE,
  rate: string = DEFAULT_RATE,
  retryDelaysMs: readonly number[] = TTS_RETRY_DELAYS_MS,
): Promise<VoiceoverResult> {
  const scriptPath = join(outDir, "script.txt");
  const mp3Path = join(outDir, "voiceover.mp3");
  const wordsPath = join(outDir, "voiceover.words.json");
  writeFileSync(scriptPath, respellFillbookForTts(scriptText), "utf-8");

  const args = [WORD_TIMING_SCRIPT, "--voice", voice, "--rate", rate, "--file", scriptPath, "--out-media", mp3Path, "--out-words", wordsPath];
  let result = await runner.run("python3", args);
  // Only this subprocess is retried, inside the same render job: no campaign regeneration, review, upload or approval repeats.
  for (let attempt = 0; result.exitCode !== 0 && attempt < retryDelaysMs.length && TRANSIENT_TTS_ERROR.test(`${result.stderr}\n${result.stdout}`); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    result = await runner.run("python3", args);
  }
  if (result.exitCode !== 0) {
    throw new VideoFactoryError(`edge-tts word-timing script failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }

  let wordsContent: string;
  try {
    wordsContent = readFileSync(wordsPath, "utf-8");
  } catch (err) {
    throw new VideoFactoryError(
      `edge-tts word-timing script reported success but did not write word timings to "${wordsPath}": ${(err as Error).message}`,
    );
  }

  let wordCues: WordCue[];
  try {
    wordCues = JSON.parse(wordsContent) as WordCue[];
  } catch (err) {
    throw new VideoFactoryError(`edge-tts word-timing script wrote invalid JSON to "${wordsPath}": ${(err as Error).message}`);
  }
  if (wordCues.length === 0) {
    throw new VideoFactoryError("edge-tts produced no word timing data -- cannot time captions without it.");
  }

  const durationSeconds = await measureAudioDuration(mp3Path, runner);
  return { mp3Path, wordCues, durationSeconds };
}

/** ffprobe -show_format gives duration directly -- no need to decode the audio. */
export async function measureAudioDuration(mp3Path: string, runner: ProcessRunner): Promise<number> {
  const result = await runner.run("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", mp3Path]);
  if (result.exitCode !== 0) {
    throw new VideoFactoryError(`ffprobe failed to read "${mp3Path}" (exit ${result.exitCode}): ${result.stderr}`);
  }
  let parsed: { format?: { duration?: string } };
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new VideoFactoryError(`ffprobe returned non-JSON output for "${mp3Path}": ${(err as Error).message}`);
  }
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VideoFactoryError(`ffprobe returned an invalid duration for "${mp3Path}": ${parsed.format?.duration}`);
  }
  return duration;
}
