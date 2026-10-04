import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSuppliedVoice, parseSilences, speechSegments, splitProblem, VOICE_DIR } from "../scripts/video-factory/suppliedVoice";
import { synthesizeSuppliedNarrationAudio } from "../scripts/video-factory/scenePlanAdapter";
import { DAILY_PILOTS } from "../src/shortform/dailyConcepts";
import type { ProcessRunner } from "../scripts/video-factory/processRunner";

const tmp = () => mkdtempSync(join(tmpdir(), "voice-"));

// What ffmpeg's silencedetect writes to stderr for a file of five lines with a long pause between each.
const FIVE_LINES = [
  "[silencedetect @ 0x1] silence_start: 2.4",
  "[silencedetect @ 0x1] silence_end: 3.4 | silence_duration: 1.0",
  "[silencedetect @ 0x1] silence_start: 5.8",
  "[silencedetect @ 0x1] silence_end: 6.8 | silence_duration: 1.0",
  "[silencedetect @ 0x1] silence_start: 9.1",
  "[silencedetect @ 0x1] silence_end: 10.1 | silence_duration: 1.0",
  "[silencedetect @ 0x1] silence_start: 12.0",
  "[silencedetect @ 0x1] silence_end: 13.0 | silence_duration: 1.0",
].join("\n");

describe("reading a recording's pauses", () => {
  it("parses ffmpeg's silencedetect log into silences", () => {
    expect(parseSilences(FIVE_LINES)).toHaveLength(4);
    expect(parseSilences(FIVE_LINES)[0]).toEqual({ start: 2.4, end: 3.4 });
  });

  it("cuts the file into the spoken parts between the pauses", () => {
    const segments = speechSegments(parseSilences(FIVE_LINES), 15);
    expect(segments).toEqual([{ start: 0, end: 2.4 }, { start: 3.4, end: 5.8 }, { start: 6.8, end: 9.1 }, { start: 10.1, end: 12 }, { start: 13, end: 15 }]);
  });

  it("ignores a leading silence, a trailing silence that runs to the end, and a click shorter than a line", () => {
    const log = ["silence_start: 0", "silence_end: 0.5 | silence_duration: 0.5", "silence_start: 2.0", "silence_end: 2.9", "silence_start: 3.0", "silence_end: 4.0", "silence_start: 6.0"].join("\n");
    expect(speechSegments(parseSilences(log), 7)).toEqual([{ start: 0.5, end: 2.0 }, { start: 4.0, end: 6.0 }]);
  });

  it("says in plain words how many parts it found and where, and how to fix it", () => {
    const msg = splitProblem("daily-01-brief-room", [{ start: 0, end: 2.4 }, { start: 3.9, end: 10.5 }], 5);
    expect(msg).toContain("2 spoken parts but the video has 5 beats");
    expect(msg).toContain("2: 3.9-10.5s");
    expect(msg).toContain('<break time="1.0s" />');
    expect(msg).toContain("daily-01-brief-room-1 to daily-01-brief-room-5");
  });
});

describe("finding a recording for a concept", () => {
  it("finds nothing when there is no file, so the built-in voice is used", () => {
    expect(findSuppliedVoice("daily-01-brief-room", 5, tmp())).toBeNull();
  });

  it("finds one file named after the concept, in mp3, wav or m4a", () => {
    for (const ext of ["mp3", "wav", "m4a"]) {
      const dir = tmp();
      writeFileSync(join(dir, `daily-01-brief-room.${ext}`), "x");
      expect(findSuppliedVoice("daily-01-brief-room", 5, dir)).toEqual({ kind: "single", path: join(dir, `daily-01-brief-room.${ext}`) });
    }
  });

  it("prefers five numbered files, one per beat, and ignores a partial set", () => {
    const dir = tmp();
    for (let i = 1; i <= 5; i++) writeFileSync(join(dir, `daily-01-brief-room-${i}.mp3`), "x");
    const found = findSuppliedVoice("daily-01-brief-room", 5, dir);
    expect(found?.kind).toBe("parts");
    expect(found && found.kind === "parts" ? found.paths.map((p) => p.slice(-5)) : []).toEqual(["1.mp3", "2.mp3", "3.mp3", "4.mp3", "5.mp3"]);

    const partial = tmp();
    for (let i = 1; i <= 3; i++) writeFileSync(join(partial, `daily-01-brief-room-${i}.mp3`), "x");
    expect(findSuppliedVoice("daily-01-brief-room", 5, partial)).toBeNull();
  });

  it("looks in the folder the renderer ships, which is in the repo", () => {
    expect(VOICE_DIR.endsWith(join("assets", "voice"))).toBe(true);
  });
});

