import { describe, expect, it } from "vitest";
import { durableRenderCapReason, renderCapWindows } from "../src/video/durableRenderCaps";

function client(monthCount: number, dayCount: number) {
  return {
    from: () => {
      const q: any = { since: "" };
      q.select = () => q;
      q.eq = () => q;
      q.gte = (_c: string, v: string) => ((q.since = v), Promise.resolve({ count: v.endsWith("-01T00:00:00.000Z") ? monthCount : dayCount, error: null }));
      return q;
    },
  } as any;
}

describe("render caps from durable history (P2 2026-11-15)", () => {
  const now = new Date("2026-11-16T05:00:00Z"); // Nov 15, 10pm in Arizona
  it("uses the UTC month and the Arizona day", () => {
    expect(renderCapWindows(now)).toEqual({ monthStart: "2026-11-01T00:00:00.000Z", dayStart: "2026-11-15T07:00:00.000Z" });
  });
  it("refuses at the monthly or daily cap and allows below them", async () => {
    expect(await durableRenderCapReason(client(100, 0), now)).toMatch(/^monthly_render_cap_reached \(100/);
    expect(await durableRenderCapReason(client(5, 3), now)).toMatch(/^daily_render_cap_reached \(3/);
    expect(await durableRenderCapReason(client(5, 1), now)).toBeNull();
  });
});
