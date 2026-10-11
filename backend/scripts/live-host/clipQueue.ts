/**
 * Builds a clip REVIEW QUEUE from a finished stream. It never uploads or publishes anything.
 *
 *   npm run live-host:clips -- --session <sessionId> --recording <path-to-recording.mp4> [--recording-start <ISO>] [--episode <label>] [--max 8]
 *
 * It reads the session's spoken lines from the Growth OS API (automation token), scores them, and writes into
 * `<recording folder>/clips-<session>/`:
 *   queue.json    candidates with score, flags, estimated times, title, description, tracking link, status pending_approval
 *   NN.srt        captions for each clip (timing ESTIMATED from word count: check before use)
 *   cut.sh        the ffmpeg commands to cut each clip, only run after you approve the queue
 *
 * The recording start time defaults to the file's creation time. If OBS recorded from a different moment than the
 * stream start, pass --recording-start.
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildClipQueue, toSrt, type SpokenLine } from "../../src/liveHost/liveHostClips.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sessionId = arg("session");
const recording = arg("recording");
if (!sessionId || !recording) {
  console.error("Usage: npm run live-host:clips -- --session <id> --recording <file> [--recording-start <ISO>] [--episode <label>] [--max N]");
  process.exit(1);
}

const baseUrl = (process.env.GROWTH_OS_BASE_URL ?? "https://fillbook-growth-os.vercel.app").replace(/\/$/, "");
const token = process.env.GROWTH_OS_AUTOMATION_TOKEN ?? "";
if (token.length < 32) {
  console.error("GROWTH_OS_AUTOMATION_TOKEN is not set (backend/.env.local).");
  process.exit(1);
}

const res = await fetch(`${baseUrl}/api/approvals?resource=live-host`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    ...(process.env.GROWTH_OS_PROTECTION_BYPASS_SECRET ? { "x-vercel-protection-bypass": process.env.GROWTH_OS_PROTECTION_BYPASS_SECRET } : {}),
  },
  body: JSON.stringify({ action: "transcript", sessionId }),
});
if (!res.ok) {
  console.error(`Growth OS answered HTTP ${res.status}`);
  process.exit(1);
}
const transcript = (await res.json()) as { startedAt: string | null; lines: SpokenLine[] };

const recordingStart = arg("recording-start") ?? statSync(recording).birthtime.toISOString();
const episode = arg("episode") ?? (transcript.startedAt ?? new Date().toISOString()).slice(0, 10);
const queue = buildClipQueue({ lines: transcript.lines, recordingStartedAt: recordingStart, episode, maxClips: Number(arg("max") ?? 8) });

const outDir = join(dirname(recording), `clips-${sessionId.slice(0, 8)}`);
mkdirSync(outDir, { recursive: true });
const cuts: string[] = ["#!/bin/sh", "# Run only after reviewing queue.json. The stream is already 9:16; captions are burned in from the SRT.", ""];
queue.forEach((clip, i) => {
  const n = String(i + 1).padStart(2, "0");
  writeFileSync(join(outDir, `${n}.srt`), toSrt(clip), "utf-8");
  const length = (clip.endSeconds - clip.startSeconds).toFixed(2);
  cuts.push(
    `ffmpeg -ss ${clip.startSeconds.toFixed(2)} -i "${basename(recording)}" -t ${length} -vf "subtitles=${n}.srt:force_style='Alignment=2,MarginV=420,FontSize=14'" -c:a aac "clip-${n}.mp4"`,
  );
});
writeFileSync(join(outDir, "queue.json"), JSON.stringify({ sessionId, recording, recordingStart, episode, generatedAt: new Date().toISOString(), note: "Nothing here is published. Review each clip, then approve individually.", queue }, null, 2), "utf-8");
writeFileSync(join(outDir, "cut.sh"), cuts.join("\n") + "\n", "utf-8");
console.log(`${queue.length} candidate clips written to ${outDir}`);
for (const clip of queue) console.log(`  ${clip.score.total.toFixed(1)}  ${clip.title}${clip.score.flags.length ? `  [${clip.score.flags.length} flag(s)]` : ""}`);
