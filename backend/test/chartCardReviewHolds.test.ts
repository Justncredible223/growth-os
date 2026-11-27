import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { motionConceptStates } from "../api/run-campaign";
import { motionRequestedToday } from "../src/video/dailyLimit";
import { MAX_CHART_CARDS_WAITING, offeredChartConcepts, runDailyChartCardRequests } from "../src/video/dailyChartCardRequests";
import { currentScriptsByTitle, loadReviewHolds, loadReviewRejectedDrafts, reviewHolds, scriptVersion } from "../src/video/reviewHeldConcepts";
import { LOCK_STALE_MINUTES, REFILL_LOCK_KEY, withRefillLock } from "../src/video/refillLock";
import { ATTEMPT_JOB_TYPE, MAX_AUTOMATIC_ATTEMPTS_PER_DAY, isAutomaticRefillRun, linkRefillAttempt, reserveRefillAttempt } from "../src/video/refillAttempts";
import { enqueueMotionConceptRequest } from "../src/opportunities/requestMotionConcept";
import { manualMotionConceptTitle } from "../src/opportunities/manualMotionConcept";

type Row = Record<string, any>;

/** A small in-memory stand-in for the database calls the refill makes, including the unique key on system_jobs. */
class FakeDb {
  tables: Record<string, Row[]> = { campaigns: [], campaign_assets: [], content_versions: [], content_scores: [], campaign_run_requests: [], opportunities: [], system_jobs: [] };
  failing = new Set<string>();
  private nextId = 0;
  clock = new Date("2026-10-27T15:00:00Z");

  add(table: string, row: Row): Row {
    const stored = { id: `${table}-${String(++this.nextId).padStart(6, "0")}`, created_at: this.clock.toISOString(), ...row };
    this.tables[table]!.push(stored);
    return stored;
  }

  from(table: string): any {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "delete" | "insert" | "update" = "select";
    let patch: Row = {};
    let inserted: Row | null = null;
    let range: [number, number] | null = null;
    let single = false;
    const run = () => {
      if (this.failing.has(table)) return { data: null, error: { message: `${table} is down` } };
      const rows = this.tables[table]!;
      if (op === "insert") {
        if (table === "system_jobs" && rows.some((r) => r.idempotency_key === inserted!.idempotency_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        const stored = this.add(table, inserted!);
        return { data: single ? stored : [stored], error: null };
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of matched) Object.assign(r, patch);
        return { data: null, error: null };
      }
      if (op === "delete") {
        this.tables[table] = rows.filter((r) => !matched.includes(r));
        return { data: null, error: null };
      }
      if (single) return matched.length === 1 ? { data: matched[0], error: null } : { data: null, error: { message: "not one row" } };
      return { data: range ? matched.slice(range[0], range[1] + 1) : matched.slice(0, 1000), error: null };
    };
    const query: any = {
      select: () => query,
      insert: (row: Row) => ((op = "insert"), (inserted = row), query),
      delete: () => ((op = "delete"), query),
      update: (row: Row) => ((op = "update"), (patch = row), query),
      single: () => ((single = true), query),
      order: () => query,
      range: (a: number, b: number) => ((range = [a, b]), query),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), query),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), query),
      not: (c: string, op: string, v: unknown) => (filters.push((r) => !(op === "is" && v === null && r[c] == null)), query),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), query),
      lt: (c: string, v: string) => (filters.push((r) => r[c] < v), query),
      gte: (c: string, v: string) => (filters.push((r) => r[c] >= v), query),
      like: (c: string, v: string) => (filters.push((r) => String(r[c]).startsWith(v.replace(/%$/, ""))), query),
      then: (ok: any, bad: any) => Promise.resolve().then(run).then(ok, bad),
    };
    return query;
  }
}

/** The two opportunity reads enqueueMotionConceptRequest makes, which need calls the small fake does not have. */
function opportunityQuery(db: FakeDb): any {
  const rows = db.tables.opportunities!;
  const query: any = {
    select: () => query,
    ilike: () => query,
    eq: () => query,
    limit: () => query,
    order: () => query,
    in: () => query,
    then: (ok: any, bad: any) => Promise.resolve({ data: rows, error: null }).then(ok, bad),
  };
  return query;
}

const concepts = offeredChartConcepts();
const title = (i: number) => manualMotionConceptTitle(concepts[i]!);
const scripts = currentScriptsByTitle();

