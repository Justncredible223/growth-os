import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRESH_PILOTS } from "../src/shortform/freshConcepts";
import { DAILY_PILOTS } from "../src/shortform/dailyConcepts";
import { BARS_PILOTS } from "../src/shortform/chartBarsConcepts";
import { HOOK_MOTION, HOOK_VALUE_WIDTH, MOCK_BOXES, scaledAboutCentre } from "../src/shortform/mockLayout";
import { loadManifest, validateScenePlan } from "../src/shortform/scenePlan";
import { renderBar } from "../src/shortform/storyScore";
import { PLATFORM_OVERLAY_ZONES } from "../scripts/video-factory/render";
import { MOCK_ENTRANCE, beatFrameCount, buildMockHtml, chromiumAvailable, createMockRenderer } from "../scripts/video-factory/mockCard";
import type { SceneSpec } from "../src/shortform/types";

const manifest = loadManifest();
const chromium = await chromiumAvailable();
const frame = (s: SceneSpec) => ({ chart: s.chart!, headline: s.headline, captionText: s.captionText, cta: s.cta, holdSeconds: s.durationSeconds });
const escText = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe("hookFirst: the first second of the fresh pool's mock cards", () => {
  it("every offered fresh plan opts in; the older plans keep their look", () => {
    for (const p of FRESH_PILOTS) expect(p.scenes.every((s) => s.chart?.hookFirst === true), p.planId).toBe(true);
    for (const p of [...DAILY_PILOTS, ...BARS_PILOTS]) expect(p.scenes.some((s) => s.chart?.hookFirst), p.planId).toBe(false);
  });

  it("the fresh plans still validate and clear the A/A+ render bar", () => {
    for (const p of FRESH_PILOTS) {
      expect(validateScenePlan(p, manifest, { checkFiles: true }).issues.filter((i) => i.severity === "error"), p.planId).toEqual([]);
      expect(renderBar(p).ok, p.planId).toBe(true);
    }
  });

  it("frame 0 of beat 1 already shows the hook headline and every opening figure, with no fade, slide or pop entrance", () => {
    for (const p of FRESH_PILOTS) {
      const s = p.scenes[0]!;
      const html = buildMockHtml(frame(s));
      for (const line of s.chart!.lines) expect(html, `${p.planId} hook line`).toContain(escText(line));
      for (const fig of s.chart!.mock!.opening) {
        expect(html, p.planId).toContain(escText(fig.label));
        expect(html, p.planId).toContain(`>${escText(fig.value)}</div>`);
      }
      // Entrance kinds (data-a) are the only things that start at opacity 0; none may be on the hook beat. Motion (data-hook) never touches opacity.
      expect(html, `${p.planId} beat 1 has an entrance animation`).not.toMatch(/data-a="/);
      expect(html.replace(/<(style|script)>[\s\S]*?<\/\1>/g, "")).not.toMatch(/opacity:\s*0\b/);
      expect([...html.matchAll(/data-hook="(\w+)"/g)].map((m) => m[1]).sort()).toEqual(["pulse", "push"]);
      expect(html).not.toContain('data-fast="1"');
      expect(html).toContain("Demo data".toUpperCase());
    }
  });

  it("later beats use the short entrance and the 'but' beat (3) punches in its figure; beats 2, 4 and 5 do not", () => {
    expect(HOOK_MOTION.entranceSeconds).toBeLessThanOrEqual(0.5);
    expect(HOOK_MOTION.punchAtMs + HOOK_MOTION.punchMs).toBeLessThanOrEqual(500);
    for (const p of FRESH_PILOTS) {
      p.scenes.forEach((s, i) => {
        const html = buildMockHtml(frame(s));
        if (i === 0) return;
        expect(html, `${s.sceneId} short entrance`).toContain('data-fast="1"');
        expect((html.match(/data-hook="punch"/g) ?? []).length, s.sceneId).toBe(i === 2 ? 1 : 0);
        // A hookFirst entrance starts within 0.25 s of the beat (delays are quartered).
        for (const m of html.matchAll(/data-d="(\d+)"/g)) expect(Number(m[1]), s.sceneId).toBeLessThanOrEqual(250);
      });
    }
  });

  it("the plain look is untouched: no hookFirst markup on a daily concept, and its entrance is still 1 second", () => {
    for (const s of DAILY_PILOTS[0]!.scenes) {
      const html = buildMockHtml(frame(s));
      expect(html).not.toContain("data-hook=");
      expect(html).not.toContain('data-fast="1"');
      expect(beatFrameCount(frame(s))).toBe(MOCK_ENTRANCE.seconds * MOCK_ENTRANCE.fps);
    }
  });

  it("the hook beat is drawn for its whole hold (so the push-in is not cut), later beats for the short entrance", () => {
    for (const p of FRESH_PILOTS) {
      expect(beatFrameCount(frame(p.scenes[0]!))).toBe(Math.round(p.scenes[0]!.durationSeconds * MOCK_ENTRANCE.fps));
      expect(beatFrameCount(frame(p.scenes[1]!))).toBe(Math.round(HOOK_MOTION.entranceSeconds * MOCK_ENTRANCE.fps));
    }
  });

  it("the hook blocks and every motion on them stay clear of the platform overlays (x < 930, bottom < 1220 and well above 1600)", () => {
    const { rightColumn, captionTop } = PLATFORM_OVERLAY_ZONES;
    for (const name of ["hookText", "hookFigs"] as const) {
      const b = MOCK_BOXES[name];
      // The whole block pushes in, and the first figure can pulse on top of that.
      const pushed = scaledAboutCentre(b, HOOK_MOTION.push);
      expect(pushed.x + pushed.w, name).toBeLessThan(rightColumn.x);
      expect(pushed.y + pushed.h, name).toBeLessThan(1220);
      expect(pushed.y + pushed.h, name).toBeLessThan(captionTop);
      expect(pushed.y, name).toBeGreaterThan(150);
    }
    // A pulsing value, scaled from its left edge (inside a tile's padding) on top of the push-in, stays left of x=930.
    const tileLeft = MOCK_BOXES.hookFigs.x + 2 + 30;
    const pulsedRight = tileLeft + HOOK_VALUE_WIDTH * HOOK_MOTION.pulse;
    expect(scaledAboutCentre({ x: 0, y: 0, w: pulsedRight, h: 1 }, HOOK_MOTION.push).w + (MOCK_BOXES.hookFigs.x + MOCK_BOXES.hookFigs.w) / 2 - pulsedRight / 2).toBeLessThan(rightColumn.x);
    // The punched figure (a hero box scaled about its centre).
    const punched = scaledAboutCentre(MOCK_BOXES.hero, HOOK_MOTION.punch);
    expect(punched.x + punched.w).toBeLessThan(rightColumn.x);
  });

  it.skipIf(!chromium)("the rendered first frame of the hook beat is as full as the finished slide (not the empty frame of a build-in) and the sequence covers the hold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-seq-"));
    const r = await createMockRenderer(dir);
    try {
      for (const p of FRESH_PILOTS.slice(0, 3)) {
        const s = p.scenes[0]!;
        const beat = await r.renderBeat(frame(s), dir, `h-${p.planId}`);
        expect(beat.count).toBe(Math.round(s.durationSeconds * MOCK_ENTRANCE.fps));
        const first = statSync(join(dir, `h-${p.planId}-000.png`)).size;
        const finished = statSync(beat.stillPath).size;
        expect(first / finished, p.planId).toBeGreaterThan(0.85);
      }
    } finally {
      await r.close();
    }
  }, 120_000);
});
