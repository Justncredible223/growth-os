import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DETAIL_FOOTER, HOOK_MOTION, MOCK_BOXES, MOCK_CANVAS, MOCK_FONT, MOCK_SAFE, WINDOW_BAR, cursorPath, heroFontSize, hookValueFontSize, windowGeometry, type MockBoxName } from "../../src/shortform/mockLayout.js";
import { CLASSIC_MOCK_STYLE, type MockStyle } from "../../src/shortform/mockStyle.js";
import type { ChartSpec, ChartTone, MockRow } from "../../src/shortform/types.js";
import { VideoFactoryError } from "./types.js";

/**
 * The HTML renderer for the "mock" chart kind: the slide is laid out in HTML/CSS with the site's own typefaces and colour
 * tokens (assets/brand, copied from the fillbook repo), then screenshotted by headless Chromium at the final
 * 1080x1920, one still per beat (chart.stage). The still becomes the scene's background in the adapter; there is no
 * ASS text on a mock scene, so every glyph on it is in the brand type.
 *
 * Geometry is fixed (mockLayout.ts) and validated before anything renders. After rendering, the page is measured: every
 * box must sit inside the area TikTok and YouTube Shorts leave clear, and no text may overflow its box. Either failure
 * throws, so a slide that would be covered by a platform button or a caption never reaches a video.
 */
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "assets", "brand");

export interface MockFrame {
  chart: ChartSpec;
  headline: string;
  captionText: string;
  cta: string | null;
  /** The video's look (palette, alignment, window chrome); the original look when omitted. Every beat of one video passes the same style. */
  style?: MockStyle;
  /** hookFirst beat 1 only: how long the beat is on screen (s); the slow push-in is spread over it. */
  holdSeconds?: number;
}

const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const url = (name: string): string => pathToFileURL(join(ASSETS, name)).href;
const toneClass = (t: ChartTone): string => (t === "bad" ? "bad" : "good");

