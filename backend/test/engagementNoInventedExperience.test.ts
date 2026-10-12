import { describe, expect, it, vi } from "vitest";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import { checkEngagementComment, findInventedExperience } from "../src/engagement/commentGuardrails";
import { buildEngagementSystemPrompt } from "../src/engagement/engagementDrafter";
import { runEngagementAutoFill, AUTOFILL_SEED_MARKER_V2, type AutoFillDeps } from "../src/engagement/engagementAutoFill";
import { draftItem, getEngagementStatus, markDone, recordCopy, revalidateStoredDrafts, type EngagementDeps } from "../src/engagement/engagementHandlers";
import { AUTOFILL_MAX_DRAFTS_PER_RUN, AUTOFILL_TARGET_WAITING } from "../src/engagement/policy";
import * as repo from "../src/engagement/engagementRepository";

const NOW = new Date("2026-10-11T20:00:00.000Z");
const iso = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

const FORBIDDEN = [
  // The three live examples the owner reported.
  "Getting back in too fast is exactly where I rack up the damage.",
  "Applying it when I'm down two hundred is a different story.",
  "I know the verse.",
  // Ten more first-person variants.
  "Getting back in too fast is exactly where I’ve lost the most.",
  "In my experience the second entry after a loss is the one that hurts.",
  "When I started, cutting size after a red day felt impossible.",
  "We all move the stop at least once before it clicks.",
  "That rule saved me from blowing another account.",
  "As a trader I only take the first sweep of the open.",
  "Honestly the daily limit is the only thing keeping our month green.",
  "This is why my journal has a cooldown column now.",
  "Been there, the revenge trade always feels like a setup.",
  "I'll be trying the two-loss rule on Monday and see what happens.",
  "Same here, stopped moving the stop and the average loser shrank.",
  "Tell me how you handle the open after a gap, does the rule change?",
  "i blew it twice before the cooldown rule made sense.",
  "The hardest part is the first hour and I'd rather sit out than force it.",
  "Reading this made us rethink how we size after a loss.",
];

const GOOD = [
  "The part about waiting for the sweep to reclaim the level is the real filter, not the entry itself.",
  "Does the two-loss rule reset at the next session or does it carry into the next day?",
  "A cooldown after a stop-out sounds simple, but the hard part is sticking to it when the next setup looks perfect.",
  "What counts as the first sign of tilt for you, a bigger size or a faster entry?",
  "Most blown accounts start with one oversized trade after a loss, so the sizing rule at 0:20 is the whole video.",
  "The AI journal idea at 0:15 only works if the trades are logged the same day.",
  "Is the US open the only session this rule applies to, or does London count too?",
  "People often skip the review step because a green day feels like it needs no explaining.",
  "Moving the stop after entry is where a plan quietly turns into a hope, which is the point at 0:08.",
  "Which matters more here, the daily loss limit or the trailing drawdown line on the funded account?",
];

describe("no invented first-person experience: deterministic guardrail", () => {
  it.each(FORBIDDEN)("rejects %s", (text) => {
    expect(findInventedExperience(text)).not.toBeNull();
    expect(checkEngagementComment(text, "youtube")).not.toBeNull();
  });

  it("explains the first-person rejection so the regeneration loop can fix it", () => {
    for (const text of FORBIDDEN.slice(0, 3)) expect(checkEngagementComment(text, "youtube")).toMatch(/first person/);
  });

  it.each(GOOD)("accepts %s", (text) => {
    expect(findInventedExperience(text)).toBeNull();
    expect(checkEngagementComment(text, "youtube")).toBeNull();
  });

  it("handles curly apostrophes and does not trip on acronyms or abbreviations", () => {
    expect(findInventedExperience("I’m down two hundred by the open.")).not.toBeNull();
    expect(findInventedExperience("The A.I. tool and the I.R.S. rules are not first person here, e.g. the iPhone app.")).toBeNull();
    expect(findInventedExperience("US session volume dries up after the first hour of the open.")).toBeNull();
    expect(findInventedExperience("Traders who size up after a loss give it all back, and it shows up in the drawdown.")).toBeNull();
  });

  it("keeps quoted creator phrases simple: a quoted I is rejected", () => {
    expect(findInventedExperience('The line "I will not trade after two losses" is the whole plan.')).not.toBeNull();
  });

  it("states the rule in the drafter prompt", () => {
    const prompt = buildEngagementSystemPrompt("youtube", "");
    expect(prompt).toMatch(/NO INVENTED EXPERIENCE/);
    expect(prompt).toMatch(/I, I'm, I've, I'd, I'll, my, mine, me, myself, we, we're, our, us/);
    expect(prompt).not.toMatch(/small real-world addition from trading experience/);
  });
});

function itemRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `item-${n}`,
    platform: "youtube",
    external_id: `vid${String(n).padStart(8, "0")}`,
    url: `https://www.youtube.com/shorts/vid${n}`,
    title: `Existing short ${n}`,
    creator_id: `UCcreator${n}`,
    creator_name: `Creator ${n}`,
    thumbnail_url: null,
    description: null,
    top_comments: ["A top comment"],
    stats: null,
    source: "search",
    status: "new",
    drafts: [],
    skip_reason: null,
    fetched_at: iso(60),
    created_at: iso(1000 - n),
    updated_at: iso(60),
    ...overrides,
  };
}