function fakeRunner(silenceLog: string, totalSeconds = 15) {
  const calls: string[][] = [];
  const run = vi.fn(async (command: string, args: string[] = []) => {
    calls.push([command, ...args]);
    if (command === "ffprobe") {
      const path = String(args[args.length - 1]);
      const duration = path.endsWith("single.mp3") ? totalSeconds : 2.0;
      return { stdout: JSON.stringify({ format: { duration: String(duration) } }), stderr: "", exitCode: 0 };
    }
    if (args.includes("silencedetect=noise=-40dB:d=0.7") || args.some((a) => a.startsWith("silencedetect"))) return { stdout: "", stderr: silenceLog, exitCode: 0 };
    const out = args[args.length - 1];
    if (out && !out.startsWith("-")) writeFileSync(out, "fake-audio");
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  return { runner: { run } as ProcessRunner, calls };
}

describe("narration from a supplied recording", () => {
  const plan = DAILY_PILOTS[0]!;

  it("cuts one file at its pauses into one part per beat, trims and pads them, and reports the recording as the source", async () => {
    const dir = tmp();
    const file = join(dir, "single.mp3");
    writeFileSync(file, "x");
    const { runner, calls } = fakeRunner(FIVE_LINES);
    const result = await synthesizeSuppliedNarrationAudio(plan, { kind: "single", path: file }, dir, runner, { minSceneSeconds: 1.5, trimSilence: true });
    expect(result.provenance).toBe("supplied");
    expect(Object.keys(result.durationsBySceneId)).toEqual(plan.scenes.map((s) => s.sceneId));
    // Each beat was cut out of the file at its own start and end, with a few hundredths of a second of margin.
    const cuts = calls.filter((c) => c[0] === "ffmpeg" && c.includes("-ss"));
    expect(cuts).toHaveLength(5);
    expect(cuts[1]!.slice(cuts[1]!.indexOf("-ss"), cuts[1]!.indexOf("-ss") + 4)).toEqual(["-ss", "3.360", "-to", "5.840"]);
    // The same trim and join as the built-in voice.
    expect(calls.some((c) => c.join(" ").includes("silenceremove"))).toBe(true);
    expect(calls.some((c) => c.includes("concat"))).toBe(true);
  });

  it("fails loudly, naming what it found, when the file does not hold one part per beat", async () => {
    const dir = tmp();
    const file = join(dir, "single.mp3");
    writeFileSync(file, "x");
    const fourParts = FIVE_LINES.split("\n").slice(0, 6).join("\n"); // only three pauses
    const { runner } = fakeRunner(fourParts);
    await expect(synthesizeSuppliedNarrationAudio(plan, { kind: "single", path: file }, dir, runner)).rejects.toThrow(/4 spoken parts but the video has 5 beats/);
  });

  it("takes five numbered files as they are, with no cutting", async () => {
    const dir = tmp();
    const paths = [1, 2, 3, 4, 5].map((i) => {
      const p = join(dir, `part-${i}.mp3`);
      writeFileSync(p, "x");
      return p;
    });
    const { runner, calls } = fakeRunner("");
    const result = await synthesizeSuppliedNarrationAudio(plan, { kind: "parts", paths }, dir, runner);
    expect(result.provenance).toBe("supplied");
    expect(calls.filter((c) => c.includes("silencedetect=noise=-40dB:d=0.7"))).toHaveLength(0);
    await expect(synthesizeSuppliedNarrationAudio(plan, { kind: "parts", paths: paths.slice(0, 4) }, dir, runner)).rejects.toThrow(/4 files but the video has 5 beats/);
  });
});