const CSS = `
@font-face{font-family:SG;src:url(${url("space-grotesk-latin-wght-normal.woff2")}) format('woff2');font-weight:300 700}
@font-face{font-family:MR;src:url(${url("manrope-latin-wght-normal.woff2")}) format('woff2');font-weight:200 800}
@font-face{font-family:JB;src:url(${url("jetbrains-mono-latin-wght-normal.woff2")}) format('woff2');font-weight:100 800}
:root{--bg0:#07090d;--bg1:#0d1117;--bg2:#111720;--line:#1f2b35;--ink:#e7edf3;--mute:#a9b7c4;--dim:#7f8e9b;--cyan:#22b8dc;--good:#34d399;--bad:#f87171;--glow:#0c2a33;--glowat:88% 6%;--ctabg:#0b2b34;--ctaborder:#14566a;--dot:#252f3b;--meter:#1b2531;--shadow:rgba(0,0,0,.55)}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${MOCK_CANVAS.width}px;height:${MOCK_CANVAS.height}px;overflow:hidden}
body{position:relative;color:var(--ink);font-family:MR,sans-serif;background:radial-gradient(1100px 800px at var(--glowat),var(--glow) 0%,var(--bg0) 62%)}
[data-box]{position:absolute}
${Object.entries(MOCK_BOXES).map(([n, b]) => `[data-box=${n}]{left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px}`).join("\n")}
.logo{height:58px}
.label{font:700 ${MOCK_FONT.heroLabel}px/44px SG;letter-spacing:-.01em;color:var(--ink);white-space:nowrap;overflow:hidden}.label em{font-style:normal;color:var(--cyan)}
.pill{display:flex;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden}.pill span{display:inline-flex;align-items:center;gap:12px;height:42px;padding:0 26px;border:2px solid var(--ctaborder);background:var(--ctabg);border-radius:999px;font:700 22px/1 MR;letter-spacing:.16em;color:var(--cyan)}
.hero{font-family:SG;font-weight:700;letter-spacing:-.04em;line-height:${MOCK_FONT.hero}px;white-space:nowrap;overflow:hidden}
.big{font:700 ${MOCK_FONT.big}px/${MOCK_FONT.bigLine}px SG;letter-spacing:-.02em;overflow:hidden}.big em{font-style:normal;color:var(--cyan)}
.good{color:var(--good)}.bad{color:var(--bad)}
.win{border:2px solid var(--line);border-radius:28px;background:var(--bg1);overflow:hidden;box-shadow:0 30px 80px var(--shadow)}
.bar{display:flex;align-items:center;gap:12px;height:${WINDOW_BAR}px;padding:0 28px;border-bottom:2px solid var(--line);font:600 26px MR;color:var(--dim);white-space:nowrap}
.dot{width:16px;height:16px;border-radius:50%;background:var(--dot);flex:none}
.bar .t{margin-left:14px}.bar .g{margin-left:auto;font-size:22px;letter-spacing:.12em}
.row{position:relative;padding:0 30px;border-top:2px solid var(--line);white-space:nowrap;overflow:hidden}
.row .in{display:flex;align-items:center;gap:20px;height:100%}
.bar + .row{border-top:0}
.row .lt{min-width:0;flex:1}
.row .l{font:600 ${MOCK_FONT.rowLabel}px/52px MR;color:var(--ink)}
.row .s{font:500 ${MOCK_FONT.rowSub}px/32px MR;color:var(--dim)}
.row .v{font:700 ${MOCK_FONT.rowValue}px JB;margin-left:auto}
.row .ring{position:absolute;inset:5px;border:5px solid var(--cyan);border-radius:18px;background:rgba(34,184,220,.08);opacity:0;pointer-events:none}
.row .ring.bad{border-color:var(--bad);background:rgba(248,113,113,.09)}
.meter{height:14px;border-radius:9px;background:var(--meter);margin-top:8px;position:relative;width:100%}
.meter i{position:absolute;left:0;top:0;bottom:0;width:100%;border-radius:9px;background:linear-gradient(90deg,#0891b2,#22b8dc)}
.meter b{position:absolute;top:-6px;bottom:-6px;width:3px;background:var(--ink)}
.det .row .l{font-size:34px;line-height:40px}.det .row .v{font-size:38px}
.foot{height:${DETAIL_FOOTER}px;line-height:${DETAIL_FOOTER}px;padding:0 28px;border-top:2px solid var(--line);font:600 24px MR;color:var(--mute);letter-spacing:.04em;white-space:nowrap}
.caption{font:700 ${MOCK_FONT.caption}px/${MOCK_BOXES.caption.h}px MR;color:var(--ink);white-space:nowrap;overflow:hidden}
.cta{display:flex;align-items:center;justify-content:center;text-align:center;border:2px solid var(--ctaborder);background:var(--ctabg);border-radius:28px;padding:0 44px;font:700 50px/66px SG;color:var(--ink)}
.hookwrap{position:absolute;inset:0;transform-origin:490px 700px}
.hooktxt{font:800 150px/1.04 SG;letter-spacing:-.025em;color:var(--ink);overflow:hidden;display:flex;flex-direction:column;justify-content:center}.hooktxt>div{display:block}.hooktxt em{font-style:normal;color:var(--good)}.hooktxt em.bad{color:var(--bad)}
.figs{display:flex;flex-direction:column;gap:20px;justify-content:center}
.tile{flex:none;border:2px solid var(--line);border-radius:28px;background:var(--bg1);box-shadow:0 24px 70px var(--shadow);padding:12px 30px 0;overflow:hidden}
.tile .tl{display:flex;align-items:center;height:44px;font:700 36px/44px SG;color:var(--ink);white-space:nowrap}.tile .tl span{margin-left:auto;font:600 20px MR;letter-spacing:.14em;color:var(--dim)}
.tile .tv{font-family:SG;font-weight:700;letter-spacing:-.04em;white-space:nowrap}
.cursor{position:absolute;width:64px;height:64px;filter:drop-shadow(0 6px 10px rgba(0,0,0,.7));pointer-events:none}
`;

/**
 * The page's animation driver. seek(t) draws every element at t ms into the beat, so a frame is a pure function of its time
 * (no running animation to race the screenshot); seek(Infinity) is the finished slide.
 *   settle  visible from the first frame, drifts and shrinks into place (the payoff figure is on screen at t=0)
 *   slideup rises and fades in     rowin  slides in from the left     fade  fades in     pop  scales in
 *   dimrow  fades to 35%           ring   fades in with a small scale (the "click")
 *   data-cur="x0,y0,x1,y1"  the cursor travels from (x0,y0) to (x1,y1) starting at data-d
 */
