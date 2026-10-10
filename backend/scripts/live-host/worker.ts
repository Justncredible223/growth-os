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
import { OBS_SOURCE_NAME } from "./setupObs.js";
import { TiktokChatReader } from "./tiktokChat.js";
import { screenIncomingMessage } from "../../src/liveHost/liveHostGuardrails.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE_FILE = join(HERE, "stage", "index.html");
const WORD_TIMING_SCRIPT = join(HERE, "..", "video-factory", "edge_tts_words.py");

/** Same voice the videos use; the only one verified by ear to say "Fillbook" correctly (see voiceover.ts). */
export const LIVE_HOST_DEFAULT_VOICE = "en-US-AndrewNeural";
/** Close to the voice's natural pace. +12% was tried first and the owner found the captions hard to follow (2026-10-09). */
/** Red, the foil, speaks in a different voice and faster, so nobody mistakes him for Tilt. */
export const RED_VOICE = "en-US-ChristopherNeural";
export const RED_RATE = "+22%";
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
interface TickResult {
  desired: "on" | "off";
  reason: string | null;
  sessionId: string | null;
  /** Whether the owner switched TikTok chat reading on, and for which account. */
  tiktok?: { chatEnabled: boolean; username: string | null };
  utterance: TickUtterance | null;
  note: string | null;
  joinsWelcomed?: boolean;
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

/** The move a chat message asks for, if it is one of the move words ("dance", "spin", "jump", "moonwalk", "wave", "flex"). */
export function moveWord(body: string): string | null {
  const match = /\b(dance|dancing|spin|jump|moonwalk|wave|flex)\b/i.exec(body);
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  return word === "dancing" ? "dance" : word;
}

/** What the voice is given: the brand name respelled so it is pronounced correctly, "dot com" left as written. */
export function prepareSpeechText(spokenText: string): string {
  return respellFillbookForTts(spokenText).replace(/\s+/g, " ").trim();
}

/** The captions show the brand name as it is written, not as it is respelled for the voice. */
export function captionWords(words: WordCue[]): WordCue[] {
  return words.map((word) => ({ ...word, text: word.text.replace(/fill-book/gi, "Fillbook") }));
}

async function synthesize(config: WorkerConfig, workDir: string, id: string, spokenText: string, voice: string = config.voice, rate: string = config.rate): Promise<{ words: WordCue[]; durationSeconds: number }> {
  const textFile = join(workDir, `${id}.txt`);
  const audioFile = join(workDir, `${id}.mp3`);
  const wordsFile = join(workDir, `${id}.json`);
  writeFileSync(textFile, prepareSpeechText(spokenText), "utf-8");
  await new Promise<void>((resolve, reject) => {
    execFile(
      config.pythonCommand,
      [WORD_TIMING_SCRIPT, "--voice", voice, "--rate", rate, "--file", textFile, "--out-media", audioFile, "--out-words", wordsFile],
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
    }
    // Stay "speaking" until the server has the confirmation, so the tick in between does not ask for this line again.
    await confirm(id);
    if (speaking?.id === id) speaking = null;
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
    if (!obs || !config.obsControlsStream) return;
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
  tiktok.onReaction = (kind) => sendMove(kind === "gift" ? "dance" : kind === "follow" ? "flex" : kind === "share" ? "spin" : "jump");

  let lastNote: string | null = null;
  let ticksSinceStreamCheck = 0;
  /** When this worker last saw a viewer join or chat. Zero means nobody yet. */
  let lastAudienceAt = 0;
  /** After the voice fails, wait this long before trying the same line again. */
  let voiceRetryAt = 0;
  let voiceFailures = 0;

  async function tick(): Promise<void> {
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
    const emptyRoom = !config.idleSegments && config.platform !== "youtube" && tiktok.connected && Date.now() - lastAudienceAt > 3 * 60_000;
    let result: TickResult;
    try {
      result = (await api({
        action: "tick",
        // Busy also covers "nothing can be said right now": no stage page to say it on, or the voice is being
        // retried. The server then takes chat in but does not spend a model call on a line nobody would hear.
        busy: speaking !== null || stageClients.size === 0 || Date.now() < voiceRetryAt || emptyRoom,
        platform: config.platform,
        // Not while the TikTok reader is down: without it nobody would ever count as present.
        audienceOnly: !config.idleSegments && (config.platform === "youtube" || tiktok.connected),
        messages,
        joins,
        workerInfo: { stageClients: stageClients.size, voice: config.voice, obs: obs?.connected ?? false, tiktokChat: tiktok.connected },
      })) as TickResult;
    } catch (err) {
      // Put chat back so a network blip loses nothing.
      tiktok.restore(messages);
      log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (result.joinsWelcomed) tiktok.clearJoins();
    if (result.note && result.note !== lastNote) log(`note: ${result.note}`);
    lastNote = result.note;

    const shouldBeLive = result.desired === "on";
    if (shouldBeLive !== live) {
      live = shouldBeLive;
      log(live ? "Live Host switched ON" : `Live Host is off (${result.reason ?? "switched off"})`);
      broadcast("state", { live });
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

    await tiktok.ensure(live && result.tiktok?.chatEnabled === true, result.tiktok?.username ?? null);

    const line = result.utterance;
    if (!live || !line || speaking) return;
    if (finished.has(line.id)) {
      // Already said (or dropped) and the confirmation did not land: confirm again, do not say it again.
      await confirm(line.id);
      return;
    }
    if (stageClients.size === 0 || Date.now() < voiceRetryAt) return;
    try {
      const { words, durationSeconds } = await synthesize(config, workDir, line.id, line.spokenText);
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
      const timer = setTimeout(() => void finishLine(line.id, "spoken"), (durationSeconds + (sidekick?.durationSeconds ?? 0) + 7) * 1000);
      speaking = { id: line.id, timer };
      broadcast("speak", { ...line, audioUrl: `/audio/${line.id}.mp3`, words, durationSeconds, sidekick });
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
