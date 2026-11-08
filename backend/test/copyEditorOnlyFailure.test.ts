import { describe, expect, it } from "vitest";
import { isCopyEditorOnlyFailure } from "../src/content/campaignPipeline";

const v = (agent: string, pass: boolean) => ({ agent, pass });

describe("isCopyEditorOnlyFailure", () => {
  it("is true only when the copy editor is the single failing reviewer", () => {
    expect(isCopyEditorOnlyFailure({ passed: false, verdicts: [v("trader", true), v("copy_editor", false), v("fact_checker", true)] })).toBe(true);
  });

  it("is false when a fact, claims, brand or integrity reviewer also fails", () => {
    expect(isCopyEditorOnlyFailure({ passed: false, verdicts: [v("copy_editor", false), v("fact_checker", false)] })).toBe(false);
    expect(isCopyEditorOnlyFailure({ passed: false, verdicts: [v("copy_editor", false), v("integrity_reviewer", false)] })).toBe(false);
    expect(isCopyEditorOnlyFailure({ passed: false, verdicts: [v("brand_guardian", false)] })).toBe(false);
  });

  it("is false when everything passes (nothing to flag) or nothing is recorded", () => {
    expect(isCopyEditorOnlyFailure({ passed: true, verdicts: [v("copy_editor", true)] })).toBe(false);
    expect(isCopyEditorOnlyFailure({ passed: false, verdicts: [] })).toBe(false);
  });
});