const PAGE_SCRIPT = `
const ease = (p) => 1 - Math.pow(1 - p, 3);
const FAST = document.body.dataset.fast === "1";
const DUR = FAST ? 200 : 460;
const lerp = (a, b, p) => a + (b - a) * p;
// Fits every [data-autofit] text to its box: the largest size (px) whose wrapped text neither overflows across nor down.
window.fitText = () => {
  for (const el of document.querySelectorAll("[data-autofit]")) {
    for (let size = Number(el.dataset.autofit); size > 48; size -= 2) {
      el.style.fontSize = size + "px";
      if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) break;
    }
  }
};
window.seek = (ms) => {
  for (const el of document.querySelectorAll("[data-hook]")) {
    // hookFirst: opacity is never touched, so every one of these is fully visible at t=0. They only move.
    const kind = el.dataset.hook, hold = Math.max(Number(el.dataset.hold || 1000), 1);
    const t = Math.min(ms, 1e9);
    if (kind === "push") el.style.transform = "scale(" + lerp(1, ${HOOK_MOTION.push}, 1 - Math.pow(1 - Math.min(1, t / hold), 2)) + ")";
    else if (kind === "pulse") { const p = Math.min(1, Math.max(0, (t - ${HOOK_MOTION.pulseAtMs}) / ${HOOK_MOTION.pulseMs})); el.style.transform = "scale(" + (1 + (${HOOK_MOTION.pulse} - 1) * Math.sin(Math.PI * p)) + ")"; el.style.transformOrigin = "left center"; }
    else if (kind === "punch") { const p = Math.min(1, Math.max(0, (t - Number(el.dataset.d)) / ${HOOK_MOTION.punchMs})); el.style.transform = "scale(" + lerp(${HOOK_MOTION.punch}, 1, ease(p)) + ")"; el.style.transformOrigin = "center center"; }
  }
  for (const el of document.querySelectorAll("[data-a]")) {
    const kind = el.dataset.a, p = Math.min(1, Math.max(0, (ms - Number(el.dataset.d)) / DUR)), e = ease(p);
    if (kind === "settle") { el.style.opacity = "1"; el.style.transform = FAST ? "none" : "translateY(" + (1 - e) * 26 + "px) scale(" + (1 + (1 - e) * 0.05) + ")"; el.style.transformOrigin = document.body.dataset.origin || "left center"; }
    else if (kind === "dimrow") el.style.opacity = String(1 - 0.65 * e);
    else if (kind === "ring") { el.style.opacity = String(e); el.style.transform = "scale(" + (1.03 - 0.03 * e) + ")"; }
    else if (kind === "rowin") { el.style.opacity = String(e); el.style.transform = "translateX(" + (1 - e) * -50 + "px)"; }
    else el.style.opacity = String(e);
    if (kind === "slideup") el.style.transform = "translateY(" + (1 - e) * (FAST ? 24 : 70) + "px)";
    if (kind === "pop") el.style.transform = "scale(" + (0.9 + 0.1 * e) + ")";
  }
  for (const el of document.querySelectorAll("[data-cur]")) {
    const [x0, y0, x1, y1] = el.dataset.cur.split(",").map(Number);
    const p = Math.min(1, Math.max(0, (ms - Number(el.dataset.d)) / 520)), e = ease(p);
    el.style.left = x0 + (x1 - x0) * e + "px";
    el.style.top = y0 + (y1 - y0) * e + "px";
    el.style.opacity = ms < Number(el.dataset.d) - 120 ? "0" : "1";
  }
};
`;

