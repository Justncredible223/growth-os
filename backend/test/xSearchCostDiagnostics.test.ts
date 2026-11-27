import { afterEach, describe, expect, it, vi } from "vitest";
import { recordXSearchCostEventChecked, safeWriteDiagnostic } from "../src/cost/costTracking";
import { briefSample } from "../src/prospecting/prospectingSearch";

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("briefSample", () => {
  it("leaves ordinary text alone apart from collapsing whitespace and cutting at the limit", () => {
    expect(briefSample("NQ   open\n\nrange")).toBe("NQ open range");
    expect(briefSample("a".repeat(200))).toBe("a".repeat(110));
    expect(briefSample("")).toBe("");
  });

  it("never splits an emoji that straddles the limit", () => {
    const text = `${"a".repeat(109)}\u{1F600}tail`;
    expect(LONE.test(text.slice(0, 110))).toBe(true);
    expect(briefSample(text)).toBe(`${"a".repeat(109)}\u{1F600}`);
  });

  it("counts supplementary-plane styled letters as whole characters", () => {
    const bold = "\u{1D5E0}".repeat(200);
    const out = briefSample(`x${bold}`);
    expect(Array.from(out)).toHaveLength(110);
    expect(LONE.test(out)).toBe(false);
  });

  it("replaces unpaired surrogates that arrive in the post itself", () => {
    const out = briefSample("a\uD800b\uDC00c\uD83D");
    expect(out).toBe("a�b�c�");
    expect(LONE.test(out)).toBe(false);
  });
});

describe("safeWriteDiagnostic", () => {
  it("gives the code and a fixed reason", () => {
    expect(safeWriteDiagnostic({ code: "22P02", message: "invalid input syntax for type json" })).toBe("code=22P02 reason=invalid JSON or text encoding");
    expect(safeWriteDiagnostic(new TypeError("fetch failed"))).toBe("code=none reason=network request failed");
    expect(safeWriteDiagnostic(undefined)).toBe("code=none reason=unclassified");
  });

  it("passes nothing from the message, details or an odd code through", () => {
    const out = safeWriteDiagnostic({
      code: "SECRET post text",
      message: 'invalid input value "SECRET post text" Bearer sk-SECRET',
      details: "SECRET",
      hint: "SECRET",
    });
    expect(out).toBe("code=none reason=unclassified");
  });
});

describe("recordXSearchCostEventChecked", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the diagnostic and reports not recorded when the insert returns an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = { from: () => ({ insert: async () => ({ error: { code: "22P02", message: "invalid input syntax for type json: SECRET" } }) }) } as any;
    const result = await recordXSearchCostEventChecked(client, 4, { query: "SECRET" });
    expect(result.recorded).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(["[cost] x_search_read not saved: code=22P02 reason=invalid JSON or text encoding"]);
  });

  it("does the same when the insert throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = { from: () => ({ insert: async () => { throw new Error("network down SECRET"); } }) } as any;
    expect((await recordXSearchCostEventChecked(client, 1)).recorded).toBe(false);
    expect(warn.mock.calls[0]).toEqual(["[cost] x_search_read not saved: code=none reason=network request failed"]);
  });

  it("stays quiet when the row is saved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = { from: () => ({ insert: async () => ({ error: null }) }) } as any;
    expect((await recordXSearchCostEventChecked(client, 1)).recorded).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
