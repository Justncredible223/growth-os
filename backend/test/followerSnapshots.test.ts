import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMissingFollowerTable, runFollowerSnapshotStep, summarizeFollowerChange } from "../src/posting/followerSnapshots";
import { RunScopedXReads } from "../src/signals/adapters/runScopedXReads";

describe("summarizeFollowerChange", () => {
  const hist = [
    { day: "2026-10-14", followers: 800 },
    { day: "2026-10-13", followers: 806 },
    { day: "2026-10-08", followers: 790 },
  ];

  it("says the change since yesterday and since a week ago, signed", () => {
    expect(summarizeFollowerChange("2026-10-15", 812, hist)).toBe("812 followers (+12 vs yesterday, +22 over 7 days)");
  });

  it("names the date when yesterday is missing instead of calling it yesterday", () => {
    expect(summarizeFollowerChange("2026-10-15", 795, [{ day: "2026-10-12", followers: 800 }])).toBe("795 followers (-5 vs 2026-10-12)");
  });

  it("says plainly when there is nothing to compare yet", () => {
    expect(summarizeFollowerChange("2026-10-15", 812, [])).toBe("812 followers (first reading, nothing to compare yet)");
  });

  it("ignores today's own row when comparing", () => {
    expect(summarizeFollowerChange("2026-10-15", 812, [{ day: "2026-10-15", followers: 812 }, ...hist])).toContain("+12 vs yesterday");
  });
});

describe("runFollowerSnapshotStep", () => {
  const NOW = new Date("2026-10-15T20:00:00Z"); // 13:00 Arizona, 2026-10-15

  function fakeClient(rows: Array<{ day: string; followers: number }>, opts: { selectError?: { message: string; code?: string }; onUpsert?: (row: any) => void } = {}) {
    const chain: any = {
      select: () => chain,
      gte: () => chain,
      order: () => Promise.resolve({ data: rows, error: opts.selectError ?? null }),
      upsert: (row: any) => {
        opts.onUpsert?.(row);
        return Promise.resolve({ error: null });
      },
    };
    return { from: () => chain } as any;
  }

  it("skips quietly when the migration is not applied, without any X call", async () => {
    const fetchProfile = vi.fn();
    const client = fakeClient([], { selectError: { message: 'relation "x_follower_snapshots" does not exist', code: "42P01" } });
    expect(await runFollowerSnapshotStep({ client, now: NOW, fetchProfile })).toBe("skipped -- migration 0053 not applied yet");
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it("makes no X call when today already has a row", async () => {
    const fetchProfile = vi.fn();
    const client = fakeClient([{ day: "2026-10-15", followers: 812 }, { day: "2026-10-14", followers: 800 }]);
    const out = await runFollowerSnapshotStep({ client, now: NOW, fetchProfile });
    expect(out).toContain("already recorded today");
    expect(out).toContain("+12 vs yesterday");
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it("writes today's numbers once and reports the change", async () => {
    const onUpsert = vi.fn();
    const client = fakeClient([{ day: "2026-10-14", followers: 800 }], { onUpsert });
    const out = await runFollowerSnapshotStep({ client, now: NOW, fetchProfile: async () => ({ followers: 797, following: 120, tweetCount: 540 }) });
    expect(out).toBe("797 followers (-3 vs yesterday)");
    expect(onUpsert).toHaveBeenCalledWith(expect.objectContaining({ day: "2026-10-15", followers: 797, following: 120, tweet_count: 540 }));
  });

  it("records nothing when the profile has no follower count", async () => {
    const onUpsert = vi.fn();
    const out = await runFollowerSnapshotStep({ client: fakeClient([], { onUpsert }), now: NOW, fetchProfile: async () => ({ followers: null, following: null, tweetCount: null }) });
    expect(out).toMatch(/no follower count/);
    expect(onUpsert).not.toHaveBeenCalled();
  });

  it("recognises the missing-table error text from both Postgres and PostgREST", () => {
    expect(isMissingFollowerTable('relation "x_follower_snapshots" does not exist 42P01')).toBe(true);
    expect(isMissingFollowerTable("Could not find the table 'public.x_follower_snapshots' in the schema cache PGRST205")).toBe(true);
    expect(isMissingFollowerTable("permission denied for table x_own_posts")).toBe(false);
  });
});

describe("RunScopedXReads shares the one /users/me call", () => {
  it("returns id and numbers from a single adapter call, whichever is asked first", async () => {
    const resolveOwnProfile = vi.fn().mockResolvedValue({ id: "42", followers: 800, following: 10, tweetCount: 5 });
    const reads = new RunScopedXReads({ resolveOwnProfile } as any, { load: async () => null } as any, []);
    expect(await reads.resolveOwnUserId()).toBe("42");
    expect((await reads.resolveOwnProfile()).followers).toBe(800);
    expect(await reads.resolveOwnUserId()).toBe("42");
    expect(resolveOwnProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps working with an adapter that only has resolveOwnUserId", async () => {
    const resolveOwnUserId = vi.fn().mockResolvedValue("7");
    const reads = new RunScopedXReads({ resolveOwnUserId } as any, { load: async () => null } as any, []);
    expect(await reads.resolveOwnUserId()).toBe("7");
    expect(await reads.resolveOwnUserId()).toBe("7");
    expect(resolveOwnUserId).toHaveBeenCalledTimes(1);
  });
});

describe("migration 0053", () => {
  const sql = readFileSync(join(__dirname, "..", "src", "db", "migrations", "0053_x_follower_snapshots.sql"), "utf-8");
  it("is additive and keyed on the day", () => {
    expect(sql).toMatch(/create table if not exists x_follower_snapshots/);
    expect(sql).toMatch(/day date primary key/);
    expect(sql).toMatch(/enable row level security/);
    expect(sql).not.toMatch(/\bdrop\b|\bdelete\s+from\b|\btruncate\b/i);
  });
});