/** CSS that turns the base slide into this video's look: palette variables, window chrome, and text alignment inside the same boxes. The logo never moves: the "Demo data" badge the video adds sits just to its right at a fixed spot. */
function styleCss(style: MockStyle): string {
  const p = style.palette;
  const vars = `:root{--bg0:${p.bg0};--bg1:${p.bg1};--bg2:${p.bg2};--line:${p.line};--ink:${p.ink};--mute:${p.mute};--dim:${p.dim};--cyan:${p.accent};--good:${p.good};--bad:${p.bad};--glow:${p.glow};--glowat:${p.glowAt};--ctabg:${p.ctaBg};--ctaborder:${p.ctaBorder};--dot:${p.dot};--meter:${p.meter};--shadow:${p.shadow}}`;
  const chrome =
    style.chrome === "sharp"
      ? ".win{border-radius:10px}.row .ring{border-radius:6px}.cta{border-radius:10px}.dot{display:none}.bar .t{margin-left:0}"
      : style.chrome === "soft"
        ? ".win{border-radius:46px;border-color:transparent;box-shadow:0 30px 90px var(--shadow),0 0 0 2px var(--line),0 0 70px color-mix(in srgb,var(--cyan) 14%,transparent)}.row .ring{border-radius:30px}.cta{border-radius:46px}"
        : "";
  const align =
    style.align === "center"
      ? `.label,.hero,.big,.caption{text-align:center}`
      : "";
  return vars + chrome + align;
}

