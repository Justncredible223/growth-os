/**
 * Short-form (TikTok / YouTube Shorts) production model. Pure data types; no I/O.
 *
 * The rule the whole model enforces: a scene's narration can only make a product
 * claim if that claim points at a fact in the verified-asset manifest, and the
 * fact's region is actually inside the crop the viewer sees. That is what makes it
 * impossible to silently pair a spoken line with an unrelated screenshot.
 */

export const OFFICIAL_HANDLE = "@fillbookhq";

export type Platform = "tiktok" | "youtube_shorts";
export type ScenePlatform = Platform | "both";

/** A rectangle in the SOURCE image's pixel coordinates (origin top-left). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AssetFact {
  key: string;
  /** What is literally visible in the region, in words. */
  text: string;
  /** Numbers/values visible in the region exactly as displayed. Any number a scene speaks or shows must appear here. */
  values: string[];
  topics: string[];
  region: Rect;
  /**
   * For a `screen_recording` asset only: the window (in the CLIP's own
   * seconds, not the scene's) during which `region` actually shows this
   * fact on screen -- e.g. a value revealed only after a scroll/expand
   * animation finishes. Omitted (or absent) means the fact holds for the
   * asset's full duration, same as every still-image fact today. Optional
   * and additive so every existing still-image fact stays valid unchanged.
   */
  timeRangeSeconds?: { start: number; end: number };
}

export interface PrivateRegion {
  region: Rect;
  kind: "email" | "name" | "account_id" | "other";
}

export interface VerifiedAsset {
  id: string;
  /** Path relative to scripts/video-factory/assets. */
  file: string;
  sha256: string;
  width: number;
  height: number;
  kind: "phone_ui" | "desktop_ui" | "recording_frame" | "screen_recording";
  /** Screens from different datasets must not appear in one video: their numbers can contradict each other. */
  dataset: string;
  source: string;
  capturedAt: string;
  /** Non-null means the data is demo/example data and the scene must show this exact label on screen. */
  dataLabel: string | null;
  /** False until the owner confirms the facts and regions in the contact sheet. Reported, never silently assumed. */
  verifiedByOwner: boolean;
  topics: string[];
  /** App bars/nav that must not appear in a crop unless the scene opts in. */
  chromeRegions: Rect[];
  /** Desktop only: the sidebar to remove. */
  sidebarRegion?: Rect;
  privateRegions: PrivateRegion[];
  facts: AssetFact[];
  /**
   * `screen_recording` only: the clip's own duration/frame rate, and the
   * capture spec that produced it (route, viewport, scripted read-only
   * interactions, dataset). Optional and additive -- a `phone_ui`/
   * `desktop_ui`/legacy `recording_frame` asset never sets these, so
   * nothing about a still-image asset changes shape.
   */
  durationSeconds?: number;
  fps?: number;
  captureSpec?: MotionCaptureSpec;
}

export type CaptureActionKind =
  | "open_page"
  | "wait_for_selector"
  | "scroll_to"
  | "expand_section"
  | "switch_tab"
  | "focus_element"
  | "hover_element"
  | "navigate";

/** One scripted, read-only interaction replayed during capture. Never a write action -- see MotionCaptureSpec's own doc comment for the allowlist this is drawn from. */
export interface CaptureAction {
  kind: CaptureActionKind;
  /** CSS selector or accessible role/name the action targets, when applicable. */
  selector?: string;
  /** Free-text target description for actions that aren't selector-driven (e.g. a route for "navigate", a tab label for "switch_tab"). */
  target?: string;
  /** Seconds into the capture window this action fires. */
  atSeconds: number;
}

/**
 * The full, reviewable spec for one motion-capture scene -- everything
 * Phase 4's Playwright driver needs to replay deterministically, and
 * everything the eventual motion report needs to prove what was actually
 * recorded. One of these produces exactly one `screen_recording`
 * VerifiedAsset (via `captureSpec` above) once run.
 */
