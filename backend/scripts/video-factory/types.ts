/**
 * Shared types for the local Video Factory CLI. This tool is intentionally
 * NOT part of the backend/ Vercel deployment -- it never runs in a
 * serverless function, only on the operator's own machine, invoked by
 * hand. See docs/VIDEO_FACTORY.md for the full flow.
 */

export class VideoFactoryError extends Error {}

/**
 * The explicit, validated reference an approved script carries when it was
 * generated FOR a specific verified ScenePlan (src/shortform/pilots.ts) --
 * never inferred from matching text. `scenePlanHash` is
 * computeScenePlanHash's output at GENERATION time; a render-time consumer
 * recomputes it from the CURRENT plan and refuses to render on any
 * mismatch (stale/modified plan, or a tampered/incorrect reference) rather
 * than substituting that plan's content for whatever the approved script
 * actually says. See motionCatalog.ts's resolveMotionScenePlan.
 */
export interface MotionScenePlanRef {
  scenePlanId: string;
  scenePlanHash: string;
}

/** The structured production package, same shape as backend/src/content/videoScriptWriter.ts's VideoScript. */
export interface VideoScript {
  hook: string;
  script: string;
  shotList: string[];
  youtubeTitle: string;
  youtubeDescription: string;
  tiktokCaption: string;
  hashtags: string[];
  disclosureCta: string | null;
  /** Present only when this script was generated for a specific verified-motion concept (never for a free-text/opportunity-derived script). Null/undefined means "no motion requested" -- the normal stock-footage/UI-screenshot path. */
  motionScenePlan?: MotionScenePlanRef | null;
}

/**
 * Everything the renderer needs, already validated and confirmed
 * human-approved. `approvedAt` is REQUIRED and is the one field the
 * approval gate checks -- see loadApprovedScript.ts's assertApproved.
 */
export interface VideoScriptPackage {
  draftId: string;
  campaignTitle: string;
  platform: string;
  assetType: string;
  videoScript: VideoScript;
  approvedBy: string | null;
  approvedAt: string;
}

/** Real per-word timing from edge_tts_words.py's WordBoundary capture (see voiceover.ts). */
export interface WordCue {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

/**
 * One on-screen caption frame: `text` is already-assembled, ASS-ready
 * markup (see captions.ts's buildWordHighlightCues) -- the full on-screen
 * phrase with the currently-spoken word wrapped in an inline colour
 * override tag, not plain text. buildAssFile interpolates it directly into
 * the Dialogue line rather than re-escaping it.
 */
export interface CaptionCue {
  text: string;
  startSeconds: number;
  endSeconds: number;
  style: "Hook" | "Caption" | "Outro" | "Card" | "Pay" | "Chart";
  /** Per-cue vertical margin (the "Card" style is top-anchored, so this is the text block's top y). */
  marginV?: number;
  /** ASS layer (default 0). Higher layers draw on top, e.g. the payoff pointer above the text. */
  layer?: number;
}

export type SceneKind = "hook" | "product" | "metric" | "cta" | "explanation";

export interface Scene {
  kind: SceneKind;
  label: string;
  durationSeconds: number;
  backgroundColor: string; // ffmpeg lavfi color spec, e.g. "0x05070a"
  clipPath?: string; // absolute path to a loopable video file; undefined falls back to solid color
  imagePath?: string; // absolute path to a UI screenshot; rendered as a slow vertical pan. Takes precedence over clipPath.
  shot?: string; // the approved shot-list description this scene came from (used to pick a matching UI screenshot)
  narration?: string; // the words spoken while this scene is on screen (used to pick footage that matches what is being said)
  /**
   * Only meaningful with `clipPath`. When set, this scene's clip is a real,
   * verified recording (e.g. src/shortform's `screen_recording` assets) and
   * MUST be played once, trimmed to this exact range -- never
   * `-stream_loop`'d like ordinary stock footage (see buildFfmpegArgs).
   * `{start, end}` are seconds into the SOURCE clip. buildFfmpegArgs throws
   * rather than loop when the declared range is shorter than this scene
   * actually needs (its durationSeconds plus any adjacent transition
   * padding) -- reported as insufficient footage, never silently stretched.
   */
  clipTimeRangeSeconds?: { start: number; end: number };
  /**
   * Only meaningful with `clipPath`. Crops the SOURCE clip to this
   * rectangle (source pixel coordinates) before the normal scale/crop-to-
   * canvas step -- e.g. excluding a captured app's sidebar/chrome, or
   * framing one specific UI region. Absent means the existing
   * scale-to-fill/center-crop behavior, unchanged.
   */
  sourceCrop?: { x: number; y: number; w: number; h: number };
  /**
   * Only meaningful with `sourceCrop`. Extra regions (source pixel
   * coordinates, same space as `sourceCrop`) to black out -- e.g. an
   * account email visible in a corner of the raw recording that
   * `sourceCrop` alone doesn't exclude. A mask entirely outside
   * `sourceCrop` is simply not drawn (nothing left to hide once cropped
   * out already).
   */
  privacyMasks?: { x: number; y: number; w: number; h: number }[];
  /** Card presentation (verified-motion videos): a designed full-canvas background, plus a rounded, shadowed evidence card on evidence scenes. */
  card?: CardPresentation;
}

export interface CardPresentation {
  /** 1080x1920 still used as the scene's full-canvas background. */
  backgroundPath: string;
  /** Optional entrance motion: numbered PNG frames (printf pattern, basename) played at the render frame rate before the background holds on its last frame. */
  frames?: { pattern: string; count: number };
  /** Evidence scenes only: where the scaled `sourceCrop` card sits, plus its rounded alpha mask and pre-blurred shadow. */
  evidence?: { x: number; y: number; width: number; height: number; maskPath: string; shadowPath: string; /** True: the card holds its final size from the first frame (no gentle grow), so vector rings drawn over it stay exactly on the figure. */ still?: boolean };
}

export interface RenderPlan {
  scenes: Scene[];
  totalDurationSeconds: number;
  voiceoverPath: string;
  assPath: string;
  outputPath: string;
  silencePadSeconds: number;
  /** Caps the crossfade between scenes (default 0.4s). Payoff plans use a snappier 0.15s so a ~2s scene reads as a cut. */
  maxTransitionSeconds?: number;
  /** Background music track (absolute path) and where in it to start; omitted = the renderer's default bed from the start. */
  musicFile?: string;
  musicStartSeconds?: number;
}

export interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
}

export interface FfprobeResult {
  streams: FfprobeStream[];
  format: {
    duration?: string;
    size?: string;
  };
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
}

export interface RenderReport {
  draftId: string;
  campaignTitle: string;
  hook: string;
  tiktokCaption: string;
  hashtags: string[];
  durationSeconds: number;
  resolution: string;
  videoCodec: string;
  audioCodec: string;
  validation: ValidationResult;
  outputPath: string;
  renderedAt: string;
}
