#!/usr/bin/env node
/**
 * Prints the voice-script sheet: the 30 daily concepts in request order, with the exact lines to record and the file name each
 * recording must have (see scripts/video-factory/suppliedVoice.ts). The sheet is generated from the concepts, so it can never
 * disagree with what the video says.
 *
 *   npx tsx scripts/printVoiceScripts.ts > ../docs/VOICE_SCRIPTS.md
 */
import { DAILY_PILOTS } from "../src/shortform/dailyConcepts.js";

const BREAK = '<break time="1.0s" />';

const lines: string[] = [];
lines.push("# Voice scripts: the 30 daily videos, in order", "");
lines.push("Generated from the concepts (`backend/scripts/printVoiceScripts.ts`), so each line is exactly what the video says and what its figures show. Day 1 is the first video requested; one is requested a day.", "");
lines.push("## How to record", "");
lines.push("1. Use one voice for all 30. In ElevenLabs pick a model that supports pause tags (Multilingual v2 or Turbo v2.5), and the same voice and settings every time.");
lines.push('2. For each day, paste the block under **Paste this** as-is. The `<break time="1.0s" />` between lines is what lets the video be cut into its five beats.');
lines.push("3. Download as MP3 and name the file exactly as shown (for example `daily-01-brief-room.mp3`). The number is the day; do not rename and do not reorder the days after recording.");
lines.push('4. If a line itself has a long pause in it (more than about 0.7 s), the cut finds too many parts and the render stops with a message saying where. Re-generate that day, or give five files for it: `daily-01-brief-room-1.mp3` to `-5.mp3`, one per line.');
lines.push('5. Say the name "Fillbook" the way you want it said. If the voice gets it wrong, add a pronunciation rule for it in ElevenLabs (the word written as "Fill-book" worked best for the built-in voice).');
lines.push("6. Send me the folder. I check every file splits into five parts, add them to the repo and open one pull request for your review.", "");
lines.push("Lines are short on purpose (7 words or fewer): a beat lasts as long as its line. Figures are whole dollars.", "");
lines.push("## The order", "");
lines.push("| Day | File name | Video |", "|---|---|---|");
for (const [i, p] of DAILY_PILOTS.entries()) lines.push(`| ${i + 1} | \`${p.planId}.mp3\` | ${p.title} |`);
lines.push("");
for (const [i, p] of DAILY_PILOTS.entries()) {
  lines.push(`## Day ${i + 1}: ${p.title}`, "");
  lines.push(`File name: \`${p.planId}.mp3\``, "");
  lines.push("Paste this:", "", "```", p.scenes.map((s) => s.narration).join(` ${BREAK} `), "```", "");
  lines.push("The five lines, in order:", "");
  for (const [j, s] of p.scenes.entries()) lines.push(`${j + 1}. ${s.narration}`);
  lines.push("");
}
process.stdout.write(lines.join("\n"));
