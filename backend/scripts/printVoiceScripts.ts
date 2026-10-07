#!/usr/bin/env node
/**
 * Prints the voice-script sheet: the offered concepts (the fresh hook-first pool, 30; 30 older daily ones with --legacy) in request order, with the exact lines to record and the file name each
 * recording must have (see scripts/video-factory/suppliedVoice.ts). The sheet is generated from the concepts, so it can never
 * disagree with what the video says. The text is plain: the recordings are cut at the pauses between sentences afterwards
 * (scripts/splitVoiceRecordings.ts), so no timing markup is asked for.
 *
 *   npx tsx scripts/printVoiceScripts.ts > ../docs/VOICE_SCRIPTS.md
 */
import { DAILY_PILOTS } from "../src/shortform/dailyConcepts.js";
import { MOTION_SCENE_PLANS, OFFERED_DAILY_CONCEPT_IDS } from "../src/shortform/motionPlans.js";

/** Default: the offered pool in request order (the fresh hook-first concepts, motionPlans.ts). `--legacy` prints the 30 older daily concepts, which are no longer offered. */
const LEGACY = process.argv.includes("--legacy");
const PILOTS = LEGACY ? DAILY_PILOTS : OFFERED_DAILY_CONCEPT_IDS.map((id) => MOTION_SCENE_PLANS.find((p) => p.planId === id)!);

/** Plain paragraph text for a text-to-speech box: the five lines in order, nothing else (no timing markup). */
const SETTINGS = [
  "Voice: Brian (Clean, Professional and Balanced)",
  "Model: Eleven v4",
  "Stability: 75%",
  "Similarity: 75%",
  "Output format: MP3 44.1 kHz 128 kbps",
  "Nothing else changed (Auto-tag off, no audio tags, no timing tags)",
];

const lines: string[] = [];
lines.push(`# Voice scripts: the ${PILOTS.length} ${LEGACY ? "older daily" : "fresh hook-first"} videos, in order`, "");
lines.push("Generated from the concepts (`backend/scripts/printVoiceScripts.ts`), so each line is exactly what the video says and what its figures show. Day 1 is the first video requested; one is requested a day.", "");
lines.push("## Settings used for the first recording (the older 30 were all recorded on 2026-10-03)", "");
for (const x of SETTINGS) lines.push(`- ${x}`);
lines.push("", "Keep the same settings if any day is re-recorded, so the videos sound like one voice.", "");
lines.push("## How to record", "");
lines.push("1. Paste the text for a day as it is. It is plain text: no timing tags or markup are needed.");
lines.push("2. Generate it once and download the MP3 (one click makes two takes; either works).");
lines.push(`3. Name the file exactly as shown (for example \`${PILOTS[0]!.planId}.mp3\`). The number is the day.`);
lines.push("4. Give the folder to Claude Code. `npx tsx scripts/splitVoiceRecordings.ts <folder>` cuts each file into its five beats at the pauses between sentences and checks every cut against the words; a day it cannot cut with confidence is reported and left alone, and that day is re-recorded.", "");
lines.push("Lines are short on purpose (7 words or fewer): a beat lasts as long as its line. Figures are whole dollars.", "");
lines.push("## The order", "");
lines.push("| Day | File name | Video |", "|---|---|---|");
for (const [i, p] of PILOTS.entries()) lines.push(`| ${i + 1} | \`${p.planId}.mp3\` | ${p.title} |`);
lines.push("");
for (const [i, p] of PILOTS.entries()) {
  lines.push(`## Day ${i + 1}: ${p.title}`, "");
  lines.push(`File name: \`${p.planId}.mp3\``, "");
  lines.push("```", p.scenes.map((s) => s.narration).join(" "), "```", "");
}
process.stdout.write(lines.join("\n"));
