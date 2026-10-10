import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENGAGEMENT_LIMITS,
  arizonaDayKey,
  arizonaDayStartIso,
  checkActionAllowance,
  checkCreatorCooldown,
  checkDailyCap,
  checkDraftingAllowance,
  checkMinSpacing,
  checkOpenAllowance,
  checkQuotaBudget,
  pacificDayKey,
  resolveLimits,
  type PriorDoneAction,
} from "../src/engagement/policy";

const NOW = new Date("2026-10-10T20:00:00.000Z"); // 13:00 in Arizona
const limits = resolveLimits();

function done(platform: "youtube" | "tiktok", creatorId: string, secondsAgo: number): PriorDoneAction {
  return { platform, creatorId, createdAt: new Date(NOW.getTime() - secondsAgo * 1000).toISOString() };
}

describe("engagement limits defaults", () => {
  it("match the owner's decision", () => {
    expect(DEFAULT_ENGAGEMENT_LIMITS.dailyCapPerPlatform).toBe(25);
    expect(DEFAULT_ENGAGEMENT_LIMITS.minSpacingSeconds).toBe(90);
    expect(DEFAULT_ENGAGEMENT_LIMITS.creatorCooldownDays).toBe(3);
    expect(DEFAULT_ENGAGEMENT_LIMITS.youtubeDailyQuotaBudget).toBeLessThanOrEqual(3000);
    expect(DEFAULT_ENGAGEMENT_LIMITS.recentCommentWindow).toBe(200);
  });
});

describe("day keys", () => {
  it("uses the Arizona day (UTC-7, no DST)", () => {
    expect(arizonaDayKey(new Date("2026-10-10T06:59:00.000Z"))).toBe("2026-10-09");
    expect(arizonaDayKey(new Date("2026-10-10T07:00:00.000Z"))).toBe("2026-10-10");
    expect(arizonaDayStartIso(NOW)).toBe("2026-10-10T07:00:00.000Z");
  });
  it("uses the Pacific date for the YouTube quota", () => {
    expect(pacificDayKey(new Date("2026-10-10T05:00:00.000Z"))).toBe("2026-10-09");
    expect(pacificDayKey(new Date("2026-10-10T08:00:00.000Z"))).toBe("2026-10-10");
  });
});

describe("daily cap", () => {
  it("blocks the 26th action of the day on a platform only", () => {
    const youtube = Array.from({ length: 25 }, (_, i) => done("youtube", `c${i}`, 3600 + i));
    expect(checkDailyCap("youtube", youtube, NOW, limits)?.code).toBe("daily_cap");
    expect(checkDailyCap("tiktok", youtube, NOW, limits)).toBeNull();
  });
  it("allows the 25th and ignores yesterday's actions", () => {
    const twentyFour = Array.from({ length: 24 }, (_, i) => done("youtube", `c${i}`, 3600 + i));
    expect(checkDailyCap("youtube", twentyFour, NOW, limits)).toBeNull();
    const yesterday = Array.from({ length: 30 }, (_, i) => ({ platform: "youtube" as const, creatorId: `c${i}`, createdAt: "2026-10-10T06:00:00.000Z" }));
    expect(checkDailyCap("youtube", yesterday, NOW, limits)).toBeNull();
  });
});

describe("minimum spacing", () => {
  it("blocks within 90 seconds of the last action and says how long to wait", () => {
    const block = checkMinSpacing([done("youtube", "a", 30)], NOW, limits);
    expect(block?.code).toBe("min_spacing");
    expect(block?.retryAfterSeconds).toBe(60);
  });
  it("counts the last action on any platform", () => {
    expect(checkMinSpacing([done("tiktok", "a", 10)], NOW, limits)?.code).toBe("min_spacing");
  });
  it("allows at exactly 90 seconds and with no history", () => {
    expect(checkMinSpacing([done("youtube", "a", 90)], NOW, limits)).toBeNull();
    expect(checkMinSpacing([], NOW, limits)).toBeNull();
  });
});

describe("per-creator cooldown", () => {
  it("blocks the same creator for 3 days, case-insensitively, per platform", () => {
    const history = [done("youtube", "UCabc", 2 * 86400)];
    expect(checkCreatorCooldown("youtube", "ucABC", history, NOW, limits)?.code).toBe("creator_cooldown");
    expect(checkCreatorCooldown("tiktok", "UCabc", history, NOW, limits)).toBeNull();
    expect(checkCreatorCooldown("youtube", "someone-else", history, NOW, limits)).toBeNull();
  });
  it("releases after the cooldown", () => {
    expect(checkCreatorCooldown("youtube", "UCabc", [done("youtube", "UCabc", 3 * 86400 + 5)], NOW, limits)).toBeNull();
  });
});

describe("combined allowances", () => {
  const recent = [done("youtube", "other", 20)];
  it("drafting ignores spacing but enforces cap and cooldown", () => {
    expect(checkDraftingAllowance("youtube", "new", recent, NOW, limits)).toBeNull();
    expect(checkDraftingAllowance("youtube", "other", recent, NOW, limits)?.code).toBe("creator_cooldown");
  });
  it("opening ignores spacing too", () => {
    expect(checkOpenAllowance("youtube", "new", recent, NOW, limits)).toBeNull();
  });
  it("copy and done enforce spacing as well", () => {
    expect(checkActionAllowance("youtube", "new", recent, NOW, limits)?.code).toBe("min_spacing");
  });
});

describe("quota budget", () => {
  it("allows a call that fits and refuses one that would cross the budget", () => {
    expect(checkQuotaBudget(2900, 100, limits)).toBeNull();
    expect(checkQuotaBudget(2901, 100, limits)?.code).toBe("quota_budget");
    expect(checkQuotaBudget(0, 100, resolveLimits({ youtubeDailyQuotaBudget: 50 }))?.code).toBe("quota_budget");
  });
});
