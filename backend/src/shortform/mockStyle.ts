/**
 * Per-video look for the "mock" chart kind, so neighbouring videos do not all share one palette and one layout.
 *
 * A style is picked once per video from its render index (the same counter that rotates the music), and every beat of that
 * video uses it. Consecutive indices differ in palette, text alignment and window chrome (the three moduli 5, 2 and 3 are
 * coprime, so a style repeats only every 30 videos). Index 0, and no index at all, is the original look, so previews and
 * tests that pass nothing are unchanged.
 *
 * A style only recolours and re-aligns inside the fixed boxes of mockLayout.ts. It never moves a box, so every style stays
 * clear of the platform overlays by construction, and the renderer still measures each slide to prove it.
 */
export interface MockPalette {
  name: string;
  bg0: string;
  bg1: string;
  bg2: string;
  line: string;
  ink: string;
  mute: string;
  dim: string;
  accent: string;
  good: string;
  bad: string;
  /** Colour of the soft light behind the top of the slide, and where it sits. */
  glow: string;
  glowAt: string;
  ctaBg: string;
  ctaBorder: string;
  dot: string;
  meter: string;
}

export type MockAlign = "left" | "center";
export type MockChrome = "classic" | "sharp" | "soft";

export interface MockStyle {
  /** Stable name, for logs and tests (for example "violet/center/soft"). */
  id: string;
  palette: MockPalette;
  align: MockAlign;
  chrome: MockChrome;
}

export const MOCK_PALETTES: readonly MockPalette[] = [
  { name: "classic", bg0: "#07090d", bg1: "#0d1117", bg2: "#111720", line: "#1f2b35", ink: "#e7edf3", mute: "#a9b7c4", dim: "#7f8e9b", accent: "#22b8dc", good: "#34d399", bad: "#f87171", glow: "#0c2a33", glowAt: "88% 6%", ctaBg: "#0b2b34", ctaBorder: "#14566a", dot: "#252f3b", meter: "#1b2531" },
  { name: "violet", bg0: "#090812", bg1: "#120f1f", bg2: "#19142a", line: "#2a2342", ink: "#efeaf9", mute: "#bab1d2", dim: "#8e85a8", accent: "#a78bfa", good: "#34d399", bad: "#fb7185", glow: "#2a1f50", glowAt: "12% 5%", ctaBg: "#261c4d", ctaBorder: "#5b4a9a", dot: "#33294f", meter: "#231b37" },
  { name: "amber", bg0: "#0b0905", bg1: "#14100a", bg2: "#1b150d", line: "#33281a", ink: "#f6efe4", mute: "#cdbfa8", dim: "#9c8e78", accent: "#fbbf24", good: "#4ade80", bad: "#f87171", glow: "#3a290c", glowAt: "90% 4%", ctaBg: "#382808", ctaBorder: "#8a6a1c", dot: "#3a2d1c", meter: "#2a2013" },
  { name: "emerald", bg0: "#050b09", bg1: "#0a1512", bg2: "#0f1c18", line: "#1c332c", ink: "#e6f4ee", mute: "#a6c4b8", dim: "#78978a", accent: "#2dd4bf", good: "#4ade80", bad: "#f87171", glow: "#0b3a2f", glowAt: "50% 2%", ctaBg: "#0b3a30", ctaBorder: "#1b7d68", dot: "#1f3a32", meter: "#152a24" },
  { name: "sky", bg0: "#060a14", bg1: "#0b1324", bg2: "#101a30", line: "#1d2d4a", ink: "#e9f0fb", mute: "#aebcd6", dim: "#7f90ad", accent: "#60a5fa", good: "#34d399", bad: "#f87171", glow: "#10305e", glowAt: "10% 8%", ctaBg: "#0f2a55", ctaBorder: "#2a5fa8", dot: "#223656", meter: "#16233c" },
];

const ALIGNS: readonly MockAlign[] = ["left", "center"];
const CHROMES: readonly MockChrome[] = ["classic", "sharp", "soft"];

/** The style for the video at `index` (its position in the render rotation). No index, or 0, is the original look. */
export function mockStyleFor(index?: number): MockStyle {
  const i = index !== undefined && Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  const palette = MOCK_PALETTES[i % MOCK_PALETTES.length]!;
  const align = ALIGNS[i % ALIGNS.length]!;
  const chrome = CHROMES[i % CHROMES.length]!;
  return { id: `${palette.name}/${align}/${chrome}`, palette, align, chrome };
}

export const CLASSIC_MOCK_STYLE: MockStyle = mockStyleFor(0);
