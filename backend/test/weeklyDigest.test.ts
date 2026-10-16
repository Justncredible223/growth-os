import { describe, it, expect, vi } from "vitest";
import { LOW_VIEWS, NOISE_BAND, buildWeeklyDigest, runWeeklyDigestStep, weekStartDay, type OwnPostRow } from "../src/posting/weeklyDigest";

// Arizona is UTC-7 all year, so 12:00 UTC is 05:00 the same Arizona day.
const at = (day: string, hh = "18:00:00") => `${day}T${hh}Z`;

function post(day: string, kind: "reply" | "post", text: string, impressions: number | null): OwnPostRow {
  return { tweetId: `${day}-${text.slice(0, 6)}-${impressions}`, kind, text, createdAt: at(day), impressions };
}

describe("weekStartDay", () => {
  it("is the Monday of the week", () => {
    expect(weekStartDay("2026-10-19")).toBe("2026-10-19"); // Monday
    expect(weekStartDay("2026-10-22")).toBe("2026-10-19"); // Thursday
    expect(weekStartDay("2026-10-25")).toBe("2026-10-19"); // Sunday
  });
});

describe("buildWeeklyDigest", () => {
  const today = "2026-10-19"; // Monday; the review covers 10-12 .. 10-18
  const snaps = [
    { day: "2026-10-12", followers: 44 },
    { day: "2026-10-13", followers: 45 },
    { day: "2026-10-14", followers: 41 },
    { day: "2026-10-15", followers: 42 },
    { day: "2026-10-16", followers: 43 },
    { day: "2026-10-17", followers: 43 },
    { day: "2026-10-18", followers: 41 },
    { day: "2026-10-19", followers: 42 },
  ];

  it("reports the net change, calls a small one noise, and ties the biggest drop to the day before", () => {
    const posts = [
      post("2026-10-13", "reply", "Fillbook puts that setup on its own row.", 2),
      post("2026-10-13", "reply", "Fillbook shows the buffer next to the cap.", 3),
      post("2026-10-13", "post", "One thing a trader can keep.", 40),
    ];
    const d = buildWeeklyDigest(today, snaps, posts);
    expect(d.title).toBe("X weekly review: followers -2");
    expect(d.body).toContain("44 -> 42 (-2)");
    expect(d.body).toContain("within noise");
    expect(d.body).toMatch(/Fell -4 on 2026-10-14; the day before had 2 replies and 1 post, 2 naming Fillbook/);
    expect(d.relatedId).toBe("x-weekly-digest-2026-10-12");
  });

  it("does not call a large change noise", () => {
    const big = [{ day: "2026-10-12", followers: 44 }, { day: "2026-10-18", followers: 44 + NOISE_BAND + 5 }];
    const d = buildWeeklyDigest(today, big, []);
    expect(d.body).not.toContain("within noise");
    expect(d.title).toContain("+8");
  });

  it("lists low-reach replies as a stop list and compares named vs plain only with enough of each", () => {
    const replies = [
      ...Array.from({ length: 3 }, (_, i) => post("2026-10-14", "reply", `Fillbook line ${i}`, 1)),
      ...Array.from({ length: 3 }, (_, i) => post("2026-10-15", "reply", `plain point ${i}`, 20)),
    ];
    const d = buildWeeklyDigest(today, snaps, replies);
    expect(d.body).toMatch(/3 of 6 read back reached under 5 people/);
    expect(d.body).toMatch(/Median views: 20 without Fillbook, 1 naming it/);
    expect(d.body).toMatch(/Stop list: replies like "Fillbook line/);
    expect(LOW_VIEWS).toBe(5);
  });

  it("says plainly when there is too little data instead of inventing a trend", () => {
    const d = buildWeeklyDigest(today, [{ day: "2026-10-18", followers: 44 }], []);
    expect(d.body).toContain("not enough daily readings yet");
    expect(d.body).toContain("Replies: none read back this week.");
    expect(d.title).toBe("X weekly review");
  });

  it("ignores posts outside the seven days", () => {
    const d = buildWeeklyDigest(today, snaps, [post("2026-09-30", "reply", "Fillbook old one", 0)]);
    expect(d.body).toContain("Replies: none read back this week.");
  });
});

describe("runWeeklyDigestStep", () => {
  function fakeClient(opts: { snaps?: any[]; posts?: any[]; existing?: any[]; created?: (row: any) => void; snapError?: { message: string; code?: string } }) {
    return {
      from(table: string) {
        const chain: any = {
          select: () => chain,
          gte: () => chain,
          eq: () => chain,
          limit: () => Promise.resolve({ data: opts.existing ?? [], error: null }),
          order: () =>
            Promise.resolve(
              table === "x_follower_snapshots"
                ? { data: opts.snaps ?? [], error: opts.snapError ?? null }
                : { data: opts.posts ?? [], error: null },
            ),
          insert: (row: any) => {
            opts.created?.(row);
            const single: any = { select: () => ({ single: () => Promise.resolve({ data: { id: "n1", ...row, created_at: "x", read_at: null, related_id: row.related_id }, error: null }) }) };
            return single;
          },
        };
        return chain;
      },
    } as any;
  }

  it("only runs on Mondays (Arizona)", async () => {
    const out = await runWeeklyDigestStep(fakeClient({}), new Date("2026-10-21T20:00:00Z")); // Wednesday
    expect(out).toMatch(/runs on Mondays/);
  });

  it("skips quietly when the follower table is not there yet", async () => {
    const out = await runWeeklyDigestStep(fakeClient({ snapError: { message: 'relation "x_follower_snapshots" does not exist', code: "42P01" } }), new Date("2026-10-19T20:00:00Z"));
    expect(out).toBe("skipped -- migration 0053 not applied yet");
  });

  it("writes one notification, and not a second time for the same week", async () => {
    const created = vi.fn();
    const base = { snaps: [{ day: "2026-10-12", followers: 44 }, { day: "2026-10-18", followers: 46 }], posts: [] };
    const first = await runWeeklyDigestStep(fakeClient({ ...base, created }), new Date("2026-10-19T20:00:00Z"));
    expect(first).toMatch(/^sent: X weekly review: followers \+2/);
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ type: "weekly_digest", severity: "info", related_id: "x-weekly-digest-2026-10-12" }));
    const second = await runWeeklyDigestStep(fakeClient({ ...base, existing: [{ id: "n1" }], created }), new Date("2026-10-19T20:00:00Z"));
    expect(second).toBe("already sent (x-weekly-digest-2026-10-12)");
    expect(created).toHaveBeenCalledTimes(1);
  });
});

describe("other platform counts in the weekly review", () => {
  const today = "2026-10-19";
  const x = [
    { day: "2026-10-12", followers: 44 },
    { day: "2026-10-18", followers: 46 },
  ];

  it("adds a line per platform with two readings and leaves out the rest", () => {
    const d = buildWeeklyDigest(today, x, [], {
      tiktok: [
        { day: "2026-10-13", followers: 67 },
        { day: "2026-10-18", followers: 71 },
      ],
      youtube: [{ day: "2026-10-18", followers: 9 }],
    });
    expect(d.body).toContain("TikTok followers: 67 -> 71 (+4) from 2026-10-13 to 2026-10-18.");
    expect(d.body).not.toContain("YouTube");
    expect(d.body).not.toContain("Instagram");
  });

  it("is unchanged when there are no other-platform readings", () => {
    expect(buildWeeklyDigest(today, x, []).body).toBe(buildWeeklyDigest(today, x, [], {}).body);
    expect(buildWeeklyDigest(today, x, []).body).not.toMatch(/TikTok|YouTube|Instagram/);
  });
});
