import { describe, it, expect } from "vitest";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import { computeTodayXPostView } from "../api/summary";

// Fixed instant + America/Phoenix (the default schedule timezone) -> operating date 2026-09-05.
const NOW = new Date("2026-09-05T16:00:00Z"); // 09:00 Phoenix

describe("computeTodayXPostView -- the real Supabase-wired lookup Home's GET /api/summary uses", () => {
  it("no run row for today's operating date -> empty", async () => {
    const client = new FakeSupabaseClient({ x_feed_post_runs: [] });

    const view = await computeTodayXPostView(asSupabase(client), NOW);

    expect(view).toMatchObject({ state: "empty", canRegenerate: false });
  });

  it("a ready run resolves the asset's real stage and latest content_version body as the preview text", async () => {
    const client = new FakeSupabaseClient({
      x_feed_post_runs: [
        { id: "run-1", operating_date: "2026-09-05", status: "ready", campaign_asset_id: "asset-1", topic_key: "trailing_drawdown_mechanics", tried_topic_keys: ["trailing_drawdown_mechanics"], attempts: 1, ai_calls: 10, cost_usd: 0.05, error: null, posted_at: null },
      ],
      campaign_assets: [{ id: "asset-1", campaign_id: "camp-1", stage: "ready_for_owner", campaigns: { status: "in_review" } }],
      content_versions: [{ id: "v1", campaign_asset_id: "asset-1", version: 1, body: "Most funded accounts get pulled for violating a rule nobody reads twice." }],
    });

    const view = await computeTodayXPostView(asSupabase(client), NOW);

    expect(view.state).toBe("ready");
    expect(view.campaignAssetId).toBe("asset-1");
    expect(view.previewText).toBe("Most funded accounts get pulled for violating a rule nobody reads twice.");
    expect(view.topicLabel).toContain("drawdown");
  });

  it("a handed-off asset with no posted_at -> handed_off, never fabricating a preview", async () => {
    const client = new FakeSupabaseClient({
      x_feed_post_runs: [{ id: "run-1", operating_date: "2026-09-05", status: "ready", campaign_asset_id: "asset-1", topic_key: "journaling_habit_that_sticks", tried_topic_keys: [], attempts: 1, ai_calls: 10, cost_usd: 0.05, error: null, posted_at: null }],
      campaign_assets: [{ id: "asset-1", campaign_id: "camp-1", stage: "handed_off", campaigns: { status: "in_review" } }],
      content_versions: [],
    });

    const view = await computeTodayXPostView(asSupabase(client), NOW);

    expect(view.state).toBe("handed_off");
    expect(view.previewText).toBeUndefined();
  });

  it("a handed-off asset WITH posted_at -> posted, distinct from handed_off", async () => {
    const client = new FakeSupabaseClient({
      x_feed_post_runs: [{ id: "run-1", operating_date: "2026-09-05", status: "ready", campaign_asset_id: "asset-1", topic_key: "journaling_habit_that_sticks", tried_topic_keys: [], attempts: 1, ai_calls: 10, cost_usd: 0.05, error: null, posted_at: "2026-09-05T18:00:00Z" }],
      campaign_assets: [{ id: "asset-1", campaign_id: "camp-1", stage: "handed_off", campaigns: { status: "in_review" } }],
      content_versions: [],
    });

    const view = await computeTodayXPostView(asSupabase(client), NOW);

    expect(view.state).toBe("posted");
  });

  it("a ready asset whose campaign was retired (owner dismissed it) -> empty, Regenerate offered, no preview leaked", async () => {
    const client = new FakeSupabaseClient({
      x_feed_post_runs: [{ id: "run-1", operating_date: "2026-09-05", status: "ready", campaign_asset_id: "asset-1", topic_key: "revenge_trading_pattern", tried_topic_keys: [], attempts: 1, ai_calls: 10, cost_usd: 0.05, error: null, posted_at: null }],
      campaign_assets: [{ id: "asset-1", campaign_id: "camp-1", stage: "ready_for_owner", campaigns: { status: "retired" } }],
      content_versions: [{ id: "v1", campaign_asset_id: "asset-1", version: 1, body: "should never be shown" }],
    });

    const view = await computeTodayXPostView(asSupabase(client), NOW);

    expect(view).toEqual({ state: "empty", canRegenerate: true });
  });

  it("a failed run surfaces the real recorded reason and offers Regenerate", async () => {
    const client = new FakeSupabaseClient({
      x_feed_post_runs: [{ id: "run-1", operating_date: "2026-09-05", status: "failed", campaign_asset_id: null, topic_key: null, tried_topic_keys: ["trailing_drawdown_mechanics", "journaling_habit_that_sticks"], attempts: 2, ai_calls: 20, cost_usd: 0.1, error: "review gate: fact_checker: unverified claim", posted_at: null }],
    });

    const view = await computeTodayXPostView(asSupabase(client), NOW);

    expect(view).toEqual({ state: "failed", reason: "review gate: fact_checker: unverified claim", canRegenerate: true });
  });

  it("yesterday's ready run does not leak into today's view -- keyed strictly by today's operating date", async () => {
    const client = new FakeSupabaseClient({
      x_feed_post_runs: [{ id: "run-0", operating_date: "2026-09-04", status: "ready", campaign_asset_id: "asset-0", topic_key: "consistency_rule_reality", tried_topic_keys: [], attempts: 1, ai_calls: 10, cost_usd: 0.05, error: null, posted_at: null }],
      campaign_assets: [{ id: "asset-0", campaign_id: "camp-0", stage: "ready_for_owner", campaigns: { status: "in_review" } }],
      content_versions: [{ id: "v0", campaign_asset_id: "asset-0", version: 1, body: "yesterday's post" }],
    });

    const view = await computeTodayXPostView(asSupabase(client), NOW);

    expect(view).toMatchObject({ state: "empty", canRegenerate: false });
  });

  it("a query failure (e.g. the x_feed_post_runs migration not yet applied) is caught and surfaced as a distinct failed state -- never thrown, never confused with a genuine no-post day", async () => {
    const client = new FakeSupabaseClient({});
    client.failTable("x_feed_post_runs", { message: 'relation "x_feed_post_runs" does not exist' });

    const view = await computeTodayXPostView(asSupabase(client), NOW);

    expect(view.state).toBe("failed");
    expect(view.reason).toContain("does not exist");
    expect(view.canRegenerate).toBe(false); // regenerating can't fix a missing table
  });

  it("a posted asset is never re-derived as dismissed even if its campaign was retired afterward -- posted stays posted", async () => {
    const client = new FakeSupabaseClient({
      x_feed_post_runs: [{ id: "run-1", operating_date: "2026-09-05", status: "ready", campaign_asset_id: "asset-1", topic_key: "trailing_drawdown_mechanics", tried_topic_keys: [], attempts: 1, ai_calls: 10, cost_usd: 0.05, error: null, posted_at: "2026-09-05T20:00:00Z" }],
      campaign_assets: [{ id: "asset-1", campaign_id: "camp-1", stage: "handed_off", campaigns: { status: "retired" } }],
      content_versions: [{ id: "v1", campaign_asset_id: "asset-1", version: 1, body: "should stay visible" }],
    });

    const view = await computeTodayXPostView(asSupabase(client), NOW);

    expect(view.state).toBe("posted");
    expect(view.campaignAssetId).toBe("asset-1");
  });
});