function build(tables: Record<string, any[]> = {}) {
  return new FakeSupabaseClient({
    engagement_items: [],
    engagement_actions: [],
    engagement_watchlist: [],
    engagement_quota_ledger: [],
    integration_health: [{ platform: AUTOFILL_SEED_MARKER_V2, status: "healthy" }],
    ...tables,
  });
}

function deps(overrides: Partial<AutoFillDeps> = {}): AutoFillDeps {
  return { now: () => NOW, env: { YOUTUBE_API_KEY: "test-key" }, isPaused: async () => false, loadGrounding: async () => ({ brandRulesSummary: "" }), ...overrides };
}

let optionSeed = 0;
/** Three options sharing no words with any other call's options, so the near-duplicate check never trips. */
function cleanOptions() {
  const word = () => {
    let n = ++optionSeed;
    let w = "";
    for (let i = 0; i < 6; i++) {
      w += String.fromCharCode(97 + (n % 26));
      n = Math.floor(n / 26) + i * 3 + 1;
    }
    return `${w}${optionSeed}`;
  };
  return Array.from({ length: 3 }, () => `Honest question about ${word()} ${word()} ${word()} ${word()} ${word()} ${word()} when sizing positions?`);
}

describe("regeneration loop", () => {
  it("feeds the first-person rejection back and recovers within 3 rounds", async () => {
    const client = build({ engagement_items: [itemRow(1)] });
    const seen: string[][] = [];
    const drafter = vi.fn(async (ctx: { feedback: string[] }) => {
      seen.push(ctx.feedback);
      if (seen.length === 1) return { options: [FORBIDDEN[0]!, FORBIDDEN[1]!, FORBIDDEN[2]!], skipReason: null };
      return { options: cleanOptions().slice(0, 2), skipReason: null };
    });
    const item = await draftItem(asSupabase(client), "item-1", { now: () => NOW, env: {}, loadGrounding: async () => ({ brandRulesSummary: "" }), drafter });
    expect(drafter).toHaveBeenCalledTimes(2);
    expect(seen[1]!.join(" ")).toMatch(/first person/);
    expect(item.drafts).toHaveLength(2);
    expect(item.drafts.every((d) => findInventedExperience(d.text) === null)).toBe(true);
  });

  it("gives up after 3 rounds when every option keeps claiming experience, never storing one", async () => {
    const client = build({ engagement_items: [itemRow(1)] });
    const drafter = vi.fn(async () => ({ options: [FORBIDDEN[3]!, FORBIDDEN[4]!], skipReason: null }));
    await expect(
      draftItem(asSupabase(client), "item-1", { now: () => NOW, env: {}, loadGrounding: async () => ({ brandRulesSummary: "" }), drafter }),
    ).rejects.toThrow(/guardrails/);
    expect(drafter).toHaveBeenCalledTimes(3);
    expect(client.tables.engagement_items![0]!.drafts).toEqual([]);
  });
});

describe("owner-edited text is warned about, not blocked", () => {
  const clean = { id: "item-1", platform: "youtube" };
  it("recordCopy returns a warning and still returns the text", async () => {
    const client = build({ engagement_items: [itemRow(1, { status: "drafted", drafts: [{ id: "d1", text: GOOD[0] }] })] });
    const copied = await recordCopy(asSupabase(client), { id: clean.id, draftId: "d1", text: "Honestly I rack up the damage right here." }, deps() as EngagementDeps);
    expect(copied.text).toBe("Honestly I rack up the damage right here.");
    expect(copied.warnings.join(" ")).toMatch(/first person/);
  });

  it("markDone records an edited first-person text with a warning", async () => {
    const client = build({ engagement_items: [itemRow(1, { status: "drafted", drafts: [{ id: "d1", text: GOOD[0] }] })] });
    const done = await markDone(asSupabase(client), { id: "item-1", did: "commented", finalText: "In my experience that is the whole game." }, deps() as EngagementDeps);
    expect(done.warnings.join(" ")).toMatch(/first person/);
    expect(client.tables.engagement_actions!.find((a) => a.kind === "done")!.final_text).toBe("In my experience that is the whole game.");
  });
});

