#!/usr/bin/env node
/**
 * Renders the cover image (src/shortform/thumbnails.ts) for the offered videos, for review or to upload by hand.
 *
 *   npx tsx scripts/video-factory/renderThumbnails.ts            every offered video, in day order
 *   npx tsx scripts/video-factory/renderThumbnails.ts strategy   only plan ids containing "strategy"
 *
 * Writes out/thumbnails/<planId>.jpg (1080x1920). Local only: no network, no upload.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MOTION_SCENE_PLANS, OFFERED_DAILY_CONCEPT_IDS } from "../../src/shortform/motionPlans.js";
import { thumbnailSpecFor } from "../../src/shortform/thumbnails.js";
import { createMockRenderer } from "./mockCard.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "..", "..", "out", "thumbnails");

async function main() {
  const filter = process.argv[2];
  const ids = OFFERED_DAILY_CONCEPT_IDS.filter((id) => !filter || id.includes(filter));
  if (ids.length === 0) throw new Error(`No offered video matches "${filter}".`);
  mkdirSync(OUT, { recursive: true });
  const renderer = await createMockRenderer(join(OUT, "_work"));
  try {
    for (const id of ids) {
      const plan = MOTION_SCENE_PLANS.find((p) => p.planId === id)!;
      const path = await renderer.renderThumbnail(thumbnailSpecFor(plan), join(OUT, `${id}.jpg`));
      console.log(path);
    }
  } finally {
    await renderer.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
