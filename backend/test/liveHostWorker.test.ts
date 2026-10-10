import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { obsAuthResponse } from "../scripts/live-host/obsClient";
import { captionWords, loadWorkerConfig, prepareSpeechText } from "../scripts/live-host/worker";
import { LIVE_HOST_MOODS } from "../src/liveHost/types";

describe("live host worker", () => {
  it("refuses to start without a real automation token", () => {
    expect(() => loadWorkerConfig({})).toThrow(/GROWTH_OS_AUTOMATION_TOKEN/);
    expect(() => loadWorkerConfig({ GROWTH_OS_AUTOMATION_TOKEN: "short" })).toThrow(/GROWTH_OS_AUTOMATION_TOKEN/);
  });

  it("reads its settings from the environment with safe defaults", () => {
    const config = loadWorkerConfig({ GROWTH_OS_AUTOMATION_TOKEN: "a".repeat(40), GROWTH_OS_BASE_URL: "https://example.test/" });
    expect(config.baseUrl).toBe("https://example.test");
    expect(config.port).toBe(8790);
    expect(config.voice).toBe("en-US-AndrewNeural");
    expect(config.obsUrl).toBe("ws://127.0.0.1:4455");
    expect(loadWorkerConfig({ GROWTH_OS_AUTOMATION_TOKEN: "a".repeat(40), OBS_WEBSOCKET_URL: "off" }).obsUrl).toBeNull();
  });

  it("respells the brand for the voice and restores it for the captions", () => {
    expect(prepareSpeechText("It lives at fillbookhq dot com.  Fillbook is a journal.")).toBe("It lives at fill-book HQ dot com. Fill-book is a journal.");
    expect(captionWords([{ text: "Fill-book", startSeconds: 0, endSeconds: 0.4 }])[0]!.text).toBe("Fillbook");
  });

  it("computes the OBS WebSocket auth string the way the protocol defines it", () => {
    const secret = createHash("sha256").update("pw" + "salt").digest("base64");
    expect(obsAuthResponse("pw", "salt", "challenge")).toBe(createHash("sha256").update(secret + "challenge").digest("base64"));
  });
});

describe("live host stage page", () => {
  const html = readFileSync(join(__dirname, "..", "scripts", "live-host", "stage", "index.html"), "utf-8");

  it("has an expression for every mood the writer can choose", () => {
    for (const mood of LIVE_HOST_MOODS) expect(html).toMatch(new RegExp(`\\b${mood}:\\s*\\{ c:`));
  });

  it("says on screen that the host is an AI and that this is not financial advice", () => {
    expect(html).toContain("AI HOST");
    expect(html).toContain("Tilt is an AI character");
    expect(html).toContain("not financial advice");
  });

  it("loads nothing from the internet while live", () => {
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:\/\//i);
  });
});

describe("live host OBS setup", () => {
  it("points the Browser Source at the worker's stage with audio routed through OBS", async () => {
    const { stageSourceSettings, STAGE_WIDTH, STAGE_HEIGHT } = await import("../scripts/live-host/setupObs");
    const settings = stageSourceSettings(8790, "youtube");
    expect(settings.url).toBe("http://127.0.0.1:8790/");
    expect(stageSourceSettings(8790, "tiktok").url).toBe("http://127.0.0.1:8790/?safe=tiktok");
    expect(stageSourceSettings(8790, "").url).toBe("http://127.0.0.1:8790/?safe=tiktok");
    expect([settings.width, settings.height]).toEqual([STAGE_WIDTH, STAGE_HEIGHT]);
    expect(settings.reroute_audio).toBe(true);
  });

  it("lets the owner keep stream start and stop manual", () => {
    const base = { GROWTH_OS_AUTOMATION_TOKEN: "a".repeat(40) };
    expect(loadWorkerConfig(base).obsControlsStream).toBe(true);
    expect(loadWorkerConfig({ ...base, LIVE_HOST_OBS_STREAM: "off" }).obsControlsStream).toBe(false);
    expect(loadWorkerConfig(base).idleSegments).toBe(false);
    expect(loadWorkerConfig({ ...base, LIVE_HOST_IDLE_SEGMENTS: "on" }).idleSegments).toBe(true);
  });
});

describe("TikTok chat reader", () => {
  it("turns a library chat event into a message for the server", async () => {
    const { toChatMessage } = await import("../scripts/live-host/tiktokChat");
    const now = new Date("2026-10-09T18:00:00.000Z");
    expect(toChatMessage({ comment: " how does drawdown work? ", common: { msgId: "777" }, user: { nickname: "Mike", uniqueId: "mike_nq" } }, now)).toEqual({
      platform: "tiktok",
      externalId: "777",
      authorName: "Mike",
      body: "how does drawdown work?",
      receivedAt: now.toISOString(),
    });
  });

  it("falls back to the handle for the name and makes an id when TikTok gives none", async () => {
    const { toChatMessage } = await import("../scripts/live-host/tiktokChat");
    const message = toChatMessage({ comment: "hi", user: { uniqueId: "mike_nq" } }, new Date(1000), 3)!;
    expect(message.authorName).toBe("mike_nq");
    expect(message.externalId).toBe("mike_nq-1000-3");
  });

  it("ignores events with no comment text", async () => {
    const { toChatMessage } = await import("../scripts/live-host/tiktokChat");
    expect(toChatMessage({ comment: "   " })).toBeNull();
    expect(toChatMessage({ user: { nickname: "x" } })).toBeNull();
  });

  it("only ever listens: the reader has no way to send anything to TikTok", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(join(__dirname, "..", "scripts", "live-host", "tiktokChat.ts"), "utf-8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/sendMessage|sessionId|signApiKey|\.like\(|\.follow\(/);
  });

  it("stays disconnected, and keeps undelivered chat, when it should not be reading", async () => {
    const { TiktokChatReader } = await import("../scripts/live-host/tiktokChat");
    const reader = new TiktokChatReader();
    await reader.ensure(false, "fillbookhq");
    await reader.ensure(true, null);
    expect(reader.connected).toBe(false);
    reader.restore([{ platform: "tiktok", externalId: "1", authorName: "a", body: "b", receivedAt: "t" }]);
    expect(reader.drain()).toHaveLength(1);
    expect(reader.drain()).toHaveLength(0);
  });
});

