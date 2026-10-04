import { describe, it, expect, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyScriptReady } from "../scripts/campaign-worker/notifyScriptReady";

const clientWith = (devices: Array<{ fcm_token: string }>) =>
  ({ from: () => ({ select: () => ({ is: () => Promise.resolve({ data: devices, error: null }) }) }) }) as unknown as SupabaseClient;

afterEach(() => {
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH;
});

describe("notifyScriptReady", () => {
  it("pushes the concept's own title (request prefix removed) to every device", async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH = "/tmp/sa.json";
    const send = vi.fn().mockResolvedValue({ ok: true, isRevokedToken: false });
    await notifyScriptReady(clientWith([{ fcm_token: "a" }, { fcm_token: "b" }]), "Motion concept request: 5 contracts against a plan of 3", send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith("a", "5 contracts against a plan of 3");
  });

  it("does nothing when push isn't configured, and never throws when sending fails", async () => {
    const send = vi.fn();
    await notifyScriptReady(clientWith([{ fcm_token: "a" }]), "t", send);
    expect(send).not.toHaveBeenCalled();
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH = "/tmp/sa.json";
    await expect(notifyScriptReady(clientWith([{ fcm_token: "a" }]), "t", vi.fn().mockRejectedValue(new Error("down")))).resolves.toBeUndefined();
  });
});
