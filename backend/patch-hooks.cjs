const fs = require("fs");
function edit(f, pairs) { let s = fs.readFileSync(f, "utf8"); const crlf = s.includes("\r\n"); for (let [a, b] of pairs) { if (crlf) { a = a.replace(/\n/g, "\r\n"); b = b.replace(/\n/g, "\r\n"); } if (!s.includes(a)) { console.log("MISSING", f, a.slice(0, 70)); process.exit(1); } s = s.replace(a, () => b); } fs.writeFileSync(f, s); }
edit("src/shortform/strategyVideos.ts", [
  ['hook: { headline: "Closed outside the range. Then?", say:', 'hook: { headline: "1 close outside the range. Then?", say:'],
  ['close: { headline: "Would your plan take it?", say: "Would your plan have taken it?" },', 'close: { headline: "Take a close outside the range?", say: "Would your plan have taken it?" },'],
  ['hook: { headline: "Broke the high. Then it didn\'t.", say:', 'hook: { headline: "1 break. Then back inside?", say:'],
  ['close: { headline: "Where was your stop?", say: "Where was your stop?" },', 'close: { headline: "Back inside: where\'s your stop?", say: "Where was your stop?" },'],
  ['hook: { headline: "Pulled back to VWAP. Held?", say:', 'hook: { headline: "1 pullback to VWAP. Then?", say:'],
  ['close: { headline: "Did you wait for the hold?", say: "Did you wait for the hold?" },', 'close: { headline: "Pullback to VWAP: did it hold?", say: "Did you wait for the hold?" },'],
]);
edit("src/shortform/storyScore.ts", [
  ['  if (plan.series === "Explained") {', '  // A chart moment (strategyVideos.ts, team decision 2026-11-08) is a 12-15 second cut, so it is judged as a clip, not as a 30-45 second explainer.\n  if (plan.series === "Explained" && !plan.planId.startsWith("chartmoment-")) {'],
]);
edit("test/strategyVideos.test.ts", [
  ['      expect(p.scenes[0]!.headline.split(/\s+/).length).toBeLessThanOrEqual(7);\n    }', '      expect(p.scenes[0]!.headline.split(/\s+/).length).toBeLessThanOrEqual(7);\n    }\n    // The story bar (storyScore.ts) must pass them as clips, or they could never render.\n    const { renderBar } = await import("../src/shortform/storyScore");\n    for (const p of CHART_MOMENT_PILOTS) expect(renderBar(p).ok, `${p.planId}: ${JSON.stringify(renderBar(p))}`).toBe(true);'],
]);
