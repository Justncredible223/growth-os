import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/approvals";

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("engagement assistant auth", () => {
  const APP = "app-token-0123456789-abcdefghijklmnop";
  const AUTOMATION = "automation-token-0123456789-abcdefghijklmnop";
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.APP_API_TOKEN = APP;
    process.env.APP_API_TOKEN_AUTOMATION = AUTOMATION;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it.each([
    ["GET", {}],
    ["POST", { action: "done", id: "x" }],
    ["POST", { action: "discover" }],
    ["POST", { action: "add-link", url: "https://www.tiktok.com/@a/video/1" }],
  ])("refuses the automation token on %s", async (method, body) => {
    const res = mockRes();
    await handler({ method, query: { resource: "engagement" }, headers: { authorization: `Bearer ${AUTOMATION}` }, body } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("refuses a request with no token", async () => {
    const res = mockRes();
    await handler({ method: "GET", query: { resource: "engagement" }, headers: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