describe("stage moves", () => {
  it("recognises the move words in chat and nothing else", async () => {
    const { moveWord } = await import("../scripts/live-host/worker");
    expect(moveWord("DANCE")).toBe("dance");
    expect(moveWord("tilt do a spin lol")).toBe("spin");
    expect(moveWord("he's dancing")).toBe("dance");
    expect(moveWord("how does trailing drawdown work")).toBeNull();
    expect(moveWord("abundance of setups")).toBeNull();
  });

  it("the stage has every move the worker can send", () => {
    const html = readFileSync(join(__dirname, "..", "scripts", "live-host", "stage", "index.html"), "utf-8");
    for (const name of ["dance", "spin", "jump", "moonwalk", "wave", "flex"]) expect(html).toMatch(new RegExp(`${name}: \\d+`));
  });
});

describe("bored stage", () => {
  it("has waiting-around bits and nothing in them that reads as advice or an offer", async () => {
    const html = readFileSync(join(__dirname, "..", "scripts", "live-host", "stage", "index.html"), "utf-8");
    for (const name of ["yawn", "sleep", "peek", "watch", "sigh"]) expect(html).toMatch(new RegExp(`${name}: \\d+`));
    const { checkSpokenLine } = await import("../src/liveHost/liveHostGuardrails");
    const block = /const THOUGHTS = \[([\s\S]*?)\];/.exec(html)![1]!;
    const thoughts = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(thoughts.length).toBeGreaterThan(8);
    for (const thought of thoughts) expect(checkSpokenLine(thought.replace(/\*/g, ""), { fillbookMentionAllowed: true, websiteMentionAllowed: false }), thought).toBeNull();
  });
});

describe("chat floods", () => {
  it("flags the same message three times, mutes the sender for a while, then lets them back", async () => {
    const { SpamWatch } = await import("../scripts/live-host/worker");
    const watch = new SpamWatch();
    expect(watch.check("Mike", "dance", 0)).toBe("ok");
    expect(watch.check("Mike", "dance", 1000)).toBe("ok");
    expect(watch.check("Mike", "DANCE ", 2000)).toBe("spam");
    expect(watch.check("Mike", "hello?", 3000)).toBe("muted");
    expect(watch.check("Dana", "dance", 3000)).toBe("ok");
    expect(watch.check("Mike", "how does drawdown work", 40_000)).toBe("ok");
  });

  it("flags more than five messages in fifteen seconds, but not an ordinary conversation", async () => {
    const { SpamWatch } = await import("../scripts/live-host/worker");
    const flood = new SpamWatch();
    const verdicts = [1, 2, 3, 4, 5, 6].map((i) => flood.check("Bob", `message ${i}`, i * 1000));
    expect(verdicts).toEqual(["ok", "ok", "ok", "ok", "ok", "spam"]);
    const normal = new SpamWatch();
    for (let i = 0; i < 8; i++) expect(normal.check("Ann", `question ${i}`, i * 6000)).toBe("ok");
  });

  it("the signs are fixed text that passes the same checks as speech", async () => {
    const { SPAM_NOTICES } = await import("../scripts/live-host/worker");
    const { checkSpokenLine } = await import("../src/liveHost/liveHostGuardrails");
    for (const notice of SPAM_NOTICES) {
      expect(checkSpokenLine(`${notice.title}. ${notice.detail}`, { fillbookMentionAllowed: true, websiteMentionAllowed: false })).toBeNull();
    }
  });
});

describe("signal-seller bots", () => {
  it("recognises the usual pitches and leaves real questions alone", async () => {
    const { isPromoSpam } = await import("../scripts/live-host/worker");
    for (const text of [
      "Join my VIP signals group on telegram",
      "I made $4,500 this week thanks to Mr Daniel, check my bio",
      "DM me for free signals daily",
      "My mentor helped me pass, message me",
      "I can help you recover your lost funds",
      "whatsapp +1 555 010 0000 for accurate signals",
    ]) expect(isPromoSpam(text), text).toBe(true);
    for (const text of [
      "how does a trailing drawdown work?",
      "I moved my stop three times lol",
      "is my eval over if I hit the daily loss limit?",
      "what signals a trend change in order flow?",
      "dance",
    ]) expect(isPromoSpam(text), text).toBe(false);
  });

  it("the warning signs are fixed text that passes the speech checks, and the bot is muted", async () => {
    const { SIGNAL_SPAM_NOTICES, SpamWatch } = await import("../scripts/live-host/worker");
    const { checkSpokenLine } = await import("../src/liveHost/liveHostGuardrails");
    for (const notice of SIGNAL_SPAM_NOTICES) {
      expect(checkSpokenLine(`${notice.title}. ${notice.detail}`, { fillbookMentionAllowed: true, websiteMentionAllowed: false }), notice.title).toBeNull();
    }
    const watch = new SpamWatch();
    watch.mute("SignalBot", 600_000, 0);
    expect(watch.check("signalbot", "hello", 1000)).toBe("muted");
  });
});

