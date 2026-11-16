import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retryFailedRender, VideoStatusActionError } from "../src/video/videoStatusHandlers";
import { notifyRenderFailed } from "../scripts/video-worker/render-single";

/** A tiny chainable fake: every table call is recorded; selects resolve to the rows given for that table. */
function fakeClient(opts: { render?: Record<string, unknown> | null; devices?: Array<{ fcm_token: string }>; rpcRow?: Record<string, unknown> | null; rpcError?: string }) {
  const calls: string[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const result = () => {
      if (table === "device_push_tokens") return { data: opts.devices ?? [], error: null };
      return { data: opts.render ?? null, error: null };
    };
    chain.select = () => chain;
    chain.eq = (col: string, val: unknown) => {
      if (chain.__delete) calls.push(`delete ${table} ${col}=${String(val)}`);
      return chain;
    };
    chain.is = () => chain;
    chain.delete = () => {
      chain.__delete = true;
      return chain;
    };
    chain.maybeSingle = () => Promise.resolve(result());
    chain.then = (resolve: (v: unknown) => unknown) => resolve(chain.__delete ? { error: null } : result());
    return chain;
  };
  const rpc = vi.fn().mockResolvedValue({ data: opts.rpcRow ? [opts.rpcRow] : null, error: opts.rpcError ? { message: opts.rpcError } : null });
  return { client: { from, rpc } as unknown as SupabaseClient, calls, rpc };
}

describe("retryFailedRender", () => {
  it("re-queues a failed render through enqueue_video_render and removes the failed row", async () => {
    const { client, calls, rpc } = fakeClient({ render: { campaign_asset_id: "asset-1", status: "failed" }, rpcRow: { eligible: true, reason: null } });
    const result = await retryFailedRender(client, "render-1");
    expect(result).toEqual({ queued: true, reason: null });
    expect(rpc).toHaveBeenCalledWith("enqueue_video_render", expect.objectContaining({ p_campaign_asset_id: "asset-1" }));
    expect(calls).toContain("delete video_renders id=render-1");
  });

  it("keeps the failed row and reports the reason when a render cap refuses the retry", async () => {
    const { client, calls } = fakeClient({ render: { campaign_asset_id: "asset-1", status: "failed" }, rpcRow: { eligible: false, reason: "daily_render_cap_reached" } });
    const result = await retryFailedRender(client, "render-1");
    expect(result).toEqual({ queued: false, reason: "daily_render_cap_reached" });
    expect(calls).toEqual([]);
  });

  it("refuses to retry a ready render whose file is there", async () => {
    const { client, rpc } = fakeClient({ render: { campaign_asset_id: "asset-1", status: "ready", storage_path: "x.mp4" } });
    (client as any).storage = { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed" }, error: null }) }) };
    await expect(retryFailedRender(client, "render-1")).rejects.toBeInstanceOf(VideoStatusActionError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("P0 2026-11-15: a ready render whose file is gone can be re-rendered", async () => {
    const { client, rpc } = fakeClient({ render: { campaign_asset_id: "asset-1", status: "ready", storage_path: "gone.mp4" }, rpcRow: { eligible: true, reason: null } });
    (client as any).storage = { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "Object not found" } }) }) };
    const fromBase = (client as any).from;
    (client as any).from = (t: string) => { const c = fromBase(t); c.update = () => c; return c; };
    const result = await retryFailedRender(client, "render-1");
    expect(result.queued).toBe(true);
    expect(rpc).toHaveBeenCalled();
  });

  it("P0 2026-11-15: a render that is still making progress is not retried (no second runner)", async () => {
    const { client, rpc } = fakeClient({ render: { campaign_asset_id: "asset-1", status: "rendering" } });
    const fromBase = (client as any).from;
    (client as any).from = (t: string) => {
      const c = fromBase(t);
      c.update = () => c; c.in = () => c; c.lt = () => c;
      c.select = () => Object.assign(Promise.resolve({ data: [], error: null }), c, { maybeSingle: c.maybeSingle });
      return c;
    };
    await expect(retryFailedRender(client, "render-1")).rejects.toThrow(/still running/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("says so when the render does not exist", async () => {
    const { client } = fakeClient({ render: null });
    await expect(retryFailedRender(client, "nope")).rejects.toBeInstanceOf(VideoStatusActionError);
  });
});

describe("notifyRenderFailed", () => {
  it("pushes a failed notification to every registered device, with the video's title and a short error", async () => {
    const { client } = fakeClient({
      render: { campaign_assets: { campaigns: { thesis: "5 contracts against a plan of 3" } } },
      devices: [{ fcm_token: "t1" }, { fcm_token: "t2" }],
    });
    const sendPush = vi.fn().mockResolvedValue({ ok: true, isRevokedToken: false });
    await notifyRenderFailed(client, "render-1", "x".repeat(300), sendPush);
    expect(sendPush).toHaveBeenCalledTimes(2);
    const [token, payload] = sendPush.mock.calls[0] as [string, { error: string }];
    expect(token).toBe("t1");
    expect(payload).toMatchObject({ videoRenderId: "render-1", kind: "failed", campaignTitle: "5 contracts against a plan of 3" });
    expect(payload.error.length).toBe(120);
  });

  it("never throws when the push itself fails", async () => {
    const { client } = fakeClient({ render: null, devices: [{ fcm_token: "t1" }] });
    const sendPush = vi.fn().mockRejectedValue(new Error("fcm down"));
    await expect(notifyRenderFailed(client, "render-1", "boom", sendPush)).resolves.toBeUndefined();
  });
});