export interface MotionCaptureSpec {
  sceneId: string;
  /** Local dev-server route, e.g. "/reports". Never a hosted/production URL. */
  route: string;
  viewport: { width: number; height: number };
  /** Human-readable description of what must be on screen before capture starts (asserted, not assumed -- the driver waits for it). */
  startState: string;
  /** Read-only interactions, in order. See CaptureActionKind for the allowlist -- no create/edit/delete/submit/sync action exists in this type at all. */
  actions: CaptureAction[];
  captureDurationSeconds: number;
  /** The region the viewer's eye should land on, in the CAPTURED FRAME's pixel coordinates. */
  focalRegion: Rect | null;
  crop: Rect | null;
  /** Regions that must stay masked in every frame of the clip, not just a single still. */
  privateRegions: PrivateRegion[];
  /** On-screen disclosure text confirming this is local fixture/demo data, never a real trader's account. */
  demoDataDisclosure: string;
  /** Identifies which seeded local dataset this capture depends on (e.g. matches VerifiedAsset.dataset). A capture against the wrong/stale dataset is a validation error, not a silent mismatch. */
  datasetId: string;
  /** What the render pipeline does if this capture fails or hasn't been run yet -- never a fabricated substitute. */
  fallback: "still_image" | "skip_scene";
}

export interface VerifiedManifest {
  version: number;
  note: string;
  assets: VerifiedAsset[];
}

/** An asset a plan needs that does not exist yet. The plan reports it instead of inventing a stand-in. */
export interface RequiredAsset {
  id: string;
  description: string;
  /** Fact keys the capture must contain for the plan's claims to be true. */
  mustShow: string[];
  dataset?: string;
}

export type ClaimType = "product_capability" | "data_point" | "behavior_flag" | "concept" | "invitation";

export interface ClaimEvidence {
  assetId: string;
  factKey: string;
}

export interface Claim {
  id: string;
  text: string;
  type: ClaimType;
  evidence: ClaimEvidence[];
}

export interface Mask {
  /** In source pixel coordinates, same space as crop. */
  region: Rect;
  label?: string;
}

export type SceneLayout = "full_card" | "fill" | "payoff" | "chart";

/**
 * "chart" scenes (the 2026-10 chart-card format): no screenshot at all. One short paradox line on a dark background and
 * ONE self-explaining chart drawn from numbers that come off a verified recording's facts, so the picture is the proof
 * ("17 green days. Still $1,484 short." over 18 squares and a payout bar). Opt-in per scene, like "payoff".
 *
 * The scene still names the recording it draws its numbers from (`assetId`) and cites its facts in `claims`, so the
 * usual evidence rules apply; it just has no crop, because nothing of the recording is shown. Every number the chart
 * draws is checked against those facts (see chart.ts), and the gap a progress bar shows is checked to be target - value.
 */
export type ChartTone = "good" | "bad";
export interface ChartGrid {
  /** Cells drawn: one per day (or trade). Must be supported by a cited fact, like every figure. */
  total: number;
  /** How many are good; the rest (total - good) are bad and sit at `badAt`. */
  good: number;
  /** Zero-based cell positions of the bad cells. */
  badAt: number[];
  cols: number;
}
export interface ChartProgress {
  /** Drawn above the bar, e.g. "Payout target: $9,000". */
  label: string;
  /** Amount reached and the target, in dollars. The missing part is drawn and labelled as target - value. */
  value: number;
  target: number;
  /** Drawn under the bar, e.g. "$1,484 to go". Must equal the dollar gap, rounded down to whole dollars. */
  gapLabel: string;
}
export interface ChartPair {
  aLabel: string;
  bLabel: string;
  /** The one figure both bars carry, e.g. "-$1,201". */
  value: string;
}
/**
 * One bar of an "outcomes" chart: a label, the figure drawn on it, and the amount (dollars, always positive) whose size
 * the bar's length shows. `tone` is the bar's colour: good (green) for wins, bad (red) for losses.
 */
export interface ChartBar {
  label: string;
  display: string;
  amount: number;
  tone: ChartTone;
}
/**
 * One row of a "bars" chart: the label (what the row is), the figure written on the bar, and the magnitude whose size
 * the bar's length shows (always positive; a negative figure is a "bad" bar). Every number in `label` and `display`
 * must appear in a fact the scene cites.
 */
export interface ChartRow {
  label: string;
  display: string;
  amount: number;
  tone: ChartTone;
}
/**
 * The arithmetic behind an illustrative "outcomes" chart: `trades` trades, `wins` of them winners averaging `avgWin`
 * dollars, the rest losers averaging `avgLoss`. Nothing here claims to be a real account: the scene is labelled
 * "Illustrative example", and chart.ts recomputes every figure the chart and its text show from these four numbers.
 */
