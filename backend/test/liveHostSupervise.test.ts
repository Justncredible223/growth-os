import { describe, expect, it } from "vitest";
import { HEALTHY_RUN_MS, RESTART_MAX_MS, RESTART_MIN_MS, nextRestartDelay } from "../scripts/live-host/supervise";

describe("nextRestartDelay", () => {
  it("starts at the minimum and doubles on quick crashes, up to the maximum", () => {
    let delay: number | null = null;
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      delay = nextRestartDelay(delay, 5_000);
      seen.push(delay);
    }
    expect(seen[0]).toBe(RESTART_MIN_MS);
    expect(seen[1]).toBe(RESTART_MIN_MS * 2);
    expect(seen[2]).toBe(RESTART_MIN_MS * 4);
    expect(Math.max(...seen)).toBe(RESTART_MAX_MS);
  });

  it("goes back to the minimum after a healthy run", () => {
    expect(nextRestartDelay(48_000, HEALTHY_RUN_MS)).toBe(RESTART_MIN_MS);
    expect(nextRestartDelay(48_000, HEALTHY_RUN_MS - 1)).toBe(RESTART_MAX_MS);
  });
});