const CURSOR_SVG = `<svg viewBox="0 0 24 24"><path d="M3 2l7 19 3-8 8-3z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

/** The slide's HTML for one beat. Pure: the same frame always gives the same markup. */
export function buildMockHtml(frame: MockFrame): string {
  const { chart } = frame;
  const style = frame.style ?? CLASSIC_MOCK_STYLE;
  const m = chart.mock;
  if (!m) throw new VideoFactoryError("mockCard: a mock chart scene has no mock spec (validateScenePlan should have refused it).");
  const stage = chart.stage;
  const closing = chart.dim === true;
  const box = (name: MockBoxName): string => `data-box="${name}"`;
  // Entrance motion: each element that appears or changes on this beat carries data-a (kind) and data-d (delay, ms); seek() in the page draws it.
  const hookFirst = chart.hookFirst === true && chart.mock !== undefined;
  // hookFirst: entrances are short (the page runs them in 200 ms rather than 460) and start sooner, so the figures are on screen at once.
  const a = (kind: string, delay: number): string => ` data-a="${kind}" data-d="${hookFirst ? Math.round(delay * 0.25) : delay}"`;
  // The label reads like the site's headlines: sentence case in the ink colour, the last word in the accent.
  const twoTone = (text: string): string => {
    const words = text.split(" ");
    const last = words.pop()!;
    return `${words.length > 0 ? `${esc(words.join(" "))} ` : ""}<em>${esc(last)}</em>`;
  };
  const heroHtml = (h: { label: string; value: string; tone: ChartTone }, labelBox: MockBoxName, heroBox: MockBoxName, delay: number): string =>
    `<div ${box(labelBox)} class="label" data-fit${a("settle", delay)}>${twoTone(h.label)}</div>` +
    `<div ${box(heroBox)} class="hero ${toneClass(h.tone)}" data-fit style="font-size:${heroFontSize(h.value)}px"${a("settle", delay)}>${esc(h.value)}</div>`;
  const windowHtml = (w: { title: string; rows: MockRow[] }, kind: "window" | "windowLow", opts: { focus?: number; enter: "slideup" | "none"; rowDelay: number }): string => {
    const g = windowGeometry(w.rows.length, kind);
    const rows = w.rows
      .map((r, i) => {
        const meter = r.meter ? `<div class="meter"><i></i><b style="left:${Math.round(r.meter.markAt * 1000) / 10}%"></b></div>` : "";
        const dimmed = opts.focus !== undefined && i !== opts.focus;
        const enter = opts.enter === "slideup" ? a("rowin", opts.rowDelay + i * 110) : "";
        const dim = dimmed ? a("dimrow", 700) : "";
        const ring = opts.focus === i ? `<i class="ring ${r.tone === "bad" ? "bad" : ""}"${a("ring", 700)}></i>` : "";
        return `<div class="row" data-fit style="height:${g.rowH}px"${enter}>${ring}<div class="in"${dim}><div class="lt"><div class="l">${esc(r.label)}</div>${r.sub ? `<div class="s">${esc(r.sub)}</div>` : ""}${meter}</div><b class="v ${toneClass(r.tone)}">${esc(r.value)}</b></div></div>`;
      })
      .join("");
    return `<div ${box(kind)} class="win" style="top:${g.top}px;height:${g.height}px"${opts.enter === "slideup" ? a("slideup", 120) : ""}><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="t">${esc(w.title)}</span><span class="g">${esc(m.tag.toUpperCase())}</span></div>${rows}</div>`;
  };
  const bigText = (text: string): string => {
    // The last word is drawn in the accent colour, or the last three of a long line ("side by side.").
    const words = text.split(" ");
    const accent = words.slice(words.length >= 5 ? -3 : -1);
    const plain = words.slice(0, words.length - accent.length);
    return `<div ${box("big")} class="big" data-fit${a("settle", 0)}>${esc(plain.join(" "))}${plain.length > 0 ? " " : ""}<em>${esc(accent.join(" "))}</em></div>`;
  };
  let content = "";
  let showCaption = true;
  let hookBeat = false;
  let punch = false;
  if (hookFirst && stage === 1) {
    // The hook beat: nothing fades or slides in. The headline and the opening figures are drawn large and are fully visible at t=0 (so the first frame is a valid cover); they only push in slowly and the first figure pulses once.
    hookBeat = true;
    const words = chart.lines;
    const body = words.map((l, i) => (i === words.length - 1 ? `<em class="${chart.accent === "bad" ? "bad" : ""}">${esc(l)}</em>` : esc(l))).join(" ");
    const figs = m.opening;
    const gap = 20;
    const tileH = Math.min(260, Math.floor((MOCK_BOXES.hookFigs.h - gap * (figs.length - 1)) / figs.length));
    const tiles = figs
      .map(
        (fg, i) =>
          `<div class="tile" style="height:${tileH}px"><div class="tl">${esc(fg.label)}<span>${esc(m.tag.toUpperCase())}</span></div><div class="tv ${toneClass(fg.tone)}" style="font-size:${hookValueFontSize(fg.value, tileH)}px;line-height:${tileH - 70}px"${i === 0 ? ` data-hook="pulse"` : ""}>${esc(fg.value)}</div></div>`,
      )
      .join("");
    const hold = Math.round((frame.holdSeconds ?? 2.6) * 1000);
    content += `<div class="hookwrap" data-hook="push" data-hold="${hold}"><div ${box("hookText")} class="hooktxt" data-autofit="150" data-fit><div>${body}</div></div><div ${box("hookFigs")} class="figs">${tiles}</div></div>`;
  } else if (stage === 1 || (stage >= 2 && stage <= 3 && !closing)) {
    if (stage === 1) {
      const [h1, h2] = m.opening;
      content += heroHtml(h1!, "label", "hero", 0);
      if (h2) content += heroHtml(h2, "label2", "hero2", 120);
      content += windowHtml(m.windows[0]!, h2 ? "windowLow" : "window", { enter: "slideup", rowDelay: 360 });
    } else {
      const f = m.focus[stage - 2]!;
      punch = hookFirst && stage === 3;
      const prev = stage === 3 ? m.focus[0] : undefined;
      const sameWindow = prev !== undefined && prev.window === f.window;
      content += heroHtml(f.hero, "label", "hero", 0);
      // The pattern interrupt: on the "but" beat the contradicting figure punches in (10% bigger, settling over 0.3 s).
      if (punch) content = content.replace(/(class="hero [a-z]+" data-fit style="[^"]*")/, `$1 data-hook="punch" data-d="${HOOK_MOTION.punchAtMs}"`);
      if (m.via) content += `<div ${box("pill")} class="pill" data-fit${a("pop", 200)}><span>${esc(m.via.toUpperCase())}<svg width="16" height="20" viewBox="0 0 16 20"><path d="M8 2v14M2 10l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span></div>`;
      content += windowHtml(m.windows[f.window]!, "window", { focus: f.row, enter: sameWindow ? "none" : "slideup", rowDelay: 300 });
      // The cursor travels to the ringed row; on beat 3 it starts where beat 2 left it when the window is the same one.
      const n = m.windows[f.window]!.rows.length;
      const path = cursorPath(n, f.row, "window");
      const from = sameWindow ? cursorPath(n, prev!.row, "window").to : path.from;
      content += `<div class="cursor" data-cur="${from.x},${from.y},${path.to.x},${path.to.y}" data-d="${sameWindow ? 100 : 200}" style="left:${from.x}px;top:${from.y}px">${CURSOR_SVG}</div>`;
    }
  } else if (stage === 4 && !closing && m.details) {
    showCaption = false;
    content += bigText(frame.captionText);
    const d = m.details;
    const g = windowGeometry(d.rows.length, "window", true);
    const rows = d.rows
      .map((r, i) => `<div class="row" data-fit style="height:${g.rowH}px"${a("rowin", 300 + i * 110)}><div class="in"><div class="lt"><div class="l">${esc(r.label)}</div></div><b class="v ${toneClass(r.tone)}">${esc(r.value)}</b></div></div>`)
      .join("");
    content += `<div ${box("window")} class="win det" style="top:${g.top}px;height:${g.height}px"${a("slideup", 120)}><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="t">${esc(d.title)}</span><span class="g">${esc(m.tag.toUpperCase())}</span></div>${rows}<div class="foot"${a("fade", 760)}>${esc(d.footer)}</div></div>`;
  } else {
    showCaption = false;
    content += bigText(frame.captionText);
    if (frame.cta) content += `<div ${box("cta")} class="cta"${a("pop", 200)}>${esc(frame.cta)}</div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}${styleCss(style)}</style></head><body data-origin="${style.align === "center" ? "center center" : "left center"}"${hookFirst && !hookBeat ? ` data-fast="1"` : ""}>
<img ${box("logo")} class="logo" src="${url(style.palette.light ? "fillbook-horizontal-dark.svg" : "fillbook-horizontal-white.svg")}">
${content}
${showCaption ? `<div ${box("caption")} class="caption" data-fit${hookBeat ? "" : a("fade", 300)}>${esc(frame.captionText)}</div>` : ""}
<script>${PAGE_SCRIPT}</script>
</body></html>`;
}