export interface ChartIllustration {
  trades: number;
  wins: number;
  avgWin: number;
  avgLoss: number;
}
/** A big figure on a mock slide: a short label over a value drawn at up to 250px. The value must be a figure in a fact the scene cites. */
export interface MockHero {
  label: string;
  value: string;
  tone: ChartTone;
}
/**
 * One row of a mock window: a label, a small line under it and the figure on the right. `meter.markAt` (0-1) draws a bar under
 * the row with a tick where "your average" falls, which is 1 / the row's multiple (so the value must be a multiple such as "2.5x").
 * Every number in it must appear in a fact the scene cites.
 */
export interface MockRow {
  label: string;
  sub?: string;
  value: string;
  tone: ChartTone;
  meter?: { markAt: number };
}
/** A window of the product (a table of rows) drawn large enough to read on a phone. */
export interface MockWindow {
  title: string;
  rows: MockRow[];
}
/** Beats 2 and 3 of a mock: a hero figure above a window, with one of its rows ringed and the cursor on it. */
export interface MockFocus {
  hero: MockHero;
  /** Index into `windows`. */
  window: number;
  /** Index of the ringed row in that window. */
  row: number;
}
/** One line of a mock's detail card ("what else Fillbook shows"): a label and the figure beside it. Every number must be in a fact the scene cites. */
export interface MockDetailRow {
  label: string;
  value: string;
  tone: ChartTone;
}
/**
 * The "mock" chart kind: a product mock in the look of the site's own link-preview cards, laid out in HTML with the site's
 * fonts and colour tokens and rendered at the final 1080x1920 (geometry and limits are in mockLayout.ts). It shows WHERE in
 * the product a number comes from.
 *
 *   beat 1   one or two hero figures over the first window
 *   beat 2/3 a hero figure over a window with one row ringed and a cursor on it (`focus`)
 *   beat 4   the screen's other lines (`details`), under the beat's caption as a headline
 *   beat 5   the closing invitation, under the beat's caption as a headline
 */
export interface MockSpec {
  /** Must say "Demo data" for a recording that is demo data. Drawn on every slide. */
  tag: string;
  opening: MockHero[];
  windows: MockWindow[];
  focus: [MockFocus, MockFocus];
  /** Optional "where this came from" pill drawn between the hero figure and the window on beats 2 and 3 (for example "Fillbook Reports"). No digits. */
  via?: string;
  details?: { title: string; rows: MockDetailRow[]; footer: string };
}
export interface ChartSpec {
  kind: "grid_progress" | "pair" | "outcomes" | "bars" | "mock";
  /** The beat this scene reveals, 1-based. Earlier beats are drawn already complete; later beats are not drawn yet. */
  stage: number;
  /** The headline split into display lines. Joined with spaces they must equal the scene headline. */
  lines: string[];
  /** Colour of the last headline line. */
  accent: ChartTone;
  grid?: ChartGrid;
  progress?: ChartProgress;
  pair?: ChartPair;
  /** "outcomes" only: the total won and the total lost, drawn as two bars sized against each other. */
  bars?: [ChartBar, ChartBar];
  /** "mock" only: hook-first look (mockCard.ts): beat 1 is the headline and opening figures drawn large and fully visible from t=0, entrances on the later beats are short, and the "but" beat punches in. */
  hookFirst?: boolean;
  /** "mock" only: a product mock (source window, Fillbook step, result window) laid out in HTML and rendered to a still. */
  mock?: MockSpec;
  /** "bars" only: 2 to 5 labelled bars drawn from one recording's facts, sized against the largest. */
  rows?: ChartRow[];
  /** "bars" only: index of the row the third beat rings, so the eye lands on the one that matters. */
  highlight?: number;
  /** "outcomes" only: the net result, drawn large once its beat is reached, e.g. "-$2,000". */
  net?: { display: string; tone: ChartTone };
  /** "outcomes" only: the arithmetic every figure is checked against. */
  illustration?: ChartIllustration;
  /** Draw the chart dimmed, under the closing invitation. */
  dim?: boolean;
}

