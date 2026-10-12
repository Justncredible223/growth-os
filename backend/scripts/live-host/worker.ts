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
 *   - reads TikTok LIVE chat through an unofficial library, only while the owner has TikTok chat switched on
 *     (tiktokChat.ts explains the owner decision and its limits). YouTube chat is read by the server.
 *
 * It holds one credential, the automation token, which can tick and confirm lines but cannot flip the switch or
 * change settings.
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
import { TtsDaemon } from "./ttsDaemon.js";
import { OBS_SOURCE_NAME } from "./setupObs.js";
import { TiktokChatReader } from "./tiktokChat.js";
import { LIVE_HOST_SEGMENTS } from "../../src/liveHost/liveHostPersona.js";
import { screenIncomingMessage } from "../../src/liveHost/liveHostGuardrails.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE_FILE = join(HERE, "stage", "index.html");
const HOST_PAGE_FILE = join(HERE, "stage", "host.html");
const CONTROL_PAGE_FILE = join(HERE, "stage", "control.html");

/** The operator switches the control panel can flip. Pure data so it can be tested. */
export interface OperatorControls {
  paused: boolean;
  muted: boolean;
  chat: boolean;
  promos: boolean;
  emergency: boolean;
}

export const CONTROL_ACTIONS = ["pause", "resume", "mute", "unmute", "interrupt", "skip", "chat_on", "chat_off", "promos_on", "promos_off", "emergency_stop", "topic"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** Applies a switch action to the control state. Interrupt, skip and topic do not change switches. */
export function applyControl(state: OperatorControls, action: ControlAction): OperatorControls {
  switch (action) {
    case "pause": return { ...state, paused: true };
    case "resume": return { ...state, paused: false, emergency: false };
    case "mute": return { ...state, muted: true };
    case "unmute": return { ...state, muted: false };
    case "chat_on": return { ...state, chat: true };
    case "chat_off": return { ...state, chat: false };
    case "promos_on": return { ...state, promos: true };
    case "promos_off": return { ...state, promos: false };
    case "emergency_stop": return { ...state, paused: true, emergency: true };
    default: return state;
  }
}

/**
 * A run-time limit for one stream. Returns what should happen now given how long the stream has been live:
 * nothing, a heads-up on screen, or the end. Pure so it can be tested. maxMinutes of 0 means no limit.
 */
export function streamLimitAction(elapsedMs: number, maxMinutes: number, warned: boolean): "none" | "warn" | "end" {
  if (!(maxMinutes > 0)) return "none";
  const limitMs = maxMinutes * 60_000;
  if (elapsedMs >= limitMs) return "end";
  const warnMs = Math.max(0, limitMs - Math.min(5 * 60_000, limitMs / 2));
  if (!warned && elapsedMs >= warnMs) return "warn";
  return "none";
}

/** Seconds to wait before the next tick: the normal beat, doubling per consecutive failure up to a ceiling. */
export function tickDelayMs(consecutiveFailures: number, baseMs = 1_500, ceilingMs = 30_000): number {
  if (consecutiveFailures <= 0) return baseMs;
  return Math.min(ceilingMs, baseMs * 2 ** Math.min(consecutiveFailures, 6));
}
const WORD_TIMING_SCRIPT = join(HERE, "..", "video-factory", "edge_tts_words.py");
const TTS_SERVER_SCRIPT = join(HERE, "tts_server.py");
const STAGE_ASSETS_DIR = join(HERE, "stage", "assets");

/**
 * The only files the stage may load besides itself and the voice: real screenshots of the app from the seeded demo
 * account (example data, owner-verified in verified-manifest.json). Looked up by exact name, never by a path.
 */
export const STAGE_ASSET_NAMES: readonly string[] = ["trade-log-revenge.jpg", "drawdown-bars.jpg", "month-overview-setups.jpg"];

export function stageAssetFile(name: string): string | null {
  return STAGE_ASSET_NAMES.includes(name) ? join(STAGE_ASSETS_DIR, name) : null;
}

/** Same voice the videos use; the only one verified by ear to say "Fillbook" correctly (see voiceover.ts). */
export const LIVE_HOST_DEFAULT_VOICE = "en-US-AndrewNeural";
/** Close to the voice's natural pace. +12% was tried first and the owner found the captions hard to follow (2026-10-09). */
/** Red, the foil, speaks in a different voice and faster, so nobody mistakes him for Tilt. */
export const RED_VOICE = "en-US-ChristopherNeural";
export const RED_RATE = "+22%";
/** The singing segment is voiced slower, so the rhyme lands, and he dances through it. */
export const SINGING_TITLE = "Tilt Sings";
export const SINGING_RATE = "-12%";
export const LIVE_HOST_DEFAULT_RATE = "+4%";
// Halved after the first real stream: three seconds of waiting before a joiner was even noticed was too slow.
const TICK_MS = 1_500;
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
  /** False when the owner starts and stops the stream in OBS by hand; the worker still keeps the stage page loaded. */
  obsControlsStream: boolean;
  /** False (the default, owner rule) means the host only speaks to people who are there and stays quiet in an empty room. */
  idleSegments: boolean;
  /** Where OBS is streaming: "youtube", "tiktok" or "both". Only "youtube" lets the host say the website. */
  platform: string;
  pythonCommand: string;
  /**
   * Duo mode (TikTok co-host): the owner is on camera next to Tilt and types what Tilt should answer on
   * http://127.0.0.1:<port>/host. Tilt then speaks only when addressed: no idle segments, no unprompted welcomes.
   */
  duo: boolean;
  /** What Tilt calls the co-host on stream. */
  hostName: string;
  /** quality (default), balanced or low: see liveHostModels.ts. */
  costMode: string;
  /** Where the co-host is relative to Tilt on screen, so his eyes and lean go the right way. */
  cohostSide: "left" | "right" | "down";
}

/** Longest typed prompt the host page accepts, and how many can wait for the next tick. */
export const DUO_MAX_PROMPT_CHARS = 400;
export const DUO_MAX_QUEUED = 10;

export interface DuoPrompt {
  id: string;
  text: string;
  relayedFrom?: string;
}

/**
 * Turns what the host page posted into a queued prompt, or null when it is empty. Plain text only, trimmed and
 * length-capped; the server screens it again like any chat message.
 */
