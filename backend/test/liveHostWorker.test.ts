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
