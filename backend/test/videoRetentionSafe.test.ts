import { describe, expect, it } from "vitest";
import { pruneOldVideoRenders, RETENTION_MARKER } from "../src/video/videoRenderRetention";

/** Records every write in order; selects return the rows given per table. */
function fakeClient(opts: { renders: any[]; tombstones?: any[]; posts?: any[]; failStorageFor?: string }) {
  const log: string[] = [];
  const from = (table: string) => {
    const q: any = { _filters: {} as Record<string, unknown>, _op: "select" };
    q.select = () => q;
    q.in = (c: string, v: unknown) => ((q._filters[c] = v), q);
    q.lt = () => q;
    q.eq = (c: string, v: unknown) => {
      q._filters[c] = v;
      if (q._op !== "select") log.push(`${q._op} ${table} ${c}=${v}${q._row ? " " + JSON.stringify(q._row.status ?? "") : ""}`);
      return q;
    };
    q.update = (row: any) => ((q._op = "update"), (q._row = row), q);
    q.delete = () => ((q._op = "delete"), q);
    q.then = (resolve: (v: unknown) => unknown) => {
      if (q._op !== "select") return resolve({ error: null });
      if (table === "video_renders") return resolve({ data: q._filters.status === "canceled" ? (opts.tombstones ?? []) : opts.renders, error: null });
      if (table === "video_posts") return resolve({ data: opts.posts ?? [], error: null });
      return resolve({ data: [], error: null });
    };
    return q;
  };
  const storage = {
    from: () => ({
      remove: async (paths: string[]) => {
        log.push(`remove ${paths.join(",")}`);
        return { error: paths.includes(opts.failStorageFor ?? "") ? { message: "boom" } : null };
      },
    }),
  };
  return { client: { from, storage } as any, log };
}

describe("video retention, P0 2026-11-15 (ChatGPT)", () => {
  it("keeps a ready video that is not posted everywhere, and removes a failed one: tombstone, file, then rows", async () => {
    const { client, log } = fakeClient({
      renders: [
        { id: "ready-1", campaign_asset_id: "a1", status: "ready", storage_path: "r1.mp4", thumbnail_path: null },
        { id: "failed-1", campaign_asset_id: "a2", status: "failed", storage_path: null, thumbnail_path: null },
      ],
      posts: [{ campaign_asset_id: "a1", platform: "tiktok" }],
    });
    const summary = await pruneOldVideoRenders(client, new Date("2026-11-30T00:00:00Z"));
    expect(summary).toMatch(/1 removed, 1 kept/);
    expect(log.some((l) => l.includes("ready-1"))).toBe(false);
    const first = log.findIndex((l) => l.startsWith("update video_renders id=failed-1"));
    const rowDelete = log.findIndex((l) => l === "delete video_renders id=failed-1");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(rowDelete).toBeGreaterThan(first);
  });

  it("removes a ready video once it is posted on every platform; a file failure leaves the tombstone and does not stop the others", async () => {
    const { client, log } = fakeClient({
      renders: [
        { id: "done-1", campaign_asset_id: "d1", status: "ready", storage_path: "bad.mp4", thumbnail_path: null },
        { id: "done-2", campaign_asset_id: "d2", status: "ready", storage_path: "ok.mp4", thumbnail_path: null },
      ],
      posts: ["d1", "d2"].flatMap((a) => ["tiktok", "youtube_shorts", "instagram"].map((p) => ({ campaign_asset_id: a, platform: p }))),
      failStorageFor: "bad.mp4",
    });
    const summary = await pruneOldVideoRenders(client, new Date("2026-11-30T00:00:00Z"));
    expect(summary).toMatch(/1 removed, 0 kept .* 1 to retry/);
    expect(log).toContain("delete video_renders id=done-2");
    expect(log).not.toContain("delete video_renders id=done-1");
    expect(RETENTION_MARKER).toBe("retention: removing");
  });
});