export function parseDuoPrompt(raw: unknown, id: string): DuoPrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const { text, relayedFrom } = raw as { text?: unknown; relayedFrom?: unknown };
  if (typeof text !== "string") return null;
  const clean = text.replace(/\s+/g, " ").trim().slice(0, DUO_MAX_PROMPT_CHARS);
  if (clean.length === 0) return null;
  const from = typeof relayedFrom === "string" ? relayedFrom.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  return from ? { id, text: clean, relayedFrom: from } : { id, text: clean };
}

/**
 * Short reactions played the instant the co-host sends a prompt, while the real line is still being written.
 * Fixed text (nothing here comes from a model), no advice, no Fillbook, no names. They hide the few seconds it
 * takes to draft and voice a reply, which is most of the gap that makes a back and forth feel slow.
 */
export const DUO_FILLERS: ReadonlyArray<{ text: string; mood: string }> = [
  { text: "Oh, we are doing this.", mood: "smirk" },
  { text: "Hold on. I have thoughts.", mood: "thinking" },
  { text: "Interesting. Very interesting.", mood: "thinking" },
  { text: "Okay, okay, okay.", mood: "neutral" },
  { text: "Bold move.", mood: "smirk" },
  { text: "Give me a second, I am composing.", mood: "thinking" },
  { text: "Hmm. Let me cook.", mood: "smirk" },
  { text: "Oh, you want my opinion?", mood: "smirk" },
];
/** A filler plays at most this often, so a run of quick prompts does not turn into a run of fillers. */
export const DUO_FILLER_EVERY_MS = 20_000;

/** Picks the next filler: never the one just used, and none at all inside the cool-down. */
export function pickFiller(count: number, lastIndex: number, lastAt: number, now: number, random: () => number = Math.random): number | null {
  if (count === 0 || now - lastAt < DUO_FILLER_EVERY_MS) return null;
  if (count === 1) return 0;
  let index = Math.floor(random() * count);
  if (index === lastIndex) index = (index + 1) % count;
  return index;
}

export interface Reaction {
  mode?: "listening" | "thinking" | "idle";
  nod?: boolean;
}

/** Reads a reaction the host page sent: what Tilt should be doing with his eyes and body while the co-host talks. */
export function parseReaction(raw: unknown): Reaction | null {
  if (raw === null || typeof raw !== "object") return null;
  const { mode, nod } = raw as { mode?: unknown; nod?: unknown };
  const reaction: Reaction = {};
  if (mode === "listening" || mode === "thinking" || mode === "idle") reaction.mode = mode;
  else if (mode !== undefined) return null;
  if (nod === true) reaction.nod = true;
  else if (nod !== undefined && nod !== false) return null;
  return reaction.mode !== undefined || reaction.nod === true ? reaction : null;
}

/**
 * How his voice moves with how he feels, so a shocked line is not read at the pace of a smug one. Small shifts: the
 * voice stays recognisably his. `rate` is added to the base rate in percent, `pitch` is in Hz.
 */
export const MOOD_PROSODY: Readonly<Record<string, { rate: number; pitch: number }>> = {
  neutral: { rate: 0, pitch: 0 },
  smirk: { rate: -2, pitch: -2 },
  shocked: { rate: 6, pitch: 5 },
  tilted: { rate: 8, pitch: 3 },
  proud: { rate: 0, pitch: 2 },
  thinking: { rate: -6, pitch: -3 },
  sad: { rate: -8, pitch: -5 },
};

/** Applies a mood to a base rate such as "+4%": returns the rate and pitch strings the voice takes. */
export function applyMoodProsody(baseRate: string, mood: string): { rate: string; pitch: string } {
  const shift = MOOD_PROSODY[mood] ?? MOOD_PROSODY.neutral!;
  const base = Number.parseInt(baseRate.replace("%", ""), 10);
  const rate = (Number.isFinite(base) ? base : 0) + shift.rate;
  const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
  const signed = (value: number) => `${value >= 0 ? "+" : "-"}${Math.abs(value)}`;
  return { rate: `${signed(clamp(rate, 40))}%`, pitch: `${signed(clamp(shift.pitch, 12))}Hz` };
}

/** How long a pressed "run a segment" waits for its line to come back before it is given up on. */
export const DUO_SEGMENT_REQUEST_MS = 30_000;

/** The segments the host page offers: everything except the Fillbook spot, which the server rations itself. */
export function duoSegmentChoices(): Array<{ id: string; title: string }> {
  return LIVE_HOST_SEGMENTS.filter((segment) => !segment.isFillbookSpot && !segment.show && !segment.retired).map((segment) => ({ id: segment.id, title: segment.title }));
}

/** The run-of-show beats the host page has dedicated buttons for. */
export const DUO_SHOW_BEATS: readonly string[] = LIVE_HOST_SEGMENTS.filter((segment) => segment.show).map((segment) => segment.id);

/** Reads the body of a "run a segment" press: a known segment id, or null for the next one in the rotation. */
export function parseSegmentRequest(raw: unknown): { id: string | null } | null {
  if (raw === null || typeof raw !== "object") return null;
  const id = (raw as { id?: unknown }).id;
  if (id === undefined || id === null || id === "") return { id: null };
  if (typeof id !== "string") return null;
  return duoSegmentChoices().some((choice) => choice.id === id) || DUO_SHOW_BEATS.includes(id) ? { id } : null;
}

/**
 * The host page is local-only, but a web page open in the owner's browser can still make requests to 127.0.0.1.
 * Accept a prompt only from a request that names this host, carries the page's own header, and has no foreign Origin.
 */
export function isTrustedHostRequest(headers: Record<string, string | string[] | undefined>, port: number): boolean {
  const host = String(headers.host ?? "");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return false;
  return headers["x-live-host"] === "1";
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
    obsControlsStream: env.LIVE_HOST_OBS_STREAM !== "off",
    idleSegments: env.LIVE_HOST_IDLE_SEGMENTS === "on",
    // Not stated means the careful choice: the host points to the bio instead of saying the website.
    platform: (env.LIVE_HOST_PLATFORM || "unknown").toLowerCase(),
    pythonCommand: env.LIVE_HOST_PYTHON || "python",
    duo: (env.LIVE_HOST_MODE || "").toLowerCase() === "duo",
    hostName: env.LIVE_HOST_COHOST_NAME || "Host",
    costMode: ["quality", "balanced", "low"].includes((env.LIVE_HOST_COST || "").toLowerCase()) ? (env.LIVE_HOST_COST as string).toLowerCase() : "quality",
    cohostSide: (["left", "right", "down"] as const).find((side) => side === (env.LIVE_HOST_COHOST_SIDE || "").toLowerCase()) ?? "down",
  };
}

