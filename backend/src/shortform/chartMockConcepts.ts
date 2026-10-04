import { buildBarsPlan } from "./chartBarsConcepts.js";
import type { ScenePlan } from "./types.js";

/**
 * The three hand-made chart cards (chartPilots.ts), rebuilt as product-mock slides: same ids, same stories, same
 * recordings, so a concept keeps its place in the app's list, now drawn like every other concept (mockLayout.ts) with a
 * "what else this screen shows" beat. chartPilots.ts keeps the drawn originals for the older chart kinds' own tests; the
 * motion catalog resolves these.
 */
const PAYOUT = "rec.hs-payout-account.v1";
const FINALDAY = "rec.hs-finalday-account.v1";
const MULTI_A = "rec.hs-multi-account-a.v1";
const MULTI_B = "rec.hs-multi-account-b.v1";

export function mockPayoutGapPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-a-17-green-days",
    title: "17 green days and $1,484 still to go",
    topic: "A month of 17 green days out of 18, and the payout gap that one red day is about the size of",
    variationId: "chart-a",
    assetId: PAYOUT,
    expectedTopic: "payout_readiness",
    lines: ["17 green days", "and still", "$1,484 short."],
    accent: "good",
    mock: {
      tag: "Demo data",
      opening: [
        { label: "Green days", value: "17 of 18", tone: "good" },
        { label: "Still short", value: "$1,484", tone: "bad" },
      ],
      windows: [
        { title: "September calendar", rows: [
          { label: "Green days", sub: "Sep", value: "17 of 18", tone: "good" },
          { label: "Worst day", sub: "Sep", value: "-$1,504", tone: "bad" },
        ] },
        { title: "Payout target", rows: [
          { label: "Toward target", sub: "of $9,000", value: "$7,516", tone: "good" },
          { label: "Still to go", sub: "about one red day", value: "$1,484", tone: "bad" },
        ] },
      ],
      focus: [
        { hero: { label: "Still to go", value: "$1,484", tone: "bad" }, window: 1, row: 1 },
        { hero: { label: "One red day", value: "-$1,504", tone: "bad" }, window: 0, row: 1 },
      ],
      details: {
        title: "Calendar · September",
        rows: [
          { label: "Best day", value: "$610.00", tone: "good" },
          { label: "Worst day", value: "-$1,504.04", tone: "bad" },
          { label: "Avg per trading day", value: "$388.66", tone: "good" },
        ],
        footer: "From your synced trades.",
      },
    },
    beats: [
      { stage: 1, seconds: 3.0, facts: ["calendar.green_days"], narration: "17 of 18 days were green.", takeaway: "Almost every day was green.", caption: "17 of 18 days green." },
      { stage: 2, seconds: 3.2, facts: ["payouts.to_go"], narration: "The account is $1,484 short.", takeaway: "How far from the target.", caption: "$7,516 of the $9,000 target." },
      { stage: 3, seconds: 3.4, facts: ["calendar.worst_day", "payouts.to_go"], narration: "But one red day lost $1,504.", takeaway: "One red day is the size of the gap.", caption: "One red day: -$1,504." },
      { stage: 4, seconds: 4.6, facts: ["calendar.overview"], capability: true, narration: "Fillbook's calendar lists your worst day, from your synced trades.", takeaway: "The calendar shows each day's result.", caption: "Best, worst and average day." },
      { stage: 5, seconds: 3.2, facts: ["payouts.to_go"], closing: true, narration: "Check your target against your worst day.", takeaway: "Check the target against the worst day.", caption: "Check your worst day." },
    ],
  });
}