type Outcome = "rejected" | "passed" | "model-error" | "copy-editor-only" | "gate-blocked";

/** What the campaign worker leaves behind for one requested concept. */
function finishDraft(db: FakeDb, conceptTitle: string, outcome: Outcome, body = scripts.get(conceptTitle)!) {
  const passed = outcome === "passed" || outcome === "copy-editor-only";
  if (outcome === "gate-blocked") {
    // The mechanical gate stops the draft before any review, and the worker records the run as finished.
    const blocked = db.add("campaigns", { thesis: conceptTitle, status: "draft" });
    const draft = db.add("campaign_assets", { campaign_id: blocked.id, asset_type: "video_script", stage: "draft" });
    db.add("content_versions", { campaign_asset_id: draft.id, body });
    db.add("campaign_run_requests", { campaign_asset_id: draft.id, status: "ready", final_stage: "draft" });
    return blocked;
  }
  const campaign = db.add("campaigns", { thesis: conceptTitle, status: passed ? "in_review" : "draft" });
  const asset = db.add("campaign_assets", { campaign_id: campaign.id, asset_type: "video_script", stage: passed ? "ready_for_owner" : "final_draft" });
  const version = db.add("content_versions", { campaign_asset_id: asset.id, body });
  if (outcome === "model-error") return campaign; // the review threw: no verdict is stored
  const score = (evaluator: string, failed: boolean) => db.add("content_scores", { content_version_id: version.id, evaluator, verdict: failed ? "fail" : "pass", score: failed ? 0.4 : 0.9 });
  score("trader", false);
  score("copy_editor", outcome === "copy-editor-only");
  score("fact_checker", outcome === "rejected");
  return campaign;
}

/** One pulse at `at`, wired the way api/growth-pulse.ts wires it. The requested draft finishes before the next pulse. */
async function pulse(db: FakeDb, at: string, outcome: Outcome = "rejected") {
  db.clock = new Date(at);
  const client = db as any;
  const requested: string[] = [];
  const report = await runDailyChartCardRequests({
    now: () => db.clock,
    isPaused: async () => false,
    states: () => motionConceptStates(client),
    requestedToday: () => motionRequestedToday(client, db.clock),
    reviewHolds: () => loadReviewHolds(client, db.clock),
    withLock: (work) => withRefillLock(client, work, db.clock),
    reserveAttempt: (conceptId) => reserveRefillAttempt(client, conceptId, db.clock),
    request: async (conceptId) => {
      requested.push(conceptId);
      finishDraft(db, manualMotionConceptTitle(concepts.find((c) => c.id === conceptId)!), outcome);
      return { campaignRunRequestId: "run", opportunityId: "opp" };
    },
  });
  return { report, requested };
}

// Tuesday 2026-10-27 in Arizona: the three pulses, then Friday's first.
const TUE_1 = "2026-10-27T15:00:00Z";
const TUE_2 = "2026-10-27T20:00:00Z";
const TUE_3 = "2026-10-28T01:00:00Z";
const FRI_1 = "2026-10-30T15:00:00Z";

