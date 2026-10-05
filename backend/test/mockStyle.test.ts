import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIC_MOCK_STYLE, MOCK_PALETTES, mockStyleFor } from "../src/shortform/mockStyle";
import { barsConvictionPlan } from "../src/shortform/chartBarsConcepts";
import { buildMockHtml, chromiumAvailable, createMockRenderer } from "../scripts/video-factory/mockCard";
import type { SceneSpec } from "../src/shortform/types";

const chromium = await chromiumAvailable();
const plan = barsConvictionPlan();
const frame = (s: SceneSpec, style = CLASSIC_MOCK_STYLE) => ({ chart: s.chart!, headline: s.headline, captionText: s.captionText, cta: s.cta, style });

describe("per-video mock style", () => {
  it("no index, and index 0, are the original look", () => {
    expect(mockStyleFor()).toEqual(CLASSIC_MOCK_STYLE);
    expect(mockStyleFor(0)).toEqual(CLASSIC_MOCK_STYLE);
    expect(CLASSIC_MOCK_STYLE.id).toBe("classic/left/classic");
    const s = plan.scenes[0]!;
    expect(buildMockHtml({ chart: s.chart!, headline: s.headline, captionText: s.captionText, cta: s.cta })).toBe(buildMockHtml(frame(s)));
  });

  it("consecutive videos differ in palette, alignment and window chrome, and no exact look returns within 16 videos", () => {
    for (let i = 0; i < 120; i++) {
      const a = mockStyleFor(i), b = mockStyleFor(i + 1);
      expect(a.palette.name, `${i}`).not.toBe(b.palette.name);
      expect(a.align, `${i}`).not.toBe(b.align);
      expect(a.chrome, `${i}`).not.toBe(b.chrome);
    }
    // 24 distinct looks, and no exact look comes back within 16 videos.
    const ids = Array.from({ length: 200 }, (_, i) => mockStyleFor(i).id);
    expect(new Set(ids).size).toBe(24);
    for (let i = 0; i < 16; i++) expect(ids.indexOf(ids[i]!), `${i}`).toBe(i);
    expect(mockStyleFor(-3)).toEqual(mockStyleFor(3));
    expect(mockStyleFor(Number.NaN)).toEqual(CLASSIC_MOCK_STYLE);
  });

  it("every palette keeps text and the good/bad colours readable on its own background", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (const p of MOCK_PALETTES) {
      for (const k of ["ink", "mute", "accent", "good", "bad"] as const) expect(ratio(p[k], p.bg1), `${p.name} ${k}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the markup carries the style: palette variables, centred text, chrome", () => {
    const sharp = buildMockHtml(frame(plan.scenes[0]!, mockStyleFor(1)));
    expect(mockStyleFor(1).id).toBe("violet/center/sharp");
    expect(sharp).toContain("--cyan:#a78bfa");
    expect(sharp).toContain(".label,.hero,.big,.caption{text-align:center}");
    expect(sharp).toContain(".win{border-radius:10px}");
    expect(sharp).toContain('data-origin="center center"');
    const soft = buildMockHtml(frame(plan.scenes[0]!, mockStyleFor(2)));
    expect(mockStyleFor(2).id).toBe("mono/left/soft");
    expect(soft).toContain("border-radius:46px");
    expect(soft).not.toContain(".label,.hero,.big,.caption{text-align:center}");
    expect(soft).toContain('data-origin="left center"');
  });

  it("only the light look draws the logo with a dark wordmark and a light window shadow", () => {
    const light = mockStyleFor(5);
    expect(light.palette.name).toBe("light");
    const html = buildMockHtml(frame(plan.scenes[0]!, light));
    expect(html).toContain("fillbook-horizontal-dark.svg");
    expect(html).toContain("--shadow:rgba(15,23,42,.16)");
    expect(buildMockHtml(frame(plan.scenes[0]!, mockStyleFor(0)))).toContain("fillbook-horizontal-white.svg");
    expect(MOCK_PALETTES.filter((p) => p.light).map((p) => p.name)).toEqual(["light"]);
  });

  it.skipIf(!chromium)("renders every beat in each palette, alignment and chrome with all boxes measured clear of the overlays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-style-"));
    const r = await createMockRenderer(dir);
    try {
      for (const idx of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const style = mockStyleFor(idx);
        for (const [i, s] of plan.scenes.entries()) expect(existsSync(await r.render(frame(s, style), join(dir, `${style.id.replace(/\//g, "_")}-${i}.png`))), `${style.id} beat ${i + 1}`).toBe(true);
      }
    } finally {
      await r.close();
    }
  }, 120_000);
});