export function mockFinalDayPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-b-10-green-days",
    title: "10 green days and still not done",
    topic: "Ten green days out of ten, and an account still short of its profit target",
    variationId: "chart-b",
    assetId: FINALDAY,
    expectedTopic: "payout_readiness",
    lines: ["10 green days", "and still", "not done."],
    accent: "good",
    mock: {
      tag: "Demo data",
      opening: [
        { label: "Green days", value: "10 of 10", tone: "good" },
      ],
      windows: [
        { title: "September dashboard", rows: [
          { label: "Green days", sub: "Sep", value: "10 of 10", tone: "good" },
          { label: "Account now", sub: "Sep", value: "$2,940", tone: "good" },
        ] },
        { title: "Profit target", rows: [
          { label: "The target", sub: "profit target", value: "$3,000", tone: "good" },
          { label: "Account now", sub: "98% of the target", value: "$2,940", tone: "good" },
        ] },
      ],
      focus: [
        { hero: { label: "Profit target", value: "$3,000", tone: "good" }, window: 1, row: 0 },
        { hero: { label: "Account now", value: "$2,940", tone: "good" }, window: 1, row: 1 },
      ],
      details: {
        title: "Dashboard · September",
        rows: [
          { label: "Best day", value: "$340.00", tone: "good" },
          { label: "Worst day", value: "$180.00", tone: "good" },
          { label: "Avg per trading day", value: "$294.00", tone: "good" },
        ],
        footer: "From your synced trades.",
      },
    },
    beats: [
      { stage: 1, seconds: 2.8, facts: ["dashboard.green_days"], narration: "10 of 10 days were green.", takeaway: "Every day was green.", caption: "10 of 10 days green." },
      { stage: 2, seconds: 3.2, facts: ["rules.target_progress"], narration: "The profit target is $3,000.", takeaway: "How close to the target.", caption: "$2,940 of the $3,000 target." },
      { stage: 3, seconds: 3.0, facts: ["rules.target_progress"], narration: "But the account is only at $2,940.", takeaway: "Ten for ten is still short.", caption: "10 for 10. Still short." },
      { stage: 4, seconds: 4.6, facts: ["dashboard.finalday_summary"], capability: true, narration: "Fillbook's dashboard lists your worst day, from your synced trades.", takeaway: "The dashboard shows each day's result.", caption: "Best, worst and average day." },
      { stage: 5, seconds: 3.2, facts: ["rules.target_progress"], closing: true, narration: "Know your target before the next session.", takeaway: "Know the target before the next session.", caption: "Know your target." },
    ],
  });
}

export function mockTwoAccountsPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-c-one-signal-two-accounts",
    title: "One signal, two accounts, both lost $1,201",
    topic: "One trading signal taken on two accounts, and the same worst day on both",
    variationId: "chart-c",
    assetId: MULTI_B,
    expectedTopic: "accounts_overview",
    lines: ["One signal.", "Two accounts", "lost $1,201."],
    accent: "bad",
    mock: {
      tag: "Demo data",
      opening: [
        { label: "Account A lost", value: "$1,201", tone: "bad" },
      ],
      windows: [
        { title: "Account dashboards", rows: [
          { label: "Account A", sub: "day 25", value: "-$1,201", tone: "bad" },
          { label: "Account B", sub: "day 25", value: "-$1,201", tone: "bad" },
        ] },
        { title: "Worst day · September", rows: [
          { label: "Account A", sub: "on its worst day", value: "$1,201", tone: "bad" },
          { label: "Account B", sub: "the same amount", value: "$1,201", tone: "bad" },
        ] },
      ],
      focus: [
        { hero: { label: "Account B lost", value: "$1,201", tone: "bad" }, window: 0, row: 1 },
        { hero: { label: "Same loss, twice", value: "$1,201", tone: "bad" }, window: 1, row: 1 },
      ],
      details: {
        title: "Dashboard · each account",
        rows: [
          { label: "Worst day · Account A", value: "-$1,201", tone: "bad" },
          { label: "Worst day · Account B", value: "-$1,201", tone: "bad" },
          { label: "Day 25 · trades each", value: "1", tone: "bad" },
        ],
        footer: "From your synced trades.",
      },
    },
    beats: [
      { stage: 1, seconds: 3.0, assetId: MULTI_A, facts: ["dashboard.multi_a_worst_day", "dashboard.multi_a_summary"], narration: "One signal. Account A lost $1,201.", takeaway: "Account A's loss.", caption: "Account A: -$1,201." },
      { stage: 2, seconds: 3.0, assetId: MULTI_B, facts: ["dashboard.multi_b_worst_day", "dashboard.multi_b_summary"], narration: "But Account B lost $1,201 too.", takeaway: "Account B's loss is the same.", caption: "Account B: -$1,201." },
      { stage: 3, seconds: 3.0, assetId: MULTI_B, facts: ["dashboard.multi_b_worst_day", "dashboard.multi_b_summary"], narration: "Same signal. Same loss. Twice.", takeaway: "The same loss on both accounts.", caption: "Same loss. Two accounts." },
      { stage: 4, seconds: 4.6, assetId: MULTI_B, facts: ["dashboard.multi_b_worst_day", "dashboard.multi_b_summary"], capability: true, narration: "Fillbook shows each account's worst day, side by side.", takeaway: "Each account has its own dashboard.", caption: "Every account, side by side." },
      { stage: 5, seconds: 3.2, assetId: MULTI_B, facts: ["dashboard.multi_b_worst_day", "dashboard.multi_b_summary"], closing: true, narration: "Check your size on every account.", takeaway: "Check the size on every account.", caption: "Check every account." },
    ],
  });
}

export const MOCK_CARD_PILOTS: ScenePlan[] = [mockPayoutGapPlan(), mockFinalDayPlan(), mockTwoAccountsPlan()];
