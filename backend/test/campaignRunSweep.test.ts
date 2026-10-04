import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STUCK_CAMPAIGN_RUN_MINUTES, STUCK_RUN_ERROR, expireStuckCampaignRuns, stuckRunCutoff } from "../src/video/campaignRunSweep";

const NOW = new Date("2026-10-04T15:00:00.000Z");

/** A chainable fake of the two calls the sweep makes: select(...).in(...).lt(...) and update(...).in(...).in(...). */
function fakeClient(stuckIds: string[], opts: { selectError?: string; updateError?: string } = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const chain = (op: string, result: () => unknown) => {
    const b: any = {
      in: (...args: unknown[]) => { calls.push({ op: `${op}.in`, args }); return b; },
      lt: (...args: unknown[]) => { calls.push({ op: `${op}.lt`, args }); return b; },
      then: (resolve: (v: unknown) => void) => resolve(result()),
    };
    return b;
  };
  return {
    client: {
      from: (table: string) => {
        calls.push({ op: "from", args: [table] });
        return {
          select: (cols: string) => { calls.push({ op: "select", args: [cols] }); return chain("select", () => (opts.selectError ? { data: null, error: { message: opts.selectError } } : { data: stuckIds.map((id) => ({ id })), error: null })); },
          update: (row: unknown) => { calls.push({ op: "update", args: [row] }); return chain("update", () => (opts.updateError ? { error: { message: opts.updateError } } : { error: null })); },
        };
      },
    } as never,
    calls,
  };
}

describe("expiring draft runs that never finished", () => {
  it("looks for queued or running requests with no update in the last 25 minutes", async () => {
    expect(STUCK_CAMPAIGN_RUN_MINUTES).toBe(25);
    expect(stuckRunCutoff(NOW)).toBe("2026-10-04T14:35:00.000Z");
    const { client, calls } = fakeClient([]);
    expect(await expireStuckCampaignRuns(client, NOW)).toBe("no stuck draft runs");
    expect(calls.find((c) => c.op === "select.in")!.args).toEqual(["status", ["queued", "running"]]);
    expect(calls.find((c) => c.op === "select.lt")!.args).toEqual(["updated_at", "2026-10-04T14:35:00.000Z"]);
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("marks each stuck request failed with a plain reason, and only if it is still queued or running", async () => {
    const { client, calls } = fakeClient(["run-1", "run-2"]);
    expect(await expireStuckCampaignRuns(client, NOW)).toMatch(/expired 2 stuck draft runs/);
    expect(calls.find((c) => c.op === "update")!.args[0]).toEqual({ status: "failed", error: STUCK_RUN_ERROR, updated_at: NOW.toISOString() });
    const ins = calls.filter((c) => c.op === "update.in").map((c) => c.args);
    expect(ins).toEqual([["id", ["run-1", "run-2"]], ["status", ["queued", "running"]]]);
    expect(STUCK_RUN_ERROR).toMatch(/Request it again/);
  });

  it("says one run, not one runs", async () => {
    const { client } = fakeClient(["run-1"]);
    expect(await expireStuckCampaignRuns(client, NOW)).toMatch(/expired 1 stuck draft run /);
  });

  it("fails loudly when the database call fails, so the pulse step shows red", async () => {
    await expect(expireStuckCampaignRuns(fakeClient([], { selectError: "boom" }).client, NOW)).rejects.toThrow(/lookup failed: boom/);
    await expect(expireStuckCampaignRuns(fakeClient(["a"], { updateError: "nope" }).client, NOW)).rejects.toThrow(/could not expire.*nope/);
  });

  it("runs as its own step in the growth pulse, before the daily refill so a freed day can be used", () => {
    const src = readFileSync(join(__dirname, "..", "api/growth-pulse.ts"), "utf-8");
    expect(src).toContain('runStep("campaign_run_sweep"');
    expect(src.indexOf('runStep("campaign_run_sweep"')).toBeLessThan(src.indexOf('runStep("chart_card_requests"'));
  });
});
