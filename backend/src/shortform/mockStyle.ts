/**
 * Per-video look for the "mock" chart kind, so neighbouring videos do not all share one palette and one layout.
 *
 * A style is picked once per video from its render index (the same counter that rotates the music), and every beat of that
 * video uses it. Consecutive indices always differ in palette, text alignment and window chrome. Index 0, and no index at all, is the original look, so previews and
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
  /** Colour of the shadow under a window (a soft dark one on a dark slide, a light one on a bright slide). */
  shadow: string;
  /** A bright slide: the logo is drawn with a dark wordmark. */
  light?: boolean;
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
  { name: "classic", bg0: "#07090d", bg1: "#0d1117", bg2: "#111720", line: "#1f2b35", ink: "#e7edf3", mute: "#a9b7c4", dim: "#7f8e9b", accent: "#22b8dc", good: "#34d399", bad: "#f87171", glow: "#0c2a33", glowAt: "88% 6%", ctaBg: "#0b2b34", ctaBorder: "#14566a", dot: "#252f3b", meter: "#1b2531", shadow: "rgba(0,0,0,.55)" },
  { name: "violet", bg0: "#090812", bg1: "#120f1f", bg2: "#19142a", line: "#2a2342", ink: "#efeaf9", mute: "#bab1d2", dim: "#8e85a8", accent: "#a78bfa", good: "#34d399", bad: "#fb7185", glow: "#2a1f50", glowAt: "12% 5%", ctaBg: "#261c4d", ctaBorder: "#5b4a9a", dot: "#33294f", meter: "#231b37", shadow: "rgba(0,0,0,.55)" },
  { name: "mono", bg0: "#08090a", bg1: "#101113", bg2: "#16181b", line: "#2a2d33", ink: "#e5e7eb", mute: "#b4b8be", dim: "#868b93", accent: "#ffffff", good: "#34d399", bad: "#f87171", glow: "#22262c", glowAt: "88% 6%", ctaBg: "#1a1d21", ctaBorder: "#3f444c", dot: "#2a2e34", meter: "#20242a", shadow: "rgba(0,0,0,.55)" },
  { name: "emerald", bg0: "#050b09", bg1: "#0a1512", bg2: "#0f1c18", line: "#1c332c", ink: "#e6f4ee", mute: "#a6c4b8", dim: "#78978a", accent: "#2dd4bf", good: "#4ade80", bad: "#f87171", glow: "#0b3a2f", glowAt: "50% 2%", ctaBg: "#0b3a30", ctaBorder: "#1b7d68", dot: "#1f3a32", meter: "#152a24", shadow: "rgba(0,0,0,.55)" },
  { name: "sky", bg0: "#060a14", bg1: "#0b1324", bg2: "#101a30", line: "#1d2d4a", ink: "#e9f0fb", mute: "#aebcd6", dim: "#7f90ad", accent: "#60a5fa", good: "#34d399", bad: "#f87171", glow: "#10305e", glowAt: "10% 8%", ctaBg: "#0f2a55", ctaBorder: "#2a5fa8", dot: "#223656", meter: "#16233c", shadow: "rgba(0,0,0,.55)" },
  { name: "light", bg0: "#f6f8fb", bg1: "#ffffff", bg2: "#eef2f7", line: "#d5dde7", ink: "#0b1220", mute: "#3c4a5c", dim: "#66758a", accent: "#0e7490", good: "#047857", bad: "#b91c1c", glow: "#d9eefb", glowAt: "88% 6%", ctaBg: "#e0f2fe", ctaBorder: "#7dd3fc", dot: "#cbd5e1", meter: "#e2e8f0", shadow: "rgba(15,23,42,.16)", light: true },
];

const ALIGNS: readonly MockAlign[] = ["left", "center"];
const CHROMES: readonly MockChrome[] = ["classic", "sharp", "soft"];

/**
 * The style for the video at `index` (its position in the render rotation). No index, or 0, is the original look.
 * The palette steps by one each video and shifts by one more every full cycle, so consecutive videos always differ in
 * palette; alignment alternates each video; window chrome steps by one and shifts every 3 videos (so it always changes
 * too, and drifts against the palette instead of being tied to it).
 */
export function mockStyleFor(index?: number): MockStyle {
  const i = index !== undefined && Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  const cycle = Math.floor(i / MOCK_PALETTES.length);
  const palette = MOCK_PALETTES[(i + cycle) % MOCK_PALETTES.length]!;
  const align = ALIGNS[i % ALIGNS.length]!;
  const chrome = CHROMES[(i + Math.floor(i / CHROMES.length)) % CHROMES.length]!;
  return { id: `${palette.name}/${align}/${chrome}`, palette, align, chrome };
}

export const CLASSIC_MOCK_STYLE: MockStyle = mockStyleFor(0);
