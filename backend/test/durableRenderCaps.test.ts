import { describe, expect, it } from "vitest";
import { durableRenderCapReason, renderCapWindows } from "../src/video/durableRenderCaps";

function client(monthAssets: string[], dayAssets: string[]) {
  return {
    from: () => {
      const q: any = {};
      q.select = () => q;
      q.eq = () => q;
      q.gte = (_c: string, v: string) => ((q.month = v.endsWith("-01T00:00:00.000Z")), q);
      q.limit = () => Promise.resolve({ data: (q.month ? monthAssets : dayAssets).map((a) => ({ payload: { campaignAssetId: a } })), error: null });
      return q;
    },
  } as any;
}

describe("render caps from durable history (P2 2026-11-15)", () => {
  const now = new Date("2026-11-16T05:00:00Z"); // Nov 15, 10pm in Arizona
  it("uses the UTC month and the Arizona day", () => {
    expect(renderCapWindows(now)).toEqual({ monthStart: "2026-11-01T00:00:00.000Z", dayStart: "2026-11-15T07:00:00.000Z" });
  });
  it("counts distinct videos, so retries of one video are not separate videos", async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `a${i}`);
    expect(await durableRenderCapReason(client(hundred, []), now)).toMatch(/^monthly_render_cap_reached \(100/);
    expect(await durableRenderCapReason(client(["a1"], ["x", "y", "z"]), now)).toMatch(/^daily_render_cap_reached \(3/);
    expect(await durableRenderCapReason(client(["a1"], ["x", "x", "x", "x"]), now)).toBeNull();
  });
});
