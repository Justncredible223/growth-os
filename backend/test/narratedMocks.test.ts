import { describe, it, expect } from "vitest";
import { MOTION_SCENE_PLANS, isOfferedPlan, isNarratedMockPlan, MOCK_NARRATION, MOCK_SPEECH_RATE, MOCK_MIN_BEAT_SECONDS } from "../src/shortform/motionPlans";
import { DEFAULT_VOICE } from "../scripts/video-factory/voiceover";

const offered = MOTION_SCENE_PLANS.filter(isOfferedPlan);

/** Digit groups in a sentence: "$1,484", "71%", "2.5x" and "09:30-11:30" count as one figure each. */
const figures = (sentence: string) => (sentence.match(/\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?|-?\$?\d[\d,.]*%?/g) ?? []).length;
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

describe("narrated product mocks", () => {
  it("are the offered concepts, and all of them are narrated", () => {
    expect(offered.length).toBeGreaterThanOrEqual(12);
    for (const p of offered) {
      expect(p.voiceover, p.planId).toBe("narrated");
      expect(isNarratedMockPlan(p), p.planId).toBe(true);
    }
  });

  it("use the project voice at +8%", () => {
    expect(DEFAULT_VOICE).toBe("en-US-AndrewNeural");
    expect(MOCK_SPEECH_RATE).toBe("+8%");
    for (const p of offered) expect(p.voice, p.planId).toContain("en-US-AndrewNeural at +8%");
  });

  it("speak at most two figures per sentence, so a number can be followed by ear", () => {
    for (const p of offered) {
      for (const s of p.scenes) {
        for (const sentence of sentences(s.narration)) expect(figures(sentence), `${p.planId}: "${sentence}"`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("keep every beat short (7 words or fewer, about two seconds spoken)", () => {
    for (const p of offered) {
      for (const s of p.scenes) {
        const words = s.narration.split(/\s+/).length;
        expect(words, `${p.planId}: "${s.narration}"`).toBeLessThanOrEqual(7);
      }
    }
  });

  it("say whole dollars, never cents, which a voice reads out slowly", () => {
    for (const p of offered) for (const s of p.scenes) expect(s.narration, p.planId).not.toMatch(/\$[\d,]+\.\d/);
  });

  it("hold each beat long enough to read after the one-second entrance", () => {
    expect(MOCK_MIN_BEAT_SECONDS).toBeGreaterThanOrEqual(1.5);
    expect(MOCK_MIN_BEAT_SECONDS).toBeLessThanOrEqual(2);
  });

  it("trim the silence the voice leaves around each line, so beats follow the speech", () => {
    expect(MOCK_NARRATION).toEqual({ rate: MOCK_SPEECH_RATE, minSceneSeconds: MOCK_MIN_BEAT_SECONDS, trimSilence: true });
  });
});