describe("stored draft revalidation", () => {
  const invented = (text: string) => ({ id: "d1", text });

  it("drops failing drafts, keeps passing ones, resets empty items, leaves history alone, and is idempotent", async () => {
    const client = build({
      engagement_items: [
        itemRow(1, { status: "drafted", drafts: [invented(FORBIDDEN[0]!), { id: "d2", text: GOOD[0] }] }),
        itemRow(2, { status: "drafted", drafts: [invented(FORBIDDEN[1]!), { id: "d2", text: FORBIDDEN[2]! }] }),
        itemRow(3, { status: "drafted", drafts: [invented(GOOD[1]!)] }),
        itemRow(4, { status: "done", drafts: [invented(FORBIDDEN[0]!)] }),
        itemRow(5, { status: "skipped", drafts: [invented(FORBIDDEN[0]!)] }),
      ],
      engagement_actions: [{ id: "a1", item_id: "item-4", platform: "youtube", external_id: "x", creator_id: "c", kind: "drafted", draft_text: FORBIDDEN[0], created_at: iso(500) }],
    });
    const before = JSON.stringify(client.tables.engagement_actions);
    const first = await revalidateStoredDrafts(asSupabase(client), await repo.listQueue(asSupabase(client), 500), NOW);
    expect(first).toEqual({ itemsChanged: 2, draftsDropped: 3, itemsReset: 1 });
    const byId = (id: string) => client.tables.engagement_items!.find((r) => r.id === id)!;
    expect(byId("item-1").drafts.map((d: any) => d.text)).toEqual([GOOD[0]]);
    expect(byId("item-1").status).toBe("drafted");
    expect(byId("item-2")).toMatchObject({ status: "new", drafts: [] });
    expect(byId("item-3").drafts).toHaveLength(1);
    expect(byId("item-4").drafts).toHaveLength(1);
    expect(byId("item-5").drafts).toHaveLength(1);
    expect(JSON.stringify(client.tables.engagement_actions)).toBe(before);

    const second = await revalidateStoredDrafts(asSupabase(client), await repo.listQueue(asSupabase(client), 500), NOW);
    expect(second).toEqual({ itemsChanged: 0, draftsDropped: 0, itemsReset: 0 });
  });

  it("is applied when the queue is loaded", async () => {
    const client = build({ engagement_items: [itemRow(1, { status: "drafted", drafts: [invented(FORBIDDEN[0]!)] })] });
    const status = await getEngagementStatus(asSupabase(client), deps() as EngagementDeps);
    expect(status.queue[0]).toMatchObject({ status: "new", drafts: [] });
  });

  it("the scheduled fill redrafts reset items through the normal drafter, once, and then is a no-op", async () => {
    const stale = Array.from({ length: 4 }, (_, i) => itemRow(i, { status: "drafted", drafts: [invented(FORBIDDEN[i]!)] }));
    const fine = Array.from({ length: AUTOFILL_TARGET_WAITING }, (_, i) => itemRow(100 + i, { status: "drafted", drafts: [{ id: "d1", text: cleanOptions()[0] }] }));
    const client = build({ engagement_items: [...stale, ...fine] });
    const drafter = vi.fn(async () => ({ options: cleanOptions(), skipReason: null }));
    const first = await runEngagementAutoFill(asSupabase(client), deps({ drafter }));
    expect(drafter).toHaveBeenCalledTimes(4);
    expect(first.drafted).toBe(4);
    for (const i of [0, 1, 2, 3]) {
      const row = client.tables.engagement_items!.find((r) => r.id === `item-${i}`)!;
      expect(row.status).toBe("drafted");
      expect(row.drafts.every((d: any) => findInventedExperience(d.text) === null)).toBe(true);
    }
    const again = await runEngagementAutoFill(asSupabase(client), deps({ drafter }));
    expect(drafter).toHaveBeenCalledTimes(4);
    expect(again.drafted).toBe(0);
  });

  it("never exceeds the per-run draft cap: leftovers wait for the next run", async () => {
    const total = AUTOFILL_MAX_DRAFTS_PER_RUN + 3;
    const stale = Array.from({ length: total }, (_, i) => itemRow(i, { status: "drafted", drafts: [invented(FORBIDDEN[0]!)] }));
    const client = build({ engagement_items: stale });
    const drafter = vi.fn(async () => ({ options: cleanOptions(), skipReason: null }));
    // Room to discover is irrelevant: no search results are needed, so a failing fetch is tolerated.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch;
    const first = await runEngagementAutoFill(asSupabase(client), deps({ drafter, fetchImpl }));
    expect(drafter.mock.calls.length).toBeLessThanOrEqual(AUTOFILL_MAX_DRAFTS_PER_RUN);
    expect(first.drafted).toBe(AUTOFILL_MAX_DRAFTS_PER_RUN);
    expect(client.tables.engagement_items!.filter((r) => r.status === "new")).toHaveLength(3);
    const second = await runEngagementAutoFill(asSupabase(client), deps({ drafter, fetchImpl }));
    expect(second.drafted).toBe(3);
    expect(client.tables.engagement_items!.filter((r) => r.status === "new")).toHaveLength(0);
  });
});
