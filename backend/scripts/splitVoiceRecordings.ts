#!/usr/bin/env node
/**
 * Splits the owner's recordings (one plain file per day, no timing markup) into the five parts per day the renderer uses, and
 * checks every split before writing anything for that day. See scripts/video-factory/splitRecording.ts for how the cuts are
 * chosen and what is checked.
 *
 *   npx tsx scripts/splitVoiceRecordings.ts <folder with daily-01-brief-room.mp3 ...> [--dry]
 *
 * Writes <planId>-1.mp3 ... <planId>-5.mp3 into scripts/video-factory/assets/voice/ for each day that passes. A day that
 * fails is reported with the reason and left alone. Exit code 1 if any day fails or is missing.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DAILY_PILOTS } from "../src/shortform/dailyConcepts.js";
import { createProcessRunner } from "./video-factory/processRunner.js";
import { measureAudioDuration } from "./video-factory/voiceover.js";
import { SILENCE_THRESHOLD_DB, VOICE_DIR, VOICE_EXTENSIONS, parseSilences } from "./video-factory/suppliedVoice.js";
import { CUT_MIN_PAUSE_SECONDS, MIN_AMBIGUITY_RATIO, checkShares, chooseCuts, chooseCutsBySize, chooseCutsBySlots, partSpans } from "./video-factory/splitRecording.js";

async function main() {
  const args = process.argv.slice(2);
  const folder = args.find((a) => !a.startsWith("--"));
  const dry = args.includes("--dry");
  if (!folder) throw new Error("Usage: npx tsx scripts/splitVoiceRecordings.ts <folder> [--dry]");
  const runner = createProcessRunner();
  if (!dry) mkdirSync(VOICE_DIR, { recursive: true });

  let failed = 0;
  let written = 0;
  console.log("Day  Status  Total   Pauses chosen (s)            Next best  Ratio  Share error  Notes");
  for (const [i, plan] of DAILY_PILOTS.entries()) {
    const day = String(i + 1).padStart(2);
    const found = VOICE_EXTENSIONS.map((ext) => join(resolve(folder), `${plan.planId}.${ext}`)).find((p) => existsSync(p));
    if (!found) {
      failed++;
      console.log(`${day}   MISSING  ${plan.planId}`);
      continue;
    }
    const lines = plan.scenes.map((s) => s.narration);
    const total = await measureAudioDuration(found, runner);
    const detect = await runner.run("ffmpeg", ["-i", found, "-af", `silencedetect=noise=${SILENCE_THRESHOLD_DB}dB:d=${CUT_MIN_PAUSE_SECONDS}`, "-f", "null", "-"], {});
    const silences = parseSilences(`${detect.stderr}
${detect.stdout}`);
    const byPause = chooseCuts(silences, total, lines.length);
    let choice = byPause;
    const notes: string[] = [];
    let status = "OK";
    if (!byPause) {
      failed++;
      console.log(`${day}   FAIL     ${total.toFixed(1)}s  fewer than ${lines.length - 1} pauses found; ${plan.planId} cannot be cut`);
      continue;
    }
    let shares = checkShares(lines, partSpans(byPause.cuts, total).map(([a, b]) => b - a));
    if (byPause.ratio < MIN_AMBIGUITY_RATIO || !shares.ok) {
      // The longest pauses are not clearly the line boundaries (a colon pauses as long as a full stop): choose by part size instead.
      const bySlots = chooseCutsBySlots(silences, total, lines);
      const slotShares = bySlots ? checkShares(lines, partSpans(bySlots.cuts, total).map(([a, b]) => b - a)) : null;
      const bySize = bySlots && slotShares?.ok ? null : chooseCutsBySize(silences, total, lines);
      if (bySlots && slotShares?.ok) {
        choice = bySlots;
        shares = slotShares;
        status = "OK*";
        notes.push("cut by punctuation order (pauses found match the lines' colons and full stops)");
      } else if (bySize) {
        choice = bySize.choice;
        shares = checkShares(lines, partSpans(choice.cuts, total).map(([a, b]) => b - a));
        status = "OK*";
        notes.push(`cut by part size (best fit ${(bySize.worst * 100).toFixed(0)} pts, next best ${(bySize.runnerUp * 100).toFixed(0)} pts)`);
      } else {
        status = "FAIL";
        if (byPause.ratio < MIN_AMBIGUITY_RATIO) notes.push(`the ${lines.length - 1} longest pauses are not clearly longer than the rest (ratio ${byPause.ratio.toFixed(2)} < ${MIN_AMBIGUITY_RATIO}) and part sizes do not settle it`);
        if (!shares.ok) notes.push(`a part is ${(shares.worst * 100).toFixed(0)} points off the length its words predict`);
      }
    }
    const spans = partSpans(choice!.cuts, total);
    const row = `${day}   ${status.padEnd(6)}  ${total.toFixed(1).padStart(5)}s  ${choice!.cuts.map((c) => c.pause.toFixed(2)).join(" ").padEnd(26)}  ${choice!.nextBest.toFixed(2).padStart(8)}  ${Number.isFinite(choice!.ratio) ? choice!.ratio.toFixed(2) : " inf"}  ${(shares.worst * 100).toFixed(0).padStart(9)}pt  ${notes.join("; ")}`;
    console.log(row);
    if (status === "FAIL") {
      failed++;
      continue;
    }
    if (dry) continue;
    for (const [j, [start, end]] of spans.entries()) {
      const out = join(VOICE_DIR, `${plan.planId}-${j + 1}.mp3`);
      const cut = await runner.run("ffmpeg", ["-y", "-ss", start.toFixed(3), "-to", end.toFixed(3), "-i", found, "-c:a", "libmp3lame", "-b:a", "128k", out], {});
      if (cut.exitCode !== 0) throw new Error(`ffmpeg failed cutting ${out}: ${cut.stderr}`);
    }
    written++;
  }
  console.log(`\n${written} day(s) written${dry ? " (dry run: none)" : ""}, ${failed} failed or missing.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