interface TickUtterance {
  id: string;
  kind: "reply" | "segment";
  segmentTitle: string | null;
  spokenText: string;
  redLine?: string | null;
  mood: string;
  tiltLevel: number | null;
  card: { title: string; lines: string[] } | null;
  replyingTo: Array<{ platform: string; authorName: string; body: string }>;
}
let lastSpendUsd: number | null = null;

interface TickResult {
  desired: "on" | "off";
  reason: string | null;
  sessionId: string | null;
  /** Whether the owner switched TikTok chat reading on, and for which account. */
  tiktok?: { chatEnabled: boolean; username: string | null };
  utterance: TickUtterance | null;
  note: string | null;
  joinsWelcomed?: boolean;
  spendTodayUsd?: number;
  moves?: string[];
  incoming?: Array<{ platform: string; authorName: string; body: string }>;
  timingsMs?: { draft: number };
}
export interface WordCue {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

function log(line: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
}

/** Signs the host holds up when someone floods the chat. Fixed text: nothing a viewer typed is ever shown in them. */
export const SPAM_NOTICES: ReadonlyArray<{ title: string; detail: string }> = [
  { title: "Easy on the spam", detail: "One message at a time and I'll get to you." },
  { title: "No spamming, please", detail: "I'm a candle, not a slot machine." },
  { title: "I saw it the first time", detail: "Flooding chat gets you skipped, not answered." },
];

/**
 * Signs for signal-seller bots. The host cannot remove a message from TikTok's chat (only TikTok's own
 * moderation can), so what he can do is tell the room, in fixed words, that those accounts are nothing to do
 * with the stream.
 */
export const SIGNAL_SPAM_NOTICES: ReadonlyArray<{ title: string; detail: string }> = [
  { title: "Ignore the signal sellers", detail: "They are not with us. Tilt never gives or sells signals." },
  { title: "That is a spam bot", detail: "Nobody on this stream sells signals. Do not message them." },
];

/** Shown on the stage when the connection to Growth OS keeps failing. Fixed text. */
export const RECONNECT_NOTICE = { title: "Hang on", detail: "Tilt lost his connection and is finding it again." };

/** True for the signal-seller and off-platform promotion messages the server would block anyway. */
export function isPromoSpam(body: string): boolean {
  return screenIncomingMessage(body).blockedReason === "promotion or spam";
}

/**
 * Spots a viewer flooding the chat: the same thing three times, or more than five messages, inside fifteen
 * seconds. Their messages are then left out for half a minute, so the host neither answers a flood nor pays to
 * read it.
 */
export class SpamWatch {
  private recent = new Map<string, Array<{ at: number; body: string }>>();
  private mutedUntil = new Map<string, number>();

  /** Stops listening to one sender for a while (used for signal-seller bots, which get a long mute). */
  mute(author: string, forMs: number, now: number = Date.now()): void {
    this.mutedUntil.set(author.trim().toLowerCase() || "unknown", now + forMs);
    if (this.mutedUntil.size > 1000) this.mutedUntil.delete(this.mutedUntil.keys().next().value as string);
  }

