import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TtsDaemon, type TtsRequest } from "../scripts/live-host/ttsDaemon";

const HELPER = join(__dirname, "fixtures", "fakeTtsHelper.cjs");
const request = (voice: string): TtsRequest => ({ voice, rate: "+0%", textFile: "t.txt", mediaPath: "a.mp3", wordsPath: "w.json" });

async function warmDaemon(logs: string[] = []): Promise<TtsDaemon> {
  const daemon = new TtsDaemon(process.execPath, [HELPER], (line) => logs.push(line));
  daemon.start();
  for (let i = 0; i < 500 && !daemon.ready; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return daemon;
}

describe("TtsDaemon", () => {
  it("becomes ready once the helper says so and answers requests one after another", { timeout: 30_000 }, async () => {
    const daemon = await warmDaemon();
    expect(daemon.ready).toBe(true);
    await expect(daemon.synthesize(request("ok"), 15_000)).resolves.toBeUndefined();
    await expect(daemon.synthesize(request("ok"), 15_000)).resolves.toBeUndefined();
    daemon.stop();
  });

  it("rejects a line the helper could not synthesize, and stays usable", { timeout: 30_000 }, async () => {
    const daemon = await warmDaemon();
    await expect(daemon.synthesize(request("fail"), 15_000)).rejects.toThrow("boom");
    await expect(daemon.synthesize(request("ok"), 15_000)).resolves.toBeUndefined();
    daemon.stop();
  });

  it("gives up on a request that is never answered", { timeout: 30_000 }, async () => {
    const daemon = await warmDaemon();
    await expect(daemon.synthesize(request("hang"), 150)).rejects.toThrow("timed out");
    daemon.stop();
  });

  it("fails pending requests and reports not ready when the helper dies", { timeout: 30_000 }, async () => {
    const logs: string[] = [];
    const daemon = await warmDaemon(logs);
    await expect(daemon.synthesize(request("die"), 15_000)).rejects.toThrow(/stopped/);
    expect(daemon.ready).toBe(false);
    expect(logs.join(" ")).toContain("per-line voice");
    await expect(daemon.synthesize(request("ok"), 500)).rejects.toThrow("not ready");
  });

  it("is not ready, and does not throw, when the command does not exist", { timeout: 30_000 }, async () => {
    const logs: string[] = [];
    const daemon = new TtsDaemon("definitely-not-a-real-command-xyz", [], (line) => logs.push(line));
    daemon.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(daemon.ready).toBe(false);
    await expect(daemon.synthesize(request("ok"), 200)).rejects.toThrow("not ready");
    daemon.stop();
  });
});
