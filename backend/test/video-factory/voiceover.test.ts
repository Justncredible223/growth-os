import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateVoiceover, measureAudioDuration, DEFAULT_VOICE, DEFAULT_RATE, respellFillbookForTts } from "../../scripts/video-factory/voiceover";
import { VideoFactoryError } from "../../scripts/video-factory/types";
import type { ProcessRunner } from "../../scripts/video-factory/processRunner";

const SAMPLE_WORDS = JSON.stringify([
  { text: "Hello", startSeconds: 0.05, endSeconds: 0.4 },
  { text: "there.", startSeconds: 0.45, endSeconds: 0.9 },
]);

let tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "video-factory-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("generateVoiceover", () => {
  it("writes the script to a file and invokes the word-timing script via python3", async () => {
    const dir = tempDir();
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "python3") {
        writeFileSync(args[args.indexOf("--out-words") + 1]!, SAMPLE_WORDS);
        writeFileSync(args[args.indexOf("--out-media") + 1]!, "");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "ffprobe") {
        return { stdout: JSON.stringify({ format: { duration: "3.5" } }), stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command ${command}`);
    });
    const runner: ProcessRunner = { run };

    const result = await generateVoiceover("Hello there.", dir, runner);

    expect(run.mock.calls[0]![0]).toBe("python3");
    const args = run.mock.calls[0]![1] as string[];
    expect(args).toContain("--file");
    expect(args[args.indexOf("--voice") + 1]).toBe(DEFAULT_VOICE);
    expect(args[args.indexOf("--rate") + 1]).toBe(DEFAULT_RATE);
    expect(readFileSync(join(dir, "script.txt"), "utf-8")).toBe("Hello there.");
    expect(result.durationSeconds).toBe(3.5);
    expect(result.wordCues).toHaveLength(2);
    expect(result.wordCues[0]).toEqual({ text: "Hello", startSeconds: 0.05, endSeconds: 0.4 });
  });

  it("sends Fillbook to TTS as Fill-book (the owner chose that reading by ear, 2026-10-03)", async () => {
    const dir = tempDir();
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "python3") {
        writeFileSync(args[args.indexOf("--out-words") + 1]!, SAMPLE_WORDS);
        writeFileSync(args[args.indexOf("--out-media") + 1]!, "");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: JSON.stringify({ format: { duration: "3.5" } }), stderr: "", exitCode: 0 };
    });
    const runner: ProcessRunner = { run };

    await generateVoiceover("Fillbook tracks your drawdown.", dir, runner);

    expect(readFileSync(join(dir, "script.txt"), "utf-8")).toBe("Fill-book tracks your drawdown.");
  });

  it("keeps the verified standard voice (Multilingual voices mispronounce \"book\") at a modestly faster pace", () => {
    expect(DEFAULT_VOICE).toBe("en-US-AndrewNeural");
    expect(DEFAULT_VOICE).not.toMatch(/Multilingual/);
    expect(DEFAULT_RATE).toBe("+8%");
  });

  it("respects a custom voice override", async () => {
    const dir = tempDir();
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "python3") {
        writeFileSync(args[args.indexOf("--out-words") + 1]!, SAMPLE_WORDS);
        writeFileSync(args[args.indexOf("--out-media") + 1]!, "");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: JSON.stringify({ format: { duration: "3.5" } }), stderr: "", exitCode: 0 };
    });
    const runner: ProcessRunner = { run };

    await generateVoiceover("Hello there.", dir, runner, "en-US-JennyNeural");

    const args = run.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--voice") + 1]).toBe("en-US-JennyNeural");
  });

  it("throws VideoFactoryError when the word-timing script exits non-zero", async () => {
    const dir = tempDir();
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "voice not found", exitCode: 1 });
    const runner: ProcessRunner = { run };

    await expect(generateVoiceover("Hello.", dir, runner)).rejects.toThrow(VideoFactoryError);
    await expect(generateVoiceover("Hello.", dir, runner)).rejects.toThrow(/voice not found/);
  });

  it("retries a transient edge-tts failure (NoAudioReceived) and succeeds without re-running anything but the TTS call", async () => {
    const dir = tempDir();
    let pythonCalls = 0;
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "python3") {
        pythonCalls++;
        if (pythonCalls === 1) return { stdout: "", stderr: "edge_tts.exceptions.NoAudioReceived: No audio was received.", exitCode: 1 };
        writeFileSync(args[args.indexOf("--out-words") + 1]!, SAMPLE_WORDS);
        writeFileSync(args[args.indexOf("--out-media") + 1]!, "");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: JSON.stringify({ format: { duration: "3.5" } }), stderr: "", exitCode: 0 };
    });

    const result = await generateVoiceover("Hello there.", dir, { run }, DEFAULT_VOICE, DEFAULT_RATE, [0, 0]);

    expect(pythonCalls).toBe(2);
    expect(result.durationSeconds).toBe(3.5);
  });

  it("gives up after the bounded number of retries on a persistent transient failure", async () => {
    const dir = tempDir();
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "NoAudioReceived", exitCode: 1 });

    await expect(generateVoiceover("Hello.", dir, { run }, DEFAULT_VOICE, DEFAULT_RATE, [0, 0])).rejects.toThrow(/NoAudioReceived/);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("never retries a non-transient failure (e.g. a bad voice name)", async () => {
    const dir = tempDir();
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "voice not found", exitCode: 1 });

    await expect(generateVoiceover("Hello.", dir, { run }, DEFAULT_VOICE, DEFAULT_RATE, [0, 0])).rejects.toThrow(/voice not found/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("throws VideoFactoryError if the word-timing script reports success but never wrote the words file", async () => {
    const dir = tempDir();
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const runner: ProcessRunner = { run };

    await expect(generateVoiceover("Hello.", dir, runner)).rejects.toThrow(VideoFactoryError);
  });

  it("throws VideoFactoryError on an empty word-timing array", async () => {
    const dir = tempDir();
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "python3") {
        writeFileSync(args[args.indexOf("--out-words") + 1]!, "[]");
        writeFileSync(args[args.indexOf("--out-media") + 1]!, "");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const runner: ProcessRunner = { run };

    await expect(generateVoiceover("Hello.", dir, runner)).rejects.toThrow(/no word timing data/);
  });

  it("throws VideoFactoryError on invalid JSON in the words file", async () => {
    const dir = tempDir();
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "python3") {
        writeFileSync(args[args.indexOf("--out-words") + 1]!, "not json");
        writeFileSync(args[args.indexOf("--out-media") + 1]!, "");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const runner: ProcessRunner = { run };

    await expect(generateVoiceover("Hello.", dir, runner)).rejects.toThrow(/invalid JSON/);
  });
});

describe("measureAudioDuration", () => {
  it("parses duration from ffprobe's format.duration", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ format: { duration: "8.712" } }), stderr: "", exitCode: 0 });
    const runner: ProcessRunner = { run };

    expect(await measureAudioDuration("voiceover.mp3", runner)).toBe(8.712);
  });

  it("throws VideoFactoryError when ffprobe fails", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "invalid file", exitCode: 1 });
    const runner: ProcessRunner = { run };

    await expect(measureAudioDuration("bad.mp3", runner)).rejects.toThrow(VideoFactoryError);
  });

  it("throws VideoFactoryError when duration is missing or non-numeric", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ format: {} }), stderr: "", exitCode: 0 });
    const runner: ProcessRunner = { run };

    await expect(measureAudioDuration("voiceover.mp3", runner)).rejects.toThrow(VideoFactoryError);
  });
});

describe("respellFillbookForTts", () => {
  it("sends Fillbook as Fill-book, in any case (the owner chose this reading by ear, 2026-10-03)", () => {
    expect(respellFillbookForTts("Fillbook tracks trades.")).toBe("Fill-book tracks trades.");
    expect(respellFillbookForTts("FILLBOOK IS FREE.")).toBe("FILL-BOOK IS FREE.");
    expect(respellFillbookForTts("check out fillbook today.")).toBe("check out fill-book today.");
    expect(respellFillbookForTts("Log both accounts in Fillbook, and Fillbook shows it.")).toBe("Log both accounts in Fill-book, and Fill-book shows it.");
    expect(respellFillbookForTts("Fillbook's calendar.")).toBe("Fill-book's calendar.");
  });

  it("does not affect text with no mention of Fillbook", () => {
    expect(respellFillbookForTts("Most traders lose money.")).toBe("Most traders lose money.");
  });

  it("does not touch Fillbook as a substring of another word", () => {
    expect(respellFillbookForTts("Fillbookish is not a real word.")).toBe("Fillbookish is not a real word.");
  });

  it("still separates HQ from FillbookHQ so the voice reads it as its own letters", () => {
    expect(respellFillbookForTts("head to fillbookhq.com today.")).toBe("head to fill-book HQ.com today.");
    expect(respellFillbookForTts("Visit FillbookHQ now.")).toBe("Visit Fill-book HQ now.");
    expect(respellFillbookForTts("FOLLOW FILLBOOKHQ TODAY.")).toBe("FOLLOW FILL-BOOK HQ TODAY.");
  });
});
