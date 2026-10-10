#!/usr/bin/env node
/**
 * The Live Host worker. Runs on the owner's PC next to OBS for as long as a stream might happen:
 *
 *   npm run live-host
 *
 * What it does, and all it does:
 *   - serves the stage page (stage/index.html) that OBS shows as a Browser Source, and tells it what to say;
 *   - asks Growth OS every few seconds what to do (POST /api/approvals?resource=live-host, action "tick"). The
 *     server holds the owner's switch, reads YouTube chat, writes Tilt's lines and runs every safety check; this
 *     process never decides what is said;
 *   - turns each line into speech with the same free edge-tts voice the videos use, and confirms it was spoken;
 *   - starts and stops the OBS stream when the owner flips the switch in the app (when OBS control is set up).
 *
 * It holds one credential, the automation token, which can tick and confirm lines but cannot flip the switch or
 * change settings. It does not read TikTok chat: there is no official way to (docs/TIKTOK_COMMENTS_BLOCKED.md).
 * See docs/LIVE_HOST.md for setup.
 */
import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { respellFillbookForTts } from "../video-factory/voiceover.js";
import { ObsClient } from "./obsClient.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE_FILE = join(HERE, "stage", "index.html");
const WORD_TIMING_SCRIPT = join(HERE, "..", "video-factory", "edge_tts_words.py");

/** Same voice the videos use; the only one verified by ear to say "Fillbook" correctly (see voiceover.ts). */
export const LIVE_HOST_DEFAULT_VOICE = "en-US-AndrewNeural";
/** A touch quicker than the videos: live banter drags at reading pace. */
export const LIVE_HOST_DEFAULT_RATE = "+12%";
const TICK_MS = 3_000;
const TTS_TIMEOUT_MS = 30_000;

export interface WorkerConfig {
  baseUrl: string;
  token: string;
  protectionBypassSecret: string | null;
  port: number;
  voice: string;
  rate: string;
  obsUrl: string | null;
  obsPassword: string | undefined;
  pythonCommand: string;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const token = env.GROWTH_OS_AUTOMATION_TOKEN ?? "";
  if (token.length < 32) {
    throw new Error("GROWTH_OS_AUTOMATION_TOKEN is not set (it is the value of APP_API_TOKEN_AUTOMATION on the server, at least 32 characters).");
  }
  return {
    baseUrl: (env.GROWTH_OS_BASE_URL ?? "https://fillbook-growth-os.vercel.app").replace(/\/+$/, ""),
    token,
    protectionBypassSecret: env.GROWTH_OS_PROTECTION_BYPASS_SECRET || null,
    port: Number(env.LIVE_HOST_PORT) || 8790,
    voice: env.LIVE_HOST_VOICE || LIVE_HOST_DEFAULT_VOICE,
    rate: env.LIVE_HOST_RATE || LIVE_HOST_DEFAULT_RATE,
    // OBS control is optional: without it the owner starts and stops the stream in OBS by hand.
    obsUrl: env.OBS_WEBSOCKET_URL === "off" ? null : env.OBS_WEBSOCKET_URL || "ws://127.0.0.1:4455",
    obsPassword: env.OBS_WEBSOCKET_PASSWORD || undefined,
    pythonCommand: env.LIVE_HOST_PYTHON || "python",
  };
}

