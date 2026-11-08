import { describe, expect, it } from "vitest";
import {
  HQ_HANDOFF_MAX_PER_WINDOW,
  hqHandoffEnabled,
  hqHandoffTokenMatches,
  storeHqDraft,
  validateHqHandoffBody,
} from "../src/hq/hqHandoff.js";

const TOKEN = "t".repeat(40);

function body(overrides: Record<string, unknown> = {}) {
  return {
    hqDraftId: "hq-2026-11-09-social",
    role: "social",
    platform: "x",
    contentType: "x_post",
    text: "Your drawdown buffer is the number that decides how many bad trades you get, so check it before the first entry.",
    compliance: { verdict: "pass", revisionCount: 1 },
    desk: { decision: "ready", reason: "Plain, no claims, one idea." },
    imageBrief: "Simple line chart of a buffer shrinking.",
    ...overrides,
  };
}

describe("hq handoff: switch and token", () => {
  it("is off without a token, with a short token, or when the kill switch is off", () => {
    expect(hqHandoffEnabled({})).toBe(false);
    expect(hqHandoffEnabled({ HQ_HANDOFF_TOKEN: "short" })).toBe(false);
    expect(hqHandoffEnabled({ HQ_HANDOFF_TOKEN: TOKEN, HQ_HANDOFF: "off" })).toBe(false);
    expect(hqHandoffEnabled({ HQ_HANDOFF_TOKEN: TOKEN })).toBe(true);
  });

  it("accepts only the exact bearer token", () => {
    const env = { HQ_HANDOFF_TOKEN: TOKEN };
    expect(hqHandoffTokenMatches(`Bearer ${TOKEN}`, env)).toBe(true);
    expect(hqHandoffTokenMatches(`Bearer ${TOKEN}x`, env)).toBe(false);
    expect(hqHandoffTokenMatches(`Bearer ${"u".repeat(40)}`, env)).toBe(false);
    expect(hqHandoffTokenMatches(TOKEN, env)).toBe(false);
    expect(hqHandoffTokenMatches(undefined, env)).toBe(false);
    expect(hqHandoffTokenMatches(`Bearer ${TOKEN}`, {})).toBe(false);
  });
});

describe("hq handoff: validation", () => {
  it("accepts a good draft and keeps HQ's verdict as information", () => {
    const v = validateHqHandoffBody(body());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.draft.verdict).toBe("pass");
      expect(v.draft.imageBrief).toBe("Simple line chart of a buffer shrinking.");
    }
  });

  it("accepts a null picture brief", () => {
    const v = validateHqHandoffBody(body({ imageBrief: null }));
    expect(v.ok && v.draft.imageBrief).toBe(null);
  });

  it.each([
    ["wrong role", { role: "email" }],
    ["wrong platform", { platform: "linkedin" }],
    ["wrong content type", { contentType: "reply" }],
    ["short text", { text: "too short" }],
    ["bad id", { hqDraftId: "has spaces" }],
    ["desk not ready", { desk: { decision: "hold", reason: "x" } }],
    ["long image brief", { imageBrief: "x".repeat(241) }],
    ["bad revision count", { compliance: { verdict: "pass", revisionCount: -1 } }],
  ])("rejects %s with 400", (_name, override) => {
    const v = validateHqHandoffBody(body(override));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(400);
  });

  it.each([
    ["a link", "Read more at fillbookhq.com about your drawdown buffer and why it matters every day."],
    ["a guarantee", "This habit is guaranteed to make you profitable if you check your buffer every morning."],
    ["an em dash", "Check your buffer first — then decide how many contracts you can afford to risk today."],
  ])("refuses text with %s (422)", (_name, text) => {
    const v = validateHqHandoffBody(body({ text }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(422);
  });

  it("rejects a non-object body", () => {
    expect(validateHqHandoffBody(null).ok).toBe(false);
    expect(validateHqHandoffBody("text").ok).toBe(false);
  });
});

/** A tiny in-memory stand-in for the Supabase client calls storeHqDraft makes. */
function fakeClient(opts: { existing?: { campaign_asset_id: string; body: string } | null; recentCount?: number } = {}) {
  const log: Array<{ table: string; op: string; row?: any }> = [];
  const client: any = {
    from(table: string) {
      const q: any = {
        _op: "select",
        select() {
          return q;
        },
        filter() {
          return q;
        },
        gte() {
          return q;
        },
        limit() {
          return q;
        },
        eq() {
          log.push({ table, op: q._op, row: q._row });
          return Promise.resolve({ error: null });
        },
        insert(row: any) {
          q._op = "insert";
          q._row = row;
          log.push({ table, op: "insert", row });
          return q;
        },
        update(row: any) {
          q._op = "update";
          q._row = row;
          return q;
        },
        single() {
          return Promise.resolve({ data: { id: `${table}-id` }, error: null });
        },
        maybeSingle() {
          return Promise.resolve({ data: table === "content_versions" ? opts.existing ?? null : null, error: null });
        },
        then(resolve: (v: unknown) => void) {
          // head count query
          resolve({ count: opts.recentCount ?? 0, error: null });
        },
      };
      return q;
    },
  };
  return { client, log };
}

describe("hq handoff: storing", () => {
  const draft = (() => {
    const v = validateHqHandoffBody(body());
    if (!v.ok) throw new Error("fixture invalid");
    return v.draft;
  })();

  it("creates a campaign, an x_feed_post asset and a version, then sets ready_for_owner and in_review", async () => {
    const { client, log } = fakeClient();
    const result = await storeHqDraft(client, draft);
    expect(result.status).toBe(201);
    expect(result.body.assetId).toBe("campaign_assets-id");
    const asset = log.find((l) => l.table === "campaign_assets" && l.op === "insert");
    expect(asset?.row.asset_type).toBe("x_feed_post");
    expect(asset?.row.platform).toBe("x");
    const version = log.find((l) => l.table === "content_versions" && l.op === "insert");
    expect(version?.row.body).toBe(draft.text);
    expect(version?.row.metadata).toMatchObject({ source: "hq_handoff", hqDraftId: draft.hqDraftId, verdict: "pass", imageBrief: draft.imageBrief });
    expect(log.some((l) => l.table === "campaign_assets" && l.op === "update" && l.row.stage === "ready_for_owner")).toBe(true);
    expect(log.some((l) => l.table === "campaigns" && l.op === "update" && l.row.status === "in_review")).toBe(true);
  });

  it("returns 200 with the same asset for a repeat of the same draft, and inserts nothing", async () => {
    const { client, log } = fakeClient({ existing: { campaign_asset_id: "asset-1", body: draft.text } });
    const result = await storeHqDraft(client, draft);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ assetId: "asset-1", duplicate: true });
    expect(log.filter((l) => l.op === "insert")).toHaveLength(0);
  });

  it("returns 409 when the same id arrives with different text", async () => {
    const { client } = fakeClient({ existing: { campaign_asset_id: "asset-1", body: "something else entirely that was stored before" } });
    const result = await storeHqDraft(client, draft);
    expect(result.status).toBe(409);
  });

  it("returns 429 once the ten-minute limit is reached", async () => {
    const { client, log } = fakeClient({ recentCount: HQ_HANDOFF_MAX_PER_WINDOW });
    const result = await storeHqDraft(client, draft);
    expect(result.status).toBe(429);
    expect(log.filter((l) => l.op === "insert")).toHaveLength(0);
  });
});
