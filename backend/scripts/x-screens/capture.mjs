// Captures the real Fillbook screens used by the "screen" style of the X post picture (ChatGPT 2026-11-15: alternate real
// screens with the drawn card and measure). Source: the public /sample page, which is the real app UI filled with made-up
// trades and never touches an account, run from a local checkout of the Fillbook site (the live site blocks headless browsers).
//
//   cd <fillbook>/frontend && npx vite --port 5199
//   cd backend && node scripts/x-screens/capture.mjs http://localhost:5199
//
// Writes android/app/src/main/assets/xscreens/<name>.jpg. Re-run whenever the Fillbook dashboard's look changes, then rebuild the app.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://localhost:5199";
const out = join(dirname(fileURLToPath(import.meta.url)), "../../../android/app/src/main/assets/xscreens");
mkdirSync(out, { recursive: true });

// name -> text inside the card, the card's selector (closest ancestor), and the most height to keep (CSS px) so tall cards
// are cropped to their top instead of shrunk to nothing.
// ChatGPT 2026-11-15: crop to ONE idea per picture so the text stays readable at X feed size. Risk topics get a single tile each;
// the cards are captured on a narrow (phone) page so their text is large relative to the card.
//   name -> text inside it, class words of the box to keep (closest ancestor with all of them), page width, most height to keep (CSS px).
const SHOTS = [
  { name: "buffer", text: "Drawdown buffer left", box: ["relative", "p-4"], vw: 430, maxH: 200 },
  { name: "lossroom", text: "Loss room today", box: ["relative", "p-4"], vw: 430, maxH: 200 },
  { name: "maxsize", text: "Max size, next trade", box: ["relative", "p-4"], vw: 430, maxH: 200 },
  { name: "edge", text: "Edge Map", box: ["card"], vw: 340, maxH: 150 },
  { name: "leaks", text: "Your Leaks", box: ["card"], vw: 340, maxH: 128 },
  { name: "health", text: "Account health", box: ["card"], vw: 340, maxH: 150 },
];

const browser = await chromium.launch({ channel: "chrome" });
for (const s of SHOTS) {
  const page = await browser.newPage({ viewport: { width: s.vw, height: 1000 }, deviceScaleFactor: 3, colorScheme: "dark" });
  await page.goto(`${base}/sample`, { waitUntil: "commit", timeout: 60_000 });
  await page.getByText(s.text).first().waitFor({ timeout: 240_000 });
  await page.waitForTimeout(1500); // let the charts finish animating
  // The page keeps a floating "You are viewing sample data" bar on top; hide floating bars so they never cover a card (the picture
  // carries its own SAMPLE DATA label instead).
  await page.addStyleTag({ content: "[class*=sticky],[class*=fixed]{display:none!important}" });
  const cond = s.box.map((w) => `contains(concat(' ', normalize-space(@class), ' '), ' ${w} ')`).join(" and ");
  const card = page.getByText(s.text).first().locator(`xpath=ancestor-or-self::*[${cond}][1]`);
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  if (!box) throw new Error(`no box for ${s.name}`);
  // Tiles sit inside a grid with divider lines, so they are cut exactly at their edge; whole cards keep a little page around them.
  const pad = s.box.includes("card") ? 6 : 0;
  await page.screenshot({
    path: join(out, `${s.name}.jpg`),
    type: "jpeg",
    quality: 92,
    clip: { x: Math.max(0, box.x - pad), y: box.y - pad, width: box.width + pad * 2, height: Math.min(box.height, s.maxH) + pad * 2 },
  });
  console.log(`${s.name}: ${Math.round(box.width)}x${Math.round(Math.min(box.height, s.maxH))}`);
  await page.close();
}
await browser.close();