interface TickUtterance {
  id: string;
  kind: "reply" | "segment";
  segmentTitle: string | null;
  spokenText: string;
  mood: string;
  tiltLevel: number | null;
  card: { title: string; lines: string[] } | null;
  replyingTo: Array<{ platform: string; authorName: string; body: string }>;
}
interface TickResult {
  desired: "on" | "off";
  reason: string | null;
  sessionId: string | null;
  utterance: TickUtterance | null;
  note: string | null;
}
export interface WordCue {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

function log(line: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
}

/** What the voice is given: the brand name respelled so it is pronounced correctly, "dot com" left as written. */
export function prepareSpeechText(spokenText: string): string {
  return respellFillbookForTts(spokenText).replace(/\s+/g, " ").trim();
}

/** The captions show the brand name as it is written, not as it is respelled for the voice. */
export function captionWords(words: WordCue[]): WordCue[] {
  return words.map((word) => ({ ...word, text: word.text.replace(/fill-book/gi, "Fillbook") }));
}

async function synthesize(config: WorkerConfig, workDir: string, id: string, spokenText: string): Promise<{ words: WordCue[]; durationSeconds: number }> {
  const textFile = join(workDir, `${id}.txt`);
  const audioFile = join(workDir, `${id}.mp3`);
  const wordsFile = join(workDir, `${id}.json`);
  writeFileSync(textFile, prepareSpeechText(spokenText), "utf-8");
  await new Promise<void>((resolve, reject) => {
    execFile(
      config.pythonCommand,
      [WORD_TIMING_SCRIPT, "--voice", config.voice, "--rate", config.rate, "--file", textFile, "--out-media", audioFile, "--out-words", wordsFile],
      { timeout: TTS_TIMEOUT_MS, windowsHide: true },
      (error, _stdout, stderr) => (error ? reject(new Error(`voice synthesis failed: ${stderr.trim() || error.message}`)) : resolve()),
    );
  });
  const words = captionWords(JSON.parse(readFileSync(wordsFile, "utf-8")) as WordCue[]);
  const durationSeconds = (words.at(-1)?.endSeconds ?? spokenText.length / 15) + 0.4;
  return { words, durationSeconds };
}

export async function runWorker(config: WorkerConfig): Promise<void> {
  const workDir = join(tmpdir(), "fillbook-live-host");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const stageClients = new Set<ServerResponse>();
  let live = false;
  /** The line currently being spoken, with the timer that gives up on it if the stage never reports back. */
  let speaking: { id: string; timer: NodeJS.Timeout } | null = null;

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of stageClients) client.write(payload);
  };

  async function api(body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${config.baseUrl}/api/approvals?resource=live-host`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
        ...(config.protectionBypassSecret ? { "x-vercel-protection-bypass": config.protectionBypassSecret } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(65_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Growth OS answered HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  async function finishLine(id: string, outcome: "spoken" | "dropped"): Promise<void> {
    if (!speaking || speaking.id !== id) return;
    clearTimeout(speaking.timer);
    speaking = null;
    try {
      await api({ action: "spoken", utteranceId: id, outcome });
    } catch (err) {
      log(`could not confirm line ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      createReadStream(STAGE_FILE).pipe(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: state\ndata: ${JSON.stringify({ live })}\n\n`);
      stageClients.add(res);
      req.on("close", () => stageClients.delete(res));
      return;
    }
    const audio = /^\/audio\/([A-Za-z0-9-]+)\.mp3$/.exec(url.pathname);
    if (req.method === "GET" && audio) {
      const file = join(workDir, `${audio[1]}.mp3`);
      if (!existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": statSync(file).size, "cache-control": "no-store" });
      createReadStream(file).pipe(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/done") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          const id = (JSON.parse(raw) as { id?: string }).id;
          if (typeof id === "string") void finishLine(id, "spoken");
        } catch {
          // Ignore a malformed report; the timer covers it.
        }
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  // Local only: the stage page is for OBS on this machine, never for the network.
  await new Promise<void>((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  log(`Stage ready. In OBS add a Browser Source: http://127.0.0.1:${config.port}/  (1080 x 1920, "Control audio via OBS" on)`);

  const obs = config.obsUrl ? new ObsClient(config.obsUrl, config.obsPassword, log) : null;
  let obsWarned = false;
  async function setStreaming(on: boolean): Promise<void> {
    if (!obs) return;
    try {
      await obs.connect();
      if (on) await obs.startStream();
      else await obs.stopStream();
      obsWarned = false;
    } catch (err) {
      if (!obsWarned) log(`OBS control unavailable (${err instanceof Error ? err.message : String(err)}). Start and stop the stream in OBS by hand, or fix the connection.`);
      obsWarned = true;
    }
  }

  let lastNote: string | null = null;

  async function tick(): Promise<void> {
    let result: TickResult;
    try {
      result = (await api({ action: "tick", busy: speaking !== null, workerInfo: { stageClients: stageClients.size, voice: config.voice, obs: obs?.connected ?? false } })) as TickResult;
    } catch (err) {
      log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (result.note && result.note !== lastNote) log(`note: ${result.note}`);
    lastNote = result.note;

    const shouldBeLive = result.desired === "on";
    if (shouldBeLive !== live) {
      live = shouldBeLive;
      log(live ? "Live Host switched ON" : `Live Host is off (${result.reason ?? "switched off"})`);
      broadcast("state", { live });
      await setStreaming(live);
      if (!live && speaking) {
        clearTimeout(speaking.timer);
        speaking = null;
      }
    }

    const line = result.utterance;
    if (!live || !line || speaking) return;
    if (stageClients.size === 0) {
      log("A line is ready but no stage page is open (is the OBS Browser Source showing?). Dropping it.");
      speaking = { id: line.id, timer: setTimeout(() => {}, 0) };
      await finishLine(line.id, "dropped");
      return;
    }
    try {
      const { words, durationSeconds } = await synthesize(config, workDir, line.id, line.spokenText);
      const timer = setTimeout(() => void finishLine(line.id, "spoken"), (durationSeconds + 6) * 1000);
      speaking = { id: line.id, timer };
      broadcast("speak", { ...line, audioUrl: `/audio/${line.id}.mp3`, words, durationSeconds });
      log(`${line.kind === "segment" ? `[${line.segmentTitle}]` : `-> ${line.replyingTo.map((m) => m.authorName).join(", ") || "chat"}`}: ${line.spokenText}`);
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
      speaking = { id: line.id, timer: setTimeout(() => {}, 0) };
      await finishLine(line.id, "dropped");
    }
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("Shutting down");
    // The owner's switch is untouched: closing the worker only stops this PC from streaming.
    await setStreaming(false);
    obs?.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  log(`Connected to ${config.baseUrl}. Waiting for the switch in the Growth OS app.`);
  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runWorker(loadWorkerConfig());
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