/**
 * "payoff" scenes (the 2026-09 retention redesign): frame one is one big number or claim -- the headline's first
 * token -- with a short line under it and ONE zoomed element of the real product below, on a bright or dark
 * background. Opt-in per scene, so no existing plan or approved script hash changes.
 */
export type PayoffTheme = "bright" | "dark";
/** "pop": the big number scales up into place. "count": it counts up to its value over the first ~0.5s. */
export type PayoffMotion = "pop" | "count";
export interface PayoffSpec {
  theme: PayoffTheme;
  motion: PayoffMotion;
  /** Draw an animated pointer that glides to the element being described and pulses once on arrival. Evidence scenes only. */
  cursor?: boolean;
  /** This evidence scene leads with words, not a figure (every scene after the hook may; the hook itself may not). */
  leadWithWords?: boolean;
}
export type AspectRatio = "9:16" | "4:5" | "1:1" | "source";
export type TransitionType = "cut" | "fade";

export interface SceneSpec {
  sceneId: string;
  narration: string;
  /** The one thing a viewer should take from this scene. */
  takeaway: string;
  /** Null only for a text-only card (a closing card, for example). */
  assetId: string | null;
  /** The region the viewer's eye should land on. Must sit inside the crop. */
  focalRegion: Rect | null;
  crop: Rect | null;
  aspectRatio: AspectRatio;
  layout: SceneLayout;
  headline: string;
  captionText: string;
  durationSeconds: number;
  transition: { type: TransitionType; durationSeconds: number };
  /** Visible text such as EXAMPLE DATA or the "based on recorded trades" qualification. */
  disclosure: string | null;
  cta: string | null;
  platform: ScenePlatform;
  experimentId: string;
  variationId: string;
  /** What this scene is about. Must overlap the asset's and the evidence facts' topics. */
  expectedTopics: string[];
  claims: Claim[];
  masks: Mask[];
  fontSizes?: { headline: number; caption: number };
  /** Required when `layout` is "payoff"; ignored otherwise. */
  payoff?: PayoffSpec;
  /** Required when `layout` is "chart"; ignored otherwise. */
  chart?: ChartSpec;
  /** Opt-ins for the rare deliberate exceptions. */
  allowChrome?: boolean;
  keepSidebar?: boolean;
  intentionalFullPage?: boolean;
  /**
   * When `assetId` points at a `screen_recording` VerifiedAsset, the
   * portion of that clip (in the CLIP's own seconds) this scene actually
   * uses -- distinct from `durationSeconds` above, which is how long the
   * scene plays in the FINAL VIDEO (a clip range can be trimmed/retimed).
   * Omitted for a still-image `assetId` or a text-only scene.
   */
  clipTimeRangeSeconds?: { start: number; end: number };
  /** Playback rate applied to the trimmed clip range above (1 = real-time). Never used to stretch a too-short clip to fill durationSeconds -- see scenePlan.ts's validateScenePlan, which errors on insufficient footage instead of implicitly slowing it down to fit. */
  playbackSpeed?: number;
  /**
   * The capture spec that either already produced this scene's asset, or
   * still needs to be run to produce it. Present on a motion scene even
   * before capture happens -- see `motionCapture.ts`'s doc comment for how
   * a scene moves from "spec only" to "spec + real captured asset."
   */
  motionCapture?: MotionCaptureSpec;
}

export interface ScenePlan {
  planId: string;
  title: string;
  series: string;
  topic: string;
  hook: string;
  experimentId: string;
  variationId: string;
  platforms: Platform[];
  voice: string;
  visualStyle: string;
  scenes: SceneSpec[];
  requiredAssets: RequiredAsset[];
  /**
   * "none": the video has no spoken narration, only on-screen text, a chart and the music bed. The scenes' `narration`
   * still holds the sentence each scene says in text (it is what the claim checks read). Omitted means narrated.
   */
  voiceover?: "narrated" | "none";
}

export type IssueSeverity = "error" | "review";

export interface PlanIssue {
  severity: IssueSeverity;
  code: string;
  sceneId?: string;
  message: string;
}

export interface PlanValidation {
  /** No error-severity issues. A plan with a missing asset is never ok. */
  ok: boolean;
  /** True when at least one required source asset does not exist yet. */
  blockedByMissingAssets: boolean;
  missingAssets: RequiredAsset[];
  issues: PlanIssue[];
}