describe("a script that failed review is requested once", () => {
  it("is not requested again by the later pulses that day, and the next request day moves on", async () => {
    const db = new FakeDb();
    expect((await pulse(db, TUE_1)).requested).toEqual([concepts[0]!.id]);
    for (const at of [TUE_2, TUE_3]) {
      const later = await pulse(db, at);
      expect(later.requested).toEqual([]);
      expect(later.report).toMatch(/today's automatic request was used/);
    }
    const friday = await pulse(db, FRI_1, "passed");
    expect(friday.requested).toHaveLength(1);
    expect(friday.requested[0]).not.toBe(concepts[0]!.id);
    expect(friday.report).toContain(`held after being blocked (needs a revised script): ${concepts[0]!.id}`);
  });

  it("stays held weeks later: the state comes from stored verdicts, not memory", async () => {
    const db = new FakeDb();
    finishDraft(db, title(0), "rejected");
    expect((await pulse(db, "2026-11-17T15:00:00Z")).requested).not.toContain(concepts[0]!.id);
  });

  it("becomes eligible again once its script is substantively revised", async () => {
    const db = new FakeDb();
    finishDraft(db, title(0), "rejected", "HOOK: the old words that were rejected");
    expect((await pulse(db, FRI_1)).requested).toEqual([concepts[0]!.id]);
  });

  it("treats a change of hashtags, spacing or letter case as the same script", async () => {
    const db = new FakeDb();
    const cosmetic = scripts.get(title(0))!.replace(/^HASHTAGS:.*$/m, "HASHTAGS: #other").replace(/\n/g, "\r\n\r\n").toUpperCase().replace(/^HASHTAGS/m, "HASHTAGS");
    finishDraft(db, title(0), "rejected", cosmetic);
    expect((await pulse(db, FRI_1)).requested).not.toContain(concepts[0]!.id);
    expect(scriptVersion("A  b.")).toBe(scriptVersion("a b"));
    expect(scriptVersion("a b")).not.toBe(scriptVersion("a c"));
  });

  it("treats a change to punctuation, titles or captions as the same script", () => {
    const current = scripts.get(title(0))!;
    const template = current
      .replace("YOUTUBE DESCRIPTION:", "YOUTUBE DESCRIPTION:\nA new shared sentence.")
      .replace("TIKTOK CAPTION:", "TIKTOK CAPTION:\nNew caption")
      .replace("YOUTUBE TITLE:", "YOUTUBE TITLE:\nNew title");
    expect(template).not.toBe(current);
    expect(scriptVersion(template)).toBe(scriptVersion(current));
    const spoken = /SCRIPT:\n(.*)/.exec(current)![1]!;
    const repunctuated = current.replace(spoken, spoken.replace(/\. /g, " -- "));
    expect(repunctuated).not.toBe(current);
    expect(scriptVersion(repunctuated)).toBe(scriptVersion(current));
  });

  it("treats a change to the hook, the narration or the shot list as a new script", () => {
    const current = scripts.get(title(0))!;
    for (const heading of ["HOOK: ", "SCRIPT:\n", "SHOT LIST:\n"]) {
      const revised = current.replace(heading, `${heading}Revised words. `);
      expect(revised).not.toBe(current);
      expect(scriptVersion(revised)).not.toBe(scriptVersion(current));
    }
  });

  it("stays held when the concept is renamed but its words are the same", () => {
    const draft = { title: "an older title", body: scripts.get(title(0))!, createdAt: TUE_1 };
    expect(reviewHolds([draft], scripts, new Date(FRI_1)).heldTitles.has(title(0))).toBe(true);
  });

  it("covers every offered concept with a current script", () => {
    for (let i = 0; i < concepts.length; i++) expect(scripts.get(title(i))).toBeTruthy();
  });

  it("says why nothing was requested when every remaining concept is held", async () => {
    const db = new FakeDb();
    for (let i = 0; i < concepts.length; i++) finishDraft(db, title(i), "rejected");
    const result = await pulse(db, FRI_1);
    expect(result.requested).toEqual([]);
    expect(result.report).toMatch(/no unused chart concepts left.*held after being blocked/);
  });
});

describe("only a real judgement holds a concept", () => {
  it("retries after a model or service error, which stores no verdict", async () => {
    const db = new FakeDb();
    expect((await pulse(db, TUE_1, "model-error")).requested).toEqual([concepts[0]!.id]);
    expect((await pulse(db, TUE_2, "passed")).requested).toEqual([concepts[0]!.id]);
  });

  it("retries when only passing verdicts or only a copy editor failure were stored before the run broke", async () => {
    const db = new FakeDb();
    const campaign = finishDraft(db, title(0), "model-error");
    const asset = db.tables.campaign_assets!.find((a) => a.campaign_id === campaign.id)!;
    const version = db.tables.content_versions!.find((v) => v.campaign_asset_id === asset.id)!;
    db.add("content_scores", { content_version_id: version.id, evaluator: "trader", verdict: "pass" });
    db.add("content_scores", { content_version_id: version.id, evaluator: "copy_editor", verdict: "fail", score: 0.4 });
    expect(await loadReviewRejectedDrafts(db as any)).toEqual([]);
  });

  it("counts an explicit failing verdict even when it carries no score", async () => {
    const db = new FakeDb();
    finishDraft(db, title(0), "rejected");
    for (const row of db.tables.content_scores!) if (row.verdict === "fail") row.score = null;
    expect(await loadReviewRejectedDrafts(db as any)).toHaveLength(1);
  });

  it("does not hold a draft left at 'draft' by a run that broke or never finished", async () => {
    for (const run of [null, { status: "failed", final_stage: null }, { status: "running", final_stage: null }]) {
      const db = new FakeDb();
      finishDraft(db, title(0), "gate-blocked");
      db.tables.campaign_run_requests = run ? [{ ...db.tables.campaign_run_requests![0]!, ...run }] : [];
      expect(await loadReviewRejectedDrafts(db as any)).toEqual([]);
    }
  });

  it("ignores drafts that are not chart-card concepts", async () => {
    const db = new FakeDb();
    finishDraft(db, "Video request: something else", "rejected", "text");
    expect(await loadReviewRejectedDrafts(db as any)).toEqual([]);
  });

  it("reads past the database's 1000-row page", async () => {
    const db = new FakeDb();
    for (let i = 0; i < 1005; i++) finishDraft(db, title(0), "rejected");
    expect(await loadReviewRejectedDrafts(db as any)).toHaveLength(1005);
  });

  it("requests nothing when the verdicts cannot be read", async () => {
    const db = new FakeDb();
    finishDraft(db, title(0), "rejected");
    db.failing.add("content_scores");
    await expect(pulse(db, FRI_1)).rejects.toThrow(/Review-held concept lookup failed/);
    expect(db.tables.system_jobs).toEqual([]);
  });
});

describe("a script the mechanical gate blocked", () => {
  it("uses that day's request, is not requested again, and does not block the next concept", async () => {
    const db = new FakeDb();
    expect((await pulse(db, TUE_1, "gate-blocked")).requested).toEqual([concepts[0]!.id]);
    for (const at of [TUE_2, TUE_3]) expect((await pulse(db, at)).report).toMatch(/was blocked today/);
    const friday = await pulse(db, FRI_1, "passed");
    expect(friday.requested).toHaveLength(1);
    expect(friday.requested[0]).not.toBe(concepts[0]!.id);
    expect(friday.report).toContain(`held after being blocked (needs a revised script): ${concepts[0]!.id}`);
  });

  it("becomes eligible again once revised", async () => {
    const db = new FakeDb();
    finishDraft(db, title(0), "gate-blocked", "HOOK: the old words that were blocked");
    expect((await pulse(db, FRI_1)).requested).toEqual([concepts[0]!.id]);
  });
});

describe("broken runs are capped", () => {
  it("makes at most three automatic attempts in a day, then waits for the next request day", async () => {
    expect(MAX_AUTOMATIC_ATTEMPTS_PER_DAY).toBe(3);
    const db = new FakeDb();
    for (const at of [TUE_1, TUE_2, TUE_3]) expect((await pulse(db, at, "model-error")).requested).toEqual([concepts[0]!.id]);
    const fourth = await pulse(db, "2026-10-28T05:00:00Z", "model-error"); // still Tuesday in Arizona
    expect(fourth.requested).toEqual([]);
    expect(fourth.report).toMatch(/3 automatic attempts already made today/);
    expect((await pulse(db, FRI_1, "model-error")).requested).toEqual([concepts[0]!.id]);
  });

  it("backs off between attempts", async () => {
    const db = new FakeDb();
    await pulse(db, TUE_1, "model-error");
    expect((await pulse(db, "2026-10-27T15:30:00Z", "model-error")).report).toMatch(/backing off: attempt 2 needs 60 minutes/);
    expect((await pulse(db, "2026-10-27T16:00:00Z", "model-error")).requested).toHaveLength(1);
    expect((await pulse(db, "2026-10-27T17:00:00Z", "model-error")).report).toMatch(/backing off: attempt 3 needs 120 minutes/);
    expect((await pulse(db, "2026-10-27T18:00:00Z", "model-error")).requested).toHaveLength(1);
  });

  it("counts a request that could not be queued", async () => {
    const db = new FakeDb();
    db.clock = new Date(TUE_1);
    await reserveRefillAttempt(db as any, "x", db.clock);
    await reserveRefillAttempt(db as any, "x", new Date(TUE_2));
    await reserveRefillAttempt(db as any, "x", new Date(TUE_3));
    expect(await reserveRefillAttempt(db as any, "x", new Date("2026-10-28T06:00:00Z"))).toMatchObject({ ok: false });
  });

  it("gives one attempt number to one run only", async () => {
    const db = new FakeDb();
    const now = new Date(TUE_1);
    const [a, b] = await Promise.all([reserveRefillAttempt(db as any, "x", now), reserveRefillAttempt(db as any, "x", now)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(db.tables.system_jobs).toHaveLength(1);
    expect(db.tables.system_jobs![0]).toMatchObject({ job_type: ATTEMPT_JOB_TYPE, status: "succeeded" });
  });

  it("requests nothing when the attempts cannot be read", async () => {
    const db = new FakeDb();
    db.failing.add("system_jobs");
    await expect(reserveRefillAttempt(db as any, "x", new Date(TUE_1))).rejects.toThrow(/refill attempts/);
  });
});

describe("automatic runs are held to the background spending limits", () => {
  const now = new Date(TUE_1);
  async function reserved(db: FakeDb) {
    db.clock = now;
    const r = await reserveRefillAttempt(db as any, concepts[0]!.id, now);
    if (!r.ok) throw new Error(r.reason);
    return r.attemptId;
  }

  it("recognises a queued automatic run by its request id", async () => {
    const db = new FakeDb();
    const id = await reserved(db);
    await linkRefillAttempt(db as any, id, { opportunityId: "opp-1", campaignRunRequestId: "run-1" });
    expect(await isAutomaticRefillRun(db as any, "run-1", "opp-1", now)).toBe(true);
    // A later request for the same concept from the app is the owner's.
    expect(await isAutomaticRefillRun(db as any, "run-2", "opp-1", now)).toBe(false);
  });

  it("recognises it by opportunity while the request id is not written yet, for a short time only", async () => {
    const db = new FakeDb();
    await linkRefillAttempt(db as any, await reserved(db), { opportunityId: "opp-1" });
    expect(await isAutomaticRefillRun(db as any, "run-1", "opp-1", now)).toBe(true);
    expect(await isAutomaticRefillRun(db as any, "run-1", "opp-2", now)).toBe(false);
    expect(await isAutomaticRefillRun(db as any, "run-1", "opp-1", new Date(now.getTime() + 31 * 60_000))).toBe(false);
  });

  it("treats a request with no attempt row as the owner's, and fails rather than guess", async () => {
    const db = new FakeDb();
    expect(await isAutomaticRefillRun(db as any, "run-1", "opp-1", now)).toBe(false);
    db.failing.add("system_jobs");
    await expect(isAutomaticRefillRun(db as any, "run-1", "opp-1", now)).rejects.toThrow(/automatic/);
  });

  it("records the opportunity before the run is queued", async () => {
    const order: string[] = [];
    const db = new FakeDb();
    db.add("opportunities", { title: title(0), status: "open", score: 1, signal_ids: [] });
    const client: any = {
      from: (table: string) => (table === "opportunities" ? opportunityQuery(db) : db.from(table)),
      rpc: async () => (order.push("queued"), { data: [{ campaign_run_request_id: "run-1", job_id: "job", already_existed: false }], error: null }),
    };
    await enqueueMotionConceptRequest(client, concepts[0]!, async () => void order.push("recorded"));
    expect(order).toEqual(["recorded", "queued"]);
  });

  it("is wired into the worker, and the app's endpoint writes no attempt row", () => {
    const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf-8");
    expect(read("scripts/campaign-worker/run-single.ts")).toContain('(await isAutomaticRefillRun(client, campaignRunRequestId, opportunityId)) ? "auto-draft" : "manual"');
    expect(read("api/run-campaign.ts")).not.toMatch(/refillAttempts|reserveRefillAttempt/);
    expect(read("src/content/runCampaignForOpportunity.ts")).toContain('tier: source === "manual" ? "owner" : "background"');
  });
});

describe("the day's automatic request", () => {
  it("is used by a failure earlier the same Arizona day, including one made by hand", () => {
    const draft = { title: title(3), body: "x", createdAt: "2026-10-27T08:00:00Z" }; // 01:00 Tuesday in Arizona
    expect(reviewHolds([draft], scripts, new Date(TUE_3)).rejectedToday).toBe(title(3));
    expect(reviewHolds([draft], scripts, new Date(FRI_1)).rejectedToday).toBeNull();
  });

  it("leaves the app's own request limit unchanged: a failed draft does not block a request by hand", async () => {
    const db = new FakeDb();
    db.clock = new Date(TUE_1);
    finishDraft(db, title(0), "rejected");
    expect(await motionRequestedToday(db as any, db.clock)).toBeNull();
    expect((await motionConceptStates(db as any)).get(title(0))).toBeUndefined();
    const api = readFileSync(join(__dirname, "..", "api", "run-campaign.ts"), "utf-8");
    expect(api).not.toMatch(/reviewHeld|loadReviewHolds|withRefillLock/);
  });
});

describe("approval queue limits still apply", () => {
  it("requests nothing while a passed draft waits in Approvals", async () => {
    expect(MAX_CHART_CARDS_WAITING).toBe(1);
    const db = new FakeDb();
    expect((await pulse(db, TUE_1, "passed")).requested).toHaveLength(1);
    expect((await pulse(db, FRI_1)).report).toMatch(/already waiting/);
  });

  it("sends a copy-editor-only failure to Approvals as before, without holding it", async () => {
    const db = new FakeDb();
    await pulse(db, TUE_1, "copy-editor-only");
    expect((await loadReviewHolds(db as any, db.clock)).heldTitles.size).toBe(0);
    expect((await pulse(db, FRI_1)).report).toMatch(/already waiting/);
  });
});

describe("overlapping pulses", () => {
  it("make one request between them", async () => {
    const db = new FakeDb();
    const [a, b] = await Promise.all([pulse(db, TUE_1, "passed"), pulse(db, TUE_1, "passed")]);
    expect([...a.requested, ...b.requested]).toHaveLength(1);
    expect([a.report, b.report].some((r) => /another chart card refill is running/.test(r))).toBe(true);
    expect(db.tables.system_jobs!.filter((r) => r.idempotency_key === REFILL_LOCK_KEY)).toEqual([]);
  });

  it("releases the lock when the work fails", async () => {
    const db = new FakeDb();
    await expect(withRefillLock(db as any, async () => Promise.reject(new Error("boom")), db.clock)).rejects.toThrow("boom");
    expect(await withRefillLock(db as any, async () => "ran", db.clock)).toBe("ran");
  });

  it("clears a lock left by a killed run, but not a fresh one", async () => {
    const db = new FakeDb();
    const ago = (minutes: number) => new Date(db.clock.getTime() - minutes * 60_000).toISOString();
    db.add("system_jobs", { idempotency_key: REFILL_LOCK_KEY, created_at: ago(LOCK_STALE_MINUTES - 1) });
    expect(await withRefillLock(db as any, async () => "ran", db.clock)).toBeNull();
    db.tables.system_jobs![0]!.created_at = ago(LOCK_STALE_MINUTES + 1);
    expect(await withRefillLock(db as any, async () => "ran", db.clock)).toBe("ran");
  });

  it("lets only one of two runs recover an abandoned lock", async () => {
    const db = new FakeDb();
    db.add("system_jobs", { idempotency_key: REFILL_LOCK_KEY, created_at: new Date(db.clock.getTime() - (LOCK_STALE_MINUTES + 1) * 60_000).toISOString() });
    let ran = 0;
    const work = async () => (ran++, await new Promise((r) => setTimeout(r, 5)), "ran");
    const results = await Promise.all([withRefillLock(db as any, work, db.clock), withRefillLock(db as any, work, db.clock)]);
    expect(ran).toBe(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });

  it("stores the lock as finished, so no job worker claims it, and fails loudly on another database error", async () => {
    const db = new FakeDb();
    await withRefillLock(db as any, async () => {
      expect(db.tables.system_jobs![0]).toMatchObject({ status: "succeeded", job_type: "chart_card_refill_lock" });
      return "ran";
    }, db.clock);
    db.failing.add("system_jobs");
    await expect(withRefillLock(db as any, async () => "ran", db.clock)).rejects.toThrow(/refill lock/);
  });

  it("is wired into the pulse", () => {
    const src = readFileSync(join(__dirname, "..", "api", "growth-pulse.ts"), "utf-8");
    expect(src).toContain("reviewHolds: () => loadReviewHolds(client, now)");
    expect(src).toContain("withLock: (work) => withRefillLock(client, work)");
    expect(src).toContain("reserveAttempt: (conceptId) => reserveRefillAttempt(client, conceptId, now)");
  });
});