  /** Returns "ok", "muted" (already flagged, drop quietly) or "spam" (just crossed the line: drop and show the sign). */
  check(author: string, body: string, now: number = Date.now()): "ok" | "muted" | "spam" {
    const key = author.trim().toLowerCase() || "unknown";
    if ((this.mutedUntil.get(key) ?? 0) > now) return "muted";
    const history = (this.recent.get(key) ?? []).filter((entry) => now - entry.at < 15_000);
    const text = body.trim().toLowerCase();
    history.push({ at: now, body: text });
    this.recent.set(key, history);
    if (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value as string);
    const repeats = history.filter((entry) => entry.body === text).length;
    if (repeats >= 3 || history.length > 5) {
      this.mutedUntil.set(key, now + 30_000);
      this.recent.delete(key);
      return "spam";
    }
    return "ok";
  }
}

import { moveWord } from "../../src/liveHost/liveHostMoves.js";
export { moveWord };

/**
 * Splits a spoken line after its first sentence so the first part can be voiced and played while the rest is still
 * being voiced. Null when the line is short, or has no sentence end early enough to be worth it.
 */
export function splitLead(text: string): { lead: string; rest: string } | null {
  const trimmed = text.trim();
  const total = trimmed.split(/\s+/).length;
  if (total < 18) return null;
  const match = /^(.{12,}?[.!?])\s+(?=\S)/s.exec(trimmed);
  if (!match) return null;
  const lead = match[1]!.trim();
  const leadWords = lead.split(/\s+/).length;
  if (leadWords < 4 || leadWords > 26) return null;
  const rest = trimmed.slice(match[0].length).trim();
  if (rest.split(/\s+/).length < 5) return null;
  return { lead, rest };
}

/** What the voice is given: the brand name respelled so it is pronounced correctly, "dot com" left as written. */
export function prepareSpeechText(spokenText: string): string {
  return respellFillbookForTts(spokenText).replace(/\s+/g, " ").trim();
}

/** The captions show the brand name as it is written, not as it is respelled for the voice. */
export function captionWords(words: WordCue[]): WordCue[] {
  return words.map((word) => ({ ...word, text: word.text.replace(/fill-book/gi, "Fillbook") }));
}

/** The warm voice helper, started by runWorker. Null (or not ready) means each line launches the script itself. */
let ttsDaemon: TtsDaemon | null = null;

async function synthesize(config: WorkerConfig, workDir: string, id: string, spokenText: string, voice: string = config.voice, rate: string = config.rate, pitch: string = "+0Hz"): Promise<{ words: WordCue[]; durationSeconds: number }> {
  const textFile = join(workDir, `${id}.txt`);
  const audioFile = join(workDir, `${id}.mp3`);
  const wordsFile = join(workDir, `${id}.json`);
  writeFileSync(textFile, prepareSpeechText(spokenText), "utf-8");
  let done = false;
  if (ttsDaemon?.ready) {
    try {
      await ttsDaemon.synthesize({ voice, rate, pitch, textFile, mediaPath: audioFile, wordsPath: wordsFile }, TTS_TIMEOUT_MS);
      done = true;
    } catch {
      // Fall through to the one-shot script below; the helper restarts itself.
    }
  }
  if (!done) await new Promise<void>((resolve, reject) => {
    execFile(
      config.pythonCommand,
      [WORD_TIMING_SCRIPT, "--voice", voice, "--rate", rate, "--pitch", pitch, "--file", textFile, "--out-media", audioFile, "--out-words", wordsFile],
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

  // Keep one voice process warm: starting Python and importing edge_tts costs several seconds on some PCs.
  ttsDaemon = new TtsDaemon(config.pythonCommand, [TTS_SERVER_SCRIPT], log);
  ttsDaemon.start();

  const stageClients = new Set<ServerResponse>();
  /** Browser tabs showing the duo host page. Kept apart from the stage clients: a host tab is not a stage. */
  const hostClients = new Set<ServerResponse>();
  /** Prompts typed on the host page, waiting for the next tick (duo mode). */
  let hostQueue: DuoPrompt[] = [];
  let promptCounter = 0;
  /** Pre-voiced fillers (duo mode), filled in once the warm voice helper is ready. */
  const fillers: Array<{ id: string; text: string; mood: string; words: WordCue[]; durationSeconds: number }> = [];
  let fillersPreparing = false;
  let fillerPlaying: NodeJS.Timeout | null = null;
  /** Spoken fillers are only for the duo co-host flow, where the owner is on camera and a beat of banter is expected. */
  const duoFillersWanted = config.duo;
  let lastFillerAt = 0;
  let lastFillerIndex = -1;
  let consecutiveTickFailures = 0;
  let lastReconnectNoticeAt = 0;
  /** A pressed "run a segment", repeated every tick until a segment line comes back or it times out. */
  let segmentRequest: { id: string | null; until: number } | null = null;
  let live = false;
  /** The line currently being spoken, with the timer that gives up on it if the stage never reports back. */
  let speaking: { id: string; timer: NodeJS.Timeout } | null = null;

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of stageClients) client.write(payload);
    if (event === "speak" || event === "state") for (const client of hostClients) client.write(payload);
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

  /**
   * Lines this worker has finished with, and how. The server keeps handing a line out until it is confirmed, so
   * if a confirmation is slow or fails, the same line comes back on the next tick: it is confirmed again from
   * here and never spoken a second time.
   */
  const finished = new Map<string, "spoken" | "dropped">();

  async function confirm(id: string): Promise<void> {
    const outcome = finished.get(id);
    if (!outcome) return;
    try {
      await api({ action: "spoken", utteranceId: id, outcome });
    } catch (err) {
      log(`could not confirm line ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function finishLine(id: string, outcome: "spoken" | "dropped"): Promise<void> {
    if (!speaking || speaking.id !== id || finished.has(id)) return;
    clearTimeout(speaking.timer);
    finished.set(id, outcome);
    if (finished.size > 200) finished.delete(finished.keys().next().value as string);
    for (const extension of ["mp3", "json", "txt"]) {
      rmSync(join(workDir, `${id}.${extension}`), { force: true });
      rmSync(join(workDir, `${id}-red.${extension}`), { force: true });
      rmSync(join(workDir, `${id}-a.${extension}`), { force: true });
      rmSync(join(workDir, `${id}-b.${extension}`), { force: true });
    }
    // Stay "speaking" until the server has the confirmation, so the tick in between does not ask for this line again.
    await confirm(id);
    if (speaking?.id === id) speaking = null;
  }

  /** Plays one pre-voiced reaction right away, if nothing is being said and the cool-down has passed. */
  function playFiller(): void {
    // Spoken stalling ("give me a second, I am composing") is gone: it added about 2.5 seconds of dead talk before
    // every real answer. The comment is on screen and he looks like he is thinking (the "react" sent just before this).
    if (!duoFillersWanted) return;
    if (!live || speaking !== null || fillerPlaying !== null || stageClients.size === 0) return;
    const index = pickFiller(fillers.length, lastFillerIndex, lastFillerAt, Date.now());
    if (index === null) return;
    const filler = fillers[index]!;
    lastFillerIndex = index;
    lastFillerAt = Date.now();
    fillerPlaying = setTimeout(() => {
      fillerPlaying = null;
    }, (filler.durationSeconds + 3) * 1000);
    broadcast("speak", {
      id: filler.id,
      kind: "reply",
      segmentTitle: null,
      spokenText: filler.text,
      redLine: null,
      mood: filler.mood,
      tiltLevel: null,
      card: null,
      replyingTo: [],
      audioUrl: `/audio/${filler.id}.mp3`,
      words: filler.words,
      durationSeconds: filler.durationSeconds,
      sidekick: null,
    });
    log(`filler: ${filler.text}`);
  }

  /** Voices the fillers once, as soon as the warm voice helper is ready. Failures just mean no fillers. */
  async function prepareFillers(): Promise<void> {
    if (!duoFillersWanted || fillersPreparing || fillers.length > 0 || !ttsDaemon?.ready) return;
    fillersPreparing = true;
    try {
      for (let i = 0; i < DUO_FILLERS.length; i++) {
        const id = `filler-${i + 1}`;
        const { words, durationSeconds } = await synthesize(config, workDir, id, DUO_FILLERS[i]!.text);
        fillers.push({ id, text: DUO_FILLERS[i]!.text, mood: DUO_FILLERS[i]!.mood, words, durationSeconds });
      }
      log(`${fillers.length} instant reactions ready`);
    } catch (err) {
      log(`could not prepare instant reactions (${err instanceof Error ? err.message : String(err)}); continuing without them`);
      fillers.length = 0;
    } finally {
      fillersPreparing = false;
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
      res.write(`event: state\ndata: ${JSON.stringify({ live, duo: config.duo })}\n\n`);
      stageClients.add(res);
      req.on("close", () => stageClients.delete(res));
      return;
    }
    if (config.duo && req.method === "GET" && url.pathname === "/host") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      createReadStream(HOST_PAGE_FILE).pipe(res);
      return;
    }
    if (config.duo && req.method === "GET" && url.pathname === "/host-events") {
      if (!isTrustedHostRequest({ ...req.headers, "x-live-host": "1" }, config.port)) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: state
data: ${JSON.stringify({ live, queued: hostQueue.length })}

`);
      hostClients.add(res);
      req.on("close", () => hostClients.delete(res));
      return;
    }
    if (config.duo && req.method === "GET" && url.pathname === "/host-segments") {
      if (!isTrustedHostRequest({ ...req.headers, "x-live-host": "1" }, config.port)) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(duoSegmentChoices()));
      return;
    }
    if (config.duo && req.method === "POST" && url.pathname === "/segment") {
      if (!isTrustedHostRequest(req.headers, config.port)) {
        res.writeHead(403).end();
        return;
      }
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 1_000) req.destroy();
      });
      req.on("end", () => {
        let parsed: unknown = {};
        try {
          parsed = raw.trim() ? JSON.parse(raw) : {};
        } catch {
          parsed = null;
        }
        const request = parseSegmentRequest(parsed);
        if (!request) {
          res.writeHead(400).end();
        } else if (segmentRequest) {
          res.writeHead(429).end();
        } else {
          segmentRequest = { id: request.id, until: Date.now() + DUO_SEGMENT_REQUEST_MS };
          if (live) broadcast("react", { mode: "thinking", side: config.cohostSide });
          playFiller();
          res.writeHead(202, { "content-type": "application/json" }).end("{}");
        }
      });
      return;
    }
    if (config.duo && req.method === "POST" && url.pathname === "/react") {
      if (!isTrustedHostRequest(req.headers, config.port)) {
        res.writeHead(403).end();
        return;
      }
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 500) req.destroy();
      });
      req.on("end", () => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        const reaction = parseReaction(parsed);
        if (!reaction) {
          res.writeHead(400).end();
          return;
        }
        // Not while he is mid-line: the stage ignores it anyway, and the host page may send these in a burst.
        if (live) broadcast("react", { ...reaction, side: config.cohostSide });
        res.writeHead(204).end();
      });
      return;
    }
    if (config.duo && req.method === "POST" && url.pathname === "/ask") {
      if (!isTrustedHostRequest(req.headers, config.port)) {
        res.writeHead(403).end();
        return;
      }
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 4_000) req.destroy();
      });
      req.on("end", () => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Falls through to the 400 below.
        }
        const prompt = parseDuoPrompt(parsed, `${Date.now().toString(36)}-${++promptCounter}`);
        if (!prompt) {
          res.writeHead(400).end();
        } else if (hostQueue.length >= DUO_MAX_QUEUED) {
          res.writeHead(429).end();
        } else {
          hostQueue.push(prompt);
          if (live) broadcast("react", { mode: "thinking", side: config.cohostSide });
          playFiller();
          res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ queued: hostQueue.length }));
        }
      });
      return;
    }
    const asset = /^\/assets\/([A-Za-z0-9.-]+)$/.exec(url.pathname);
    if (req.method === "GET" && asset) {
      const file = stageAssetFile(asset[1]!);
      if (!file || !existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": statSync(file).size, "cache-control": "max-age=3600" });
      createReadStream(file).pipe(res);
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
    // ---- operator control panel (solo or duo): local only, trusted-host header, optional shared token ----
    const controlToken = process.env.LIVE_HOST_CONTROL_TOKEN ?? "";
    const controlAllowed = (withHeader: boolean): boolean => {
      if (!isTrustedHostRequest({ ...req.headers, ...(withHeader ? {} : { "x-live-host": "1" }) }, config.port)) return false;
      return controlToken === "" || req.headers["x-live-host-token"] === controlToken;
    };
    if (req.method === "GET" && url.pathname === "/control") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      createReadStream(CONTROL_PAGE_FILE).pipe(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      if (!controlAllowed(false)) {
        res.writeHead(403).end();
        return;
      }
      const sinceTick = lastTickOkAt === 0 ? null : Math.round((Date.now() - lastTickOkAt) / 1000);
      const health = {
        status: !live ? "off" : controls.emergency ? "emergency-stopped" : consecutiveTickFailures >= 3 ? "degraded" : stageClients.size === 0 ? "no-stage" : "ok",
        live,
        platform: config.platform,
        controls,
        speaking: speaking?.id ?? null,
        waitingLine: waitingLineId,
        stageClients: stageClients.size,
        obsConnected: obs?.connected ?? false,
        recording: recordingOn,
        secondsSinceLastGoodTick: sinceTick,
        consecutiveTickFailures,
        lastNote,
        spendTodayUsd: lastSpendUsd,
        segmentRequest: segmentRequest?.id ?? (segmentRequest ? "next" : null),
        minutesLeft: maxMinutes > 0 && liveSinceMs > 0 ? Math.max(0, Math.round(maxMinutes - (Date.now() - liveSinceMs) / 60_000)) : null,
        limitMinutes: maxMinutes > 0 ? maxMinutes : null,
        uptimeSeconds: Math.round((Date.now() - startedAtMs) / 1000),
        segments: duoSegmentChoices(),
      };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(health));
      return;
    }
    if (req.method === "POST" && url.pathname === "/control") {
      if (!controlAllowed(true)) {
        res.writeHead(403).end();
        return;
      }
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 1_000) req.destroy();
      });
      req.on("end", () => {
        let body: { action?: unknown; id?: unknown } = {};
        try {
          body = raw.trim() ? (JSON.parse(raw) as typeof body) : {};
        } catch {
          res.writeHead(400).end();
          return;
        }
        const action = body.action as ControlAction;
        if (!CONTROL_ACTIONS.includes(action)) {
          res.writeHead(400).end();
          return;
        }
        void (async () => {
          controls = applyControl(controls, action);
          if (action === "mute" || action === "unmute") broadcast("mute", { on: controls.muted });
          if (action === "interrupt" || action === "skip" || action === "emergency_stop") {
            broadcast("silence", {});
            if (speaking) await finishLine(speaking.id, "dropped");
            else if (waitingLineId && action !== "interrupt") {
              finished.set(waitingLineId, "dropped");
              await confirm(waitingLineId);
            }
            if (fillerPlaying) {
              clearTimeout(fillerPlaying);
              fillerPlaying = null;
            }
          }
          if (action === "emergency_stop") {
            live = false;
            broadcast("state", { live: false, duo: config.duo });
            try {
              if (obs) {
                await obs.connect();
                await obs.stopStream();
              }
            } catch (err) {
              log(`emergency stop: OBS did not confirm (${err instanceof Error ? err.message : String(err)}). Stop the stream in OBS by hand.`);
            }
            log("EMERGENCY STOP: speech silenced, stream stopped, paused until resumed");
          }
          if (action === "topic") {
            const request = parseSegmentRequest({ id: typeof body.id === "string" ? body.id : undefined });
            if (request && !segmentRequest) {
              segmentRequest = { id: request.id, until: Date.now() + DUO_SEGMENT_REQUEST_MS };
              controls = { ...controls, paused: false };
            }
          }
          log(`operator: ${action}`);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, controls }));
        })();
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/done") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          const id = (JSON.parse(raw) as { id?: string }).id;
          if (typeof id === "string" && id.startsWith("filler-")) {
            // A filler has no server record: there is nothing to confirm.
            if (fillerPlaying) clearTimeout(fillerPlaying);
            fillerPlaying = null;
          } else if (typeof id === "string") void finishLine(id, "spoken");
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
    if (!obs || !config.obsControlsStream) return;
    // After an emergency stop nothing restarts the broadcast until the operator resumes.
    if (on && controls.emergency) return;
    try {
      await obs.connect();
      if (on) await obs.startStream();
      else await obs.stopStream();
      if (recordingOn) {
        if (on) await obs.startRecording();
        else await obs.stopRecording();
      }
      obsWarned = false;
    } catch (err) {
      if (!obsWarned) log(`OBS control unavailable (${err instanceof Error ? err.message : String(err)}). Start and stop the stream in OBS by hand, or fix the connection.`);
      obsWarned = true;
    }
  }

  /**
   * OBS loads the stage page when OBS starts, which is usually before this worker is serving it, and a Browser
   * Source does not retry a page that failed to load. So while nothing is connected to the stage, ask OBS to
   * reload the source (the one `npm run live-host:setup-obs` creates), at most every 15 seconds.
   */
  let lastStageRefresh = 0;
  async function reviveStage(): Promise<void> {
    if (!obs || stageClients.size > 0 || Date.now() - lastStageRefresh < 15_000) return;
    lastStageRefresh = Date.now();
    try {
      await obs.connect();
      await obs.refreshBrowserSource(OBS_SOURCE_NAME);
      log("Asked OBS to reload the stage page");
    } catch {
      // No OBS, or no such source yet: the "no stage page is open" message below covers it.
    }
  }

  // TikTok chat, read only while the owner has it switched on (see tiktokChat.ts for what that involves).
  const tiktok = new TiktokChatReader(log);

  // Moves: instant, physical reactions on the stage. No model call and nothing spoken, so a viewer who types
  // "dance" sees it happen within a second or two. At most one every two seconds.
  let lastMoveAt = 0;
  const spamWatch = new SpamWatch();
  let lastSpamNoticeAt = 0;
  let lastSignalNoticeAt = 0;
  let signalNoticeIndex = 0;
  let spamNoticeIndex = 0;
  const sendMove = (name: string) => {
    if (Date.now() - lastMoveAt < 2_000) return;
    lastMoveAt = Date.now();
    broadcast("move", { name });
  };
  // When the viewer count drops, he takes it personally (the "everyone keeps leaving me" bit). At most every 25s.
  let lastViewerCount = -1;
  let lastLonelyAt = 0;
  tiktok.onViewerCount = (count) => {
    if (lastViewerCount >= 0 && count < lastViewerCount && Date.now() - lastLonelyAt > 25_000 && speaking === null) {
      lastLonelyAt = Date.now();
      broadcast("lonely", {});
    }
    lastViewerCount = count;
  };
  tiktok.onReaction = (kind) => sendMove(kind === "gift" ? "dance" : kind === "follow" ? "flex" : kind === "share" ? "spin" : "jump");

  let lastNote: string | null = null;
  /** Set when a tick found new comments: the loop skips its wait so the answer starts being drafted at once. */
  let tickAgainNow = false;
  const startedAtMs = Date.now();
  let controls: OperatorControls = { paused: false, muted: false, chat: true, promos: true, emergency: false };
  let lastTickOkAt = 0;
  /** A hard stop for the stream: LIVE_HOST_MAX_MINUTES (0 or unset means none). Counted from when it first went live. */
  const maxMinutes = Number(process.env.LIVE_HOST_MAX_MINUTES ?? 0) || 0;
  let liveSinceMs = 0;
  let limitWarned = false;
  let limitEnded = false;
  let waitingLineId: string | null = null;
  const recordingOn = process.env.LIVE_HOST_RECORD === "on";
  let ticksSinceStreamCheck = 0;
  /** Until the server has answered one tick, this process is "fresh": it asks for a new show if the room has been quiet. */
  let freshStart = true;
  /** When this worker last saw a viewer join or chat. Zero means nobody yet. */
  let lastAudienceAt = 0;
  /** After the voice fails, wait this long before trying the same line again. */
  let voiceRetryAt = 0;
  let voiceFailures = 0;

  async function tick(): Promise<void> {
    ttsDaemon?.start();
    void prepareFillers();
    await reviveStage();
    const messages = tiktok.drain().filter((message) => {
      if (isPromoSpam(message.body)) {
        // A signal-seller bot: ignore that account for ten minutes and warn the room, at most once a minute.
        spamWatch.mute(message.authorName, 10 * 60_000);
        if (Date.now() - lastSignalNoticeAt > 60_000) {
          lastSignalNoticeAt = Date.now();
          broadcast("notice", SIGNAL_SPAM_NOTICES[signalNoticeIndex++ % SIGNAL_SPAM_NOTICES.length]);
          log("signal-seller spam: showed the warning sign");
        }
        return false;
      }
      const verdict = spamWatch.check(message.authorName, message.body);
      if (verdict === "spam" && Date.now() - lastSpamNoticeAt > 20_000) {
        lastSpamNoticeAt = Date.now();
        broadcast("notice", SPAM_NOTICES[spamNoticeIndex++ % SPAM_NOTICES.length]);
        log("chat flood: showed the no-spam sign");
      }
      return verdict === "ok";
    });
    for (const message of messages) {
      const word = moveWord(message.body);
      if (word) sendMove(word);
    }
    const joins = speaking === null ? tiktok.recentJoins() : [];
    if (messages.length > 0 || joins.length > 0) lastAudienceAt = Date.now();
    // Owner rule: no talking to an empty room. On TikTok this worker sees every join and message itself, so it
    // can hold the host back directly (the server applies the same rule, and is the one that knows about
    // YouTube chat).
    // Only while the reader is actually connected: if it cannot see the room, staying silent would mean dead air for
    // the whole stream, so the host falls back to running segments.
    const emptyRoom = !config.duo && !config.idleSegments && config.platform !== "youtube" && tiktok.connected && Date.now() - lastAudienceAt > 3 * 60_000;
    // Duo mode: take the typed prompts now; they go back in the queue if the tick fails.
    const hostMessages = config.duo ? hostQueue.splice(0, hostQueue.length) : [];
    let result: TickResult;
    try {
      result = (await api({
        action: "tick",
        // Busy also covers "nothing can be said right now": no stage page to say it on, or the voice is being
        // retried. The server then takes chat in but does not spend a model call on a line nobody would hear.
        busy: speaking !== null || stageClients.size === 0 || Date.now() < voiceRetryAt || emptyRoom || controls.paused,
        controls: { chat: controls.chat, promos: controls.promos },
        platform: config.platform,
        costMode: config.costMode,
        fresh: freshStart,
        ackFirst: true,
        // Not while the TikTok reader is down: without it nobody would ever count as present.
        audienceOnly: !config.idleSegments && (config.platform === "youtube" || tiktok.connected),
        messages,
        joins,
        ...(config.duo ? { duo: true, hostName: config.hostName, hostMessages } : {}),
        ...(segmentRequest ? { runSegment: { id: segmentRequest.id } } : {}),
        workerInfo: { stageClients: stageClients.size, voice: config.voice, obs: obs?.connected ?? false, tiktokChat: tiktok.connected },
      })) as TickResult;
    } catch (err) {
      // Put chat back so a network blip loses nothing.
      tiktok.restore(messages);
      hostQueue = [...hostMessages, ...hostQueue].slice(0, DUO_MAX_QUEUED);
      log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
      // Several failures in a row means the room is looking at a silent, frozen host: say so on screen.
      if (++consecutiveTickFailures >= 3 && Date.now() - lastReconnectNoticeAt > 60_000) {
        lastReconnectNoticeAt = Date.now();
        broadcast("notice", RECONNECT_NOTICE);
      }
      return;
    }
    consecutiveTickFailures = 0;
    lastTickOkAt = Date.now();
    freshStart = false;

    if (segmentRequest && (result.utterance?.kind === "segment" || Date.now() > segmentRequest.until)) segmentRequest = null;
    if (typeof result.spendTodayUsd === "number") lastSpendUsd = result.spendTodayUsd;
    // Moves viewers asked for in YouTube chat (read on the server): played at once, nothing spoken.
    if (result.moves?.length) sendMove(result.moves[0]!);
    // New comments: on screen and acknowledged within a second, before the answer has been written. The next tick
    // (run straight away) drafts it.
    if (result.incoming?.length && live) {
      broadcast("incoming", result.incoming.slice(0, 2));
      broadcast("react", { mode: "thinking", side: config.cohostSide });
      playFiller();
      tickAgainNow = true;
    }
    if (result.timingsMs) log(`line drafted in ${(result.timingsMs.draft / 1000).toFixed(1)}s`);
    if (result.joinsWelcomed) tiktok.clearJoins();
    if (result.note && result.note !== lastNote) log(`note: ${result.note}`);
    lastNote = result.note;

    const shouldBeLive = result.desired === "on" && !limitEnded;
    if (shouldBeLive !== live) {
      live = shouldBeLive;
      if (live && liveSinceMs === 0) liveSinceMs = Date.now();
      log(live ? "Live Host switched ON" : `Live Host is off (${result.reason ?? "switched off"})`);
      broadcast("state", { live, duo: config.duo });
      ticksSinceStreamCheck = 0;
      await setStreaming(live);
      if (!live && speaking) {
        clearTimeout(speaking.timer);
        speaking = null;
      }
    } else if (++ticksSinceStreamCheck >= 10) {
      // Every 15 seconds make sure OBS matches the switch. A stop that failed once (OBS busy, connection lost)
      // must not leave the broadcast running after the owner switched off.
      ticksSinceStreamCheck = 0;
      await setStreaming(live);
    }

    // The run-time limit: a heads-up five minutes out, then a goodbye, then the stream is stopped and stays stopped.
    if (live && liveSinceMs > 0) {
      const action = streamLimitAction(Date.now() - liveSinceMs, maxMinutes, limitWarned);
      if (action === "warn") {
        limitWarned = true;
        broadcast("notice", { title: "Stream ends soon", detail: "Last questions, the show closes in a few minutes" });
        log(`time limit: ${maxMinutes} minutes, warning shown`);
      } else if (action === "end" && !limitEnded) {
        limitEnded = true;
        broadcast("notice", { title: "That is the show", detail: "Thanks for watching. Fillbook Live is over for today." });
        log(`time limit reached (${maxMinutes} minutes): closing the stream in 25 seconds`);
        setTimeout(() => {
          void (async () => {
            controls = { ...controls, paused: true, emergency: true };
            broadcast("silence", {});
            if (speaking) await finishLine(speaking.id, "dropped");
            live = false;
            broadcast("state", { live: false, duo: config.duo });
            try {
              if (obs) {
                await obs.connect();
                if (recordingOn) await obs.stopRecording();
                await obs.stopStream();
              }
            } catch (err) {
              log(`time limit: OBS did not confirm the stop (${err instanceof Error ? err.message : String(err)}). Stop the stream in OBS by hand.`);
            }
            log("time limit: stream stopped. Restart the worker to stream again.");
          })();
        }, 25_000);
      }
    }

    // Not on a stream that is explicitly YouTube: the owner's TikTok-chat setting is for TikTok nights.
    await tiktok.ensure(live && config.platform !== "youtube" && result.tiktok?.chatEnabled === true, result.tiktok?.username ?? null);

    const line = result.utterance;
    // The real line waits for the instant reaction to finish; the server keeps handing it out until it is spoken.
    waitingLineId = line?.id ?? null;
    if (!live || !line || speaking || fillerPlaying || controls.paused) return;
    if (finished.has(line.id)) {
      // Already said (or dropped) and the confirmation did not land: confirm again, do not say it again.
      await confirm(line.id);
      return;
    }
    if (stageClients.size === 0 || Date.now() < voiceRetryAt) return;
    try {
      const singing = line.kind === "segment" && line.segmentTitle === SINGING_TITLE;
      const synthStartedAt = Date.now();
      // His voice moves with his mood; the singing segment keeps its own slower pace and a flat pitch.
      const prosody = singing ? { rate: SINGING_RATE, pitch: "+0Hz" } : applyMoodProsody(config.rate, line.mood);
      // Long lines are voiced in two parts: the first sentence plays as soon as it is ready while the rest is voiced.
      const split = singing ? null : splitLead(line.spokenText);
      let words: WordCue[];
      let durationSeconds: number;
      let restPromise: Promise<{ words: WordCue[]; durationSeconds: number }> | null = null;
      if (split) {
        const leadVoice = await synthesize(config, workDir, `${line.id}-a`, split.lead, config.voice, prosody.rate, prosody.pitch);
        restPromise = synthesize(config, workDir, `${line.id}-b`, split.rest, config.voice, prosody.rate, prosody.pitch);
        restPromise.catch(() => {});
        words = leadVoice.words;
        durationSeconds = leadVoice.durationSeconds;
      } else {
        ({ words, durationSeconds } = await synthesize(config, workDir, line.id, line.spokenText, config.voice, prosody.rate, prosody.pitch));
      }
      log(`voice ready in ${((Date.now() - synthStartedAt) / 1000).toFixed(1)}s${split ? " (first sentence)" : ""}${ttsDaemon?.ready ? "" : " (per-line voice)"}${lastSpendUsd !== null ? `; spent today $${lastSpendUsd.toFixed(2)}` : ""}`);
      // Red's interruption, when there is one, is voiced separately and played first. If his voice fails he is
      // simply left out.
      let sidekick: { text: string; audioUrl: string; durationSeconds: number } | null = null;
      if (line.redLine) {
        try {
          const red = await synthesize(config, workDir, `${line.id}-red`, line.redLine, RED_VOICE, RED_RATE);
          sidekick = { text: line.redLine, audioUrl: `/audio/${line.id}-red.mp3`, durationSeconds: red.durationSeconds };
        } catch {
          sidekick = null;
        }
      }
      voiceFailures = 0;
      const timer = setTimeout(() => void finishLine(line.id, "spoken"), (durationSeconds + (sidekick?.durationSeconds ?? 0) + (split ? 25 : 7)) * 1000);
      speaking = { id: line.id, timer };
      if (split && restPromise) {
        broadcast("speak", { ...line, spokenText: split.lead, audioUrl: `/audio/${line.id}-a.mp3`, words, durationSeconds, sidekick, more: true });
        // The rest follows as soon as it is voiced. If it fails the first sentence simply ends the line.
        void restPromise
          .then((rest) => {
            if (speaking?.id !== line.id) return;
            clearTimeout(speaking.timer);
            speaking.timer = setTimeout(() => void finishLine(line.id, "spoken"), (rest.durationSeconds + durationSeconds + 12) * 1000);
            broadcast("speak_more", { id: line.id, spokenText: split.rest, audioUrl: `/audio/${line.id}-b.mp3`, words: rest.words, durationSeconds: rest.durationSeconds });
          })
          .catch(() => {
            if (speaking?.id === line.id) broadcast("speak_more", { id: line.id, failed: true });
          });
      } else {
        broadcast("speak", { ...line, audioUrl: `/audio/${line.id}.mp3`, words, durationSeconds, sidekick });
      }
      if (sidekick) log(`   Red: ${sidekick.text}`);
      log(`${line.kind === "segment" ? `[${line.segmentTitle}]` : `-> ${line.replyingTo.map((m) => m.authorName).join(", ") || "chat"}`}: ${line.spokenText}`);
    } catch (err) {
      // The line stays queued on the server and comes back after the wait. Only after repeated failures is it
      // given up on, so one hiccup in the voice service does not throw away a line that was already paid for.
      voiceFailures++;
      voiceRetryAt = Date.now() + 20_000;
      log(`${err instanceof Error ? err.message : String(err)} (attempt ${voiceFailures}; retrying in 20 seconds)`);
      if (voiceFailures >= 3) {
        voiceFailures = 0;
        speaking = { id: line.id, timer: setTimeout(() => {}, 0) };
        await finishLine(line.id, "dropped");
      }
    }
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("Shutting down");
    tiktok.stop();
    ttsDaemon?.stop();
    // The owner's switch is untouched: closing the worker only stops this PC from streaming.
    await setStreaming(false);
    obs?.close();
    server.close();
    process.exit(0);
  };
  // A stray error in a library (the TikTok reader, a socket) must not kill the worker while OBS keeps broadcasting.
  process.on("uncaughtException", (err) => log(`unexpected error (continuing): ${err instanceof Error ? err.message : String(err)}`));
  process.on("unhandledRejection", (err) => log(`unexpected rejection (continuing): ${err instanceof Error ? err.message : String(err)}`));
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (config.duo) log(`Duo mode: type prompts for Tilt at http://127.0.0.1:${config.port}/host . He answers only when addressed.`);
  log(`Connected to ${config.baseUrl}. Waiting for the switch in the Growth OS app.`);
  while (!stopping) {
    await tick();
    if (tickAgainNow) {
      tickAgainNow = false;
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, tickDelayMs(consecutiveTickFailures, TICK_MS)));
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
