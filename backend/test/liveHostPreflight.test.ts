import { describe, expect, it } from "vitest";
import { checkEnvironment, checkGrowthOsStatus } from "../scripts/live-host/preflight";

const byName = (results: Array<{ name: string; status: string }>, name: string) => results.find((r) => r.name === name)?.status;

describe("preflight environment checks", () => {
  it("fails without a real automation token and passes with one", () => {
    expect(byName(checkEnvironment({}), "Automation token")).toBe("FAIL");
    expect(byName(checkEnvironment({ GROWTH_OS_AUTOMATION_TOKEN: "a".repeat(40) }), "Automation token")).toBe("PASS");
  });

  it("never prints the secret values", () => {
    const secret = "s3cr3t-".repeat(8);
    const text = JSON.stringify(checkEnvironment({ GROWTH_OS_AUTOMATION_TOKEN: secret, GROWTH_OS_PROTECTION_BYPASS_SECRET: secret, OBS_WEBSOCKET_PASSWORD: secret }));
    expect(text).not.toContain(secret);
  });

  it("warns, rather than fails, when running solo or without a platform", () => {
    const results = checkEnvironment({ GROWTH_OS_AUTOMATION_TOKEN: "a".repeat(40) });
    expect(byName(results, "Mode")).toBe("WARN");
    expect(byName(results, "Platform")).toBe("WARN");
    const duo = checkEnvironment({ GROWTH_OS_AUTOMATION_TOKEN: "a".repeat(40), LIVE_HOST_MODE: "duo", LIVE_HOST_PLATFORM: "tiktok" });
    expect(byName(duo, "Mode")).toBe("PASS");
    expect(byName(duo, "Platform")).toBe("PASS");
  });
});

describe("preflight Growth OS checks", () => {
  it("fails when the tables are missing, the system is paused or the budget is spent", () => {
    expect(byName(checkGrowthOsStatus({ configured: false }), "Live Host tables")).toBe("FAIL");
    expect(byName(checkGrowthOsStatus({ systemPaused: true }), "System pause")).toBe("FAIL");
    expect(byName(checkGrowthOsStatus({ budgetReached: true, todaySpendUsd: 3, settings: { dailyBudgetUsd: 3 } }), "Daily budget")).toBe("FAIL");
  });

  it("warns near the budget and when the owner switch is already on", () => {
    expect(byName(checkGrowthOsStatus({ todaySpendUsd: 2.6, settings: { dailyBudgetUsd: 3, desiredState: "on" } }), "Daily budget")).toBe("WARN");
    expect(byName(checkGrowthOsStatus({ settings: { dailyBudgetUsd: 3, desiredState: "on" } }), "Owner switch")).toBe("WARN");
    expect(byName(checkGrowthOsStatus({ todaySpendUsd: 0.5, settings: { dailyBudgetUsd: 3, desiredState: "off" } }), "Owner switch")).toBe("PASS");
  });
});
