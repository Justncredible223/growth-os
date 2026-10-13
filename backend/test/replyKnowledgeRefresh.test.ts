import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILLBOOK_SHOWCASE_VIEWS, SHOWCASE_IDS, SHOWCASE_REPLY_GUIDANCE } from "../src/content/fillbookShowcase";
import { buildProspectingSystemPrompt, prospectingPlatformProfile } from "../src/prospecting/prospectingReplyWriter";
import { buildInboundSystemPrompt } from "../src/inbound/inboundResponseWriter";

/**
 * 2026-10-12: replies were describing the site as it was on 2026-09-25 (Starter as the entry plan, "Own Capital" as the
 * plan name, none of the screens added since). These pin the refresh so a later edit cannot quietly drop it.
 */
const NEW_VIEW_IDS = ["account_ledger", "evaluation_ev", "payout_scan", "review_queue", "exit_efficiency", "mentor_link", "auto_sync", "ai_assistant"];
const OWN_ONLY_PLAN_VIEWS = ["capital_curve", "drawdown_odds", "size_from_account", "cost_of_trading", "instrument_and_hours", "margin_exposure"];

describe("reply views match the site as of 2026-10-12", () => {
  it("offers every new view as a reply choice, each with an audience", () => {
    for (const id of NEW_VIEW_IDS) {
      const view = FILLBOOK_SHOWCASE_VIEWS.find((v) => v.id === id);
      expect(view, id).toBeDefined();
      expect(["prop", "own", "both"]).toContain(view!.audience);
      expect(SHOWCASE_IDS).toContain(id);
    }
  });

  it("keeps firm-payout screens away from self-funded traders", () => {
    for (const id of ["account_ledger", "evaluation_ev", "payout_scan"]) {
      expect(FILLBOOK_SHOWCASE_VIEWS.find((v) => v.id === id)?.audience, id).toBe("prop");
    }
  });

  it("never lets a view say real time, live or any broker (the claim rules block those words in a reply that names Fillbook)", () => {
    for (const view of FILLBOOK_SHOWCASE_VIEWS) {
      expect(`${view.problems} ${view.shows}`, view.id).not.toMatch(/real[- ]?time|\blive\b|any broker|every rule|before (a|you) breach/i);
    }
  });

  it("states what the new screens do not know or cover", () => {
    const text = (id: string) => FILLBOOK_SHOWCASE_VIEWS.find((v) => v.id === id)!.shows;
    expect(text("payout_scan")).toMatch(/knows no firm's payout rules/);
    expect(text("evaluation_ev")).toMatch(/not a prediction/);
    expect(text("exit_efficiency")).toMatch(/MFE and MAE/);
    expect(text("exit_efficiency")).toMatch(/not yet checked/);
    expect(text("ai_assistant")).toMatch(/not a trading bot/);
    expect(text("auto_sync")).toMatch(/can trail the broker/);
  });
});

describe("plan wording in replies", () => {
  it("names the plan Essentials, $14.99 a month, and no longer Own Capital", () => {
    expect(SHOWCASE_REPLY_GUIDANCE).toMatch(/called Essentials, \$14\.99 a\s+month/);
    expect(SHOWCASE_REPLY_GUIDANCE).toMatch(/It's on the\s+Essentials plan, \$14\.99 a month/);
    expect(SHOWCASE_REPLY_GUIDANCE).not.toMatch(/called Own Capital, \$14/);
  });

  it("ties the plan fact to the own-money views only and names no plan for the higher-plan screens", () => {
    for (const id of OWN_ONLY_PLAN_VIEWS) expect(SHOWCASE_REPLY_GUIDANCE).toContain(id);
    expect(SHOWCASE_REPLY_GUIDANCE).toMatch(/never say Essentials includes auto_sync,\s+mentor_link, ai_assistant, account_ledger, payout_scan or evaluation_ev/);
    expect(SHOWCASE_REPLY_GUIDANCE).toMatch(/Never name any other plan or price/);
  });

  for (const [name, prompt] of [
    ["cold reply (Prospecting)", buildProspectingSystemPrompt(prospectingPlatformProfile("x"))],
    ["inbound reply", buildInboundSystemPrompt("x")],
  ] as const) {
    it(`${name} prompt lists the new views`, () => {
      for (const id of NEW_VIEW_IDS) expect(prompt, id).toContain(`- ${id}: for `);
    });
  }
});

describe("0052 knowledge refresh", () => {
  const file = readFileSync(join(__dirname, "..", "src", "db", "migrations", "0052_refresh_product_knowledge_2026_10_12.sql"), "utf-8");
  // The header comment names the things deliberately NOT claimed; only the statements are checked for them.
  const sql = file.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("--")).join(" ");

  it("supersedes the old pricing entry instead of deleting it, and is idempotent for the new topics", () => {
    expect(sql).not.toMatch(/\bdelete\s+from\b|\bdrop\b|\btruncate\b/i);
    expect((sql.match(/trust_level = 'deprecated', superseded_by/g) ?? []).length).toBe(1);
    expect(sql).toMatch(/topic = 'pricing'/);
    expect(sql).toMatch(/where not exists \(select 1 from knowledge_documents where topic = 'integrations'/);
    expect(sql).toMatch(/where not exists \(select 1 from knowledge_documents where topic = 'what_fillbook_does'/);
  });

  it("states the current plans and drops the retired claims", () => {
    for (const fact of ["permanent Free plan", "not locked and not read-only", "Essentials ($14.99 a month)", "Core ($24.99 a month)", "Elite ($39.99 a month)", "Starter ($12.99 a month) is retired"]) {
      expect(sql, fact).toContain(fact);
    }
    expect(sql).not.toMatch(/no free plan/i);
    expect(sql).not.toMatch(/account becomes read-only/i);
  });

  it("claims nothing the product facts mark unverified or dark", () => {
    expect(sql).toMatch(/does not run in real time/);
    expect(sql).toMatch(/do not name Rithmic direct, DXtrade or the API-broker connectors as available/);
    expect(sql).not.toMatch(/open P&L from the NinjaTrader add-on[^.]*\b(shows|feeds|counts)\b/i);
    expect(sql).not.toMatch(/ChatGPT[^.]*\b(works|supported)\b/i);
    expect(sql).not.toMatch(/\d{2,}\s+(users|trades|traders)\b/i);
  });
});
