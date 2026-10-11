import { describe, expect, it } from "vitest";
import { pickRundownSegment, rundownBlockAt } from "../src/liveHost/liveHostRundown.js";
import { OVERRUN_BLOCK, RUNDOWN } from "../src/liveHost/showRundownConfig.js";
import { LIVE_HOST_SEGMENTS } from "../src/liveHost/liveHostPersona.js";
import { buildTrackedUrl, slugify } from "../src/liveHost/liveHostLinks.js";

describe("show rundown", () => {
  it("maps minutes to blocks and never replays the rundown after the last block", () => {
    expect(rundownBlockAt(0).id).toBe("opening");
    expect(rundownBlockAt(2).id).toBe("overview");
    expect(rundownBlockAt(33).id).toBe("demo");
    expect(rundownBlockAt(59.9).id).toBe("recap");
    expect(rundownBlockAt(60).id).toBe("extended");
    expect(rundownBlockAt(600).id).toBe("extended");
  });

  it("only names segments that exist, and none that are retired", () => {
    for (const block of [...RUNDOWN, OVERRUN_BLOCK]) {
      for (const id of block.segmentIds) {
        const segment = LIVE_HOST_SEGMENTS.find((candidate) => candidate.id === id);
        expect(segment, `${block.id}:${id}`).toBeDefined();
        expect(segment!.retired, `${block.id}:${id}`).toBeFalsy();
      }
    }
  });

  it("never repeats the segment just said and prefers the least recently used", () => {
    const picked = pickRundownSegment({ elapsedMinutes: 25, recentSegmentIds: ["famous_last_words", "tilt_o_meter", "eval_graveyard"], fillbookSpotAllowed: false, random: () => 0 });
    expect(picked.block.id).toBe("psychology");
    expect(picked.segment.id).toBe("rate_my_excuse");
    const next = pickRundownSegment({ elapsedMinutes: 25, recentSegmentIds: ["rate_my_excuse", "famous_last_words", "tilt_o_meter"], fillbookSpotAllowed: false, random: () => 0 });
    expect(next.segment.id).toBe("eval_graveyard");
  });

  it("uses earlier streams as the tiebreak so episodes differ", () => {
    const picked = pickRundownSegment({ elapsedMinutes: 25, recentSegmentIds: [], priorUseCounts: { famous_last_words: 5, tilt_o_meter: 5, eval_graveyard: 0, rate_my_excuse: 5 }, fillbookSpotAllowed: false, random: () => 0 });
    expect(picked.segment.id).toBe("eval_graveyard");
  });

  it("keeps the Fillbook spot out of the pool unless it is allowed", () => {
    const off = pickRundownSegment({ elapsedMinutes: 35, recentSegmentIds: [], fillbookSpotAllowed: false, random: () => 0 });
    expect(off.segment.isFillbookSpot).toBeFalsy();
    const on = pickRundownSegment({ elapsedMinutes: 35, recentSegmentIds: [], fillbookSpotAllowed: true, random: () => 0 });
    expect(["fillbook_spot", "journal_prompt"]).toContain(on.segment.id);
  });

  it("keeps rotating on a long overrun", () => {
    const seen = new Set<string>();
    const recent: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { segment } = pickRundownSegment({ elapsedMinutes: 120, recentSegmentIds: [...recent].reverse(), fillbookSpotAllowed: false, random: () => 0 });
      seen.add(segment.id);
      recent.push(segment.id);
      expect(segment.id).not.toBe(recent[recent.length - 2]);
    }
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });
});

describe("tracked links", () => {
  it("uses the site's campaign conventions and the canonical host", () => {
    const url = new URL(buildTrackedUrl({ placement: "live", episode: "2026-10-12" }));
    expect(url.origin + url.pathname).toBe("https://www.fillbookhq.com/");
    expect(url.searchParams.get("utm_source")).toBe("youtube");
    expect(url.searchParams.get("utm_medium")).toBe("video");
    expect(url.searchParams.get("utm_campaign")).toBe("fillbook-live-2026-10-12");
    expect(url.searchParams.get("utm_content")).toBe("live");
    expect(new URL(buildTrackedUrl({ placement: "description" })).searchParams.get("utm_medium")).toBe("description");
    expect(new URL(buildTrackedUrl({ placement: "pinned-comment", path: "/pricing" })).pathname).toBe("/pricing");
  });

  it("refuses a destination that is not a safe relative path", () => {
    expect(() => buildTrackedUrl({ placement: "live", path: "//evil.example" })).toThrow();
    expect(() => buildTrackedUrl({ placement: "live", path: "https://evil.example" })).toThrow();
    expect(() => buildTrackedUrl({ placement: "live", path: "/a b" })).toThrow();
  });

  it("slugifies episode labels", () => {
    expect(slugify("Episode #4: Drawdown!")).toBe("episode-4-drawdown");
  });
});