/** Where Chromium lives: an explicit env override, Playwright's own install, or the pre-installed browser some environments ship. */
function chromiumPath(): string | undefined {
  const fromEnv = process.env.MOCK_CHROMIUM_PATH ?? process.env.CHROMIUM_EXECUTABLE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const preinstalled = "/opt/pw-browsers/chromium";
  return existsSync(preinstalled) ? preinstalled : undefined;
}

/** True when a browser for the mock slides can be found (an override, the pre-installed one, or Playwright's own install). Lets tests that really render skip where there is none. */
export async function chromiumAvailable(): Promise<boolean> {
  if (chromiumPath()) return true;
  try {
    const { chromium } = await import("playwright-core");
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

interface Measured {
  box: string;
  x: number;
  y: number;
  w: number;
  h: number;
  overflowX: number;
  overflowY: number;
  fit: boolean;
}

/** Problems found by measuring the rendered page, as plain messages (empty = every box is clear of the platform overlays and no text overflows). */
export function measuredProblems(measured: Measured[]): string[] {
  const out: string[] = [];
  const right = MOCK_SAFE.x + MOCK_SAFE.w;
  const bottom = MOCK_SAFE.y + MOCK_SAFE.h;
  for (const m of measured) {
    if (m.x < MOCK_SAFE.x - 1 || m.y < MOCK_SAFE.y - 1 || m.x + m.w > right + 1 || m.y + m.h > bottom + 1) {
      out.push(`${m.box} renders at x ${Math.round(m.x)}-${Math.round(m.x + m.w)}, y ${Math.round(m.y)}-${Math.round(m.y + m.h)}, outside the clear area x ${MOCK_SAFE.x}-${right}, y ${MOCK_SAFE.y}-${bottom}.`);
    }
    if (m.fit && (m.overflowX > 1 || m.overflowY > 1)) out.push(`${m.box}'s text overflows its box by ${Math.round(m.overflowX)}px across and ${Math.round(m.overflowY)}px down.`);
  }
  return out;
}

/** The entrance of every beat: how long it takes and the frame rate it is drawn at. */
export const MOCK_ENTRANCE = { seconds: 1.0, fps: 30 } as const;

/**
 * Frames drawn for a beat. The normal entrance is MOCK_ENTRANCE.seconds long. A hookFirst plan's later beats use a short one
 * (HOOK_MOTION.entranceSeconds, long enough for the 0.3 s punch-in); its hook beat is drawn for its whole hold, because the slow push-in and the
 * pulse run for as long as the beat is on screen (the last frame is held after that).
 */
export function beatFrameCount(frame: MockFrame): number {
  if (frame.chart.hookFirst === true && frame.chart.mock !== undefined) {
    const seconds = frame.chart.stage === 1 ? Math.min(Math.max(frame.holdSeconds ?? 2.6, 1), 6) : HOOK_MOTION.entranceSeconds;
    return Math.round(seconds * MOCK_ENTRANCE.fps);
  }
  return Math.round(MOCK_ENTRANCE.seconds * MOCK_ENTRANCE.fps);
}

export interface MockRenderer {
  render(frame: MockFrame, outPath: string): Promise<string>;
  /** The finished slide plus its entrance as numbered frames (`<prefix>-000.png` ...). Returns the finished still and the frame pattern. */
  renderBeat(frame: MockFrame, outDir: string, prefix: string): Promise<{ stillPath: string; pattern: string; count: number }>;
  close(): Promise<void>;
}

/** One headless Chromium for a whole video's mock scenes. `playwright-core` is loaded lazily so a plan with no mock scene never needs a browser. */
export async function createMockRenderer(workDir: string): Promise<MockRenderer> {
  const { chromium } = await import("playwright-core");
  mkdirSync(workDir, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromiumPath() });
  } catch (err) {
    throw new VideoFactoryError(`mockCard: could not start Chromium (${err instanceof Error ? err.message.split("\n")[0] : String(err)}). Install it with "npx playwright install chromium", or set MOCK_CHROMIUM_PATH.`);
  }
  const page = await browser.newPage({ viewport: { width: MOCK_CANVAS.width, height: MOCK_CANVAS.height }, deviceScaleFactor: 1 });
  const load = async (frame: MockFrame, outPath: string): Promise<void> => {
      const htmlPath = outPath.replace(/\.png$/i, ".html");
      writeFileSync(htmlPath, buildMockHtml(frame), "utf-8");
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
      // A face no element on this slide uses (the closing slide has no figure rows) would stay "unloaded"; load all three explicitly.
      await page.evaluate(() => Promise.all(["700 20px SG", "600 20px MR", "700 20px JB"].map((f) => document.fonts.load(f))));
      await page.evaluate(() => document.fonts.ready);
      const fonts = await page.evaluate(() => [...document.fonts].map((f) => `${f.family}:${f.status}`));
      if (!["SG:loaded", "MR:loaded", "JB:loaded"].every((f) => fonts.includes(f))) throw new VideoFactoryError(`mockCard: the brand fonts did not load (${fonts.join(", ")}).`);
      await page.evaluate(() => (window as unknown as { fitText(): void }).fitText());
      const measured: Measured[] = await page.evaluate(() =>
        [...document.querySelectorAll("[data-box]")]
          .filter((el) => getComputedStyle(el).visibility !== "hidden")
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              box: (el as HTMLElement).dataset.box ?? "?",
              x: r.x, y: r.y, w: r.width, h: r.height,
              overflowX: el.scrollWidth - el.clientWidth,
              overflowY: el.scrollHeight - el.clientHeight,
              fit: el.hasAttribute("data-fit"),
            };
          }),
      );
      const problems = measuredProblems(measured);
      if (problems.length > 0) throw new VideoFactoryError(`mockCard: "${outPath}" would be covered by a platform overlay or clipped:\n${problems.join("\n")}`);
      // The finished slide is what is measured and what is held after the entrance.
      await page.evaluate(() => (window as unknown as { seek(ms: number): void }).seek(Infinity));
    };
  return {
    async render(frame, outPath) {
      await load(frame, outPath);
      await page.screenshot({ path: outPath });
      return outPath;
    },
    async renderBeat(frame, outDir, prefix) {
      const stillPath = join(outDir, `${prefix}.png`);
      await load(frame, stillPath);
      await page.screenshot({ path: stillPath });
      const count = beatFrameCount(frame);
      for (let i = 0; i < count; i++) {
        await page.evaluate((ms) => (window as unknown as { seek(ms: number): void }).seek(ms), (i * 1000) / MOCK_ENTRANCE.fps);
        await page.screenshot({ path: join(outDir, `${prefix}-${String(i).padStart(3, "0")}.png`) });
      }
      return { stillPath, pattern: `${prefix}-%03d.png`, count };
    },
    async close() {
      await browser.close();
    },
  };
}
