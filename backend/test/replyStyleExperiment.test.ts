import { describe, it, expect, vi } from "vitest";
import { LlmClient } from "../src/content/llmClient";
import { HUMAN_REPLY_VOICE_RULES } from "../src/content/humanReplyVoice";
import { buildInboundSystemPrompt } from "../src/inbound/inboundResponseWriter";
import { recoveryFromVisibility, type RecoveryState } from "../src/prospecting/prospectingRecovery";
import {
  PROSPECTING_COLD_NO_PITCH_GUIDANCE,
  PROSPECTING_TWO_OPTION_STYLE_BLOCK,
  buildProspectingSystemPrompt,
  draftProspectingReply,
  prospectingPlatformProfile,
  type ProspectingDraftContext,
  type ProspectingDraftResult,
} from "../src/prospecting/prospectingReplyWriter";
import { draftProspectingCandidateReply, markProspectingReplied, toProspectingJson } from "../src/prospecting/prospectingHandlers";
import { matchPostedStyle, optionSoftProblem, parseDraftOptions, PROSPECTING_TWO_OPTION_DRAFTS } from "../src/prospecting/prospectingDraftOptions";
import { invitesReplies, isReplyWorthyPost, isSalesFunnelOrEmptyPost } from "../src/prospecting/prospectingRelevance";
import { scoreProspectingCandidate } from "../src/prospecting/prospectingScoring";
import { PROSPECTING_TOPICS } from "../src/prospecting/prospectingTopics";
import { buildWeeklyDigest, replyStyleSection, type OwnPostRow } from "../src/posting/weeklyDigest";
import type { NewProspectingCandidate, ProspectingCandidate, ProspectingRepository, ProspectingStatus } from "../src/prospecting/types";

class Repo implements ProspectingRepository {
  rows = new Map<string, ProspectingCandidate>();
  seed(c: ProspectingCandidate) {
    this.rows.set(c.id, c);
  }
  async upsertIfNew(_c: NewProspectingCandidate) {
    return { id: "x", created: true };
  }
  async listByStatus(statuses: ProspectingStatus[]) {
    return [...this.rows.values()].filter((r) => statuses.includes(r.status));
  }
  async listRepliedSince(since: Date) {
    return [...this.rows.values()].filter((r) => r.status === "replied" && r.repliedAt !== null && new Date(r.repliedAt) >= since);
  }
  async getById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async markShown() {}
  async updateStatus(id: string, status: ProspectingStatus, fields: Partial<ProspectingCandidate> = {}) {
    const row = this.rows.get(id);
    if (!row) return;
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    this.rows.set(id, { ...row, ...defined, status });
  }
  async hasPriorOutreach() {
    return false;
  }
  async recordOutreach() {}
  async expireStale() {
    return 0;
  }
}

function candidate(overrides: Partial<ProspectingCandidate> = {}): ProspectingCandidate {
  return {
    id: "c1",
    platform: "x",
    externalId: "123",
    discoveryQuery: "trailing_drawdown",
    authorHandle: "someTrader",
    authorExternalId: "author-1",
    authorName: "Some Trader",
    authorFollowerCount: 2000,
    authorVerified: false,
    postText: "Passed my eval then blew the funded account in two days. Does trailing drawdown lock once you are up?",
    postUrl: "https://x.com/i/web/status/123",
    postCreatedAt: null,
    publicMetrics: {},
    opportunityScore: 70,
    scoreBreakdown: {},
    creatorCandidate: false,
    status: "shown",
    shownAt: null,
    openedAt: null,
    draftReply: null,
    finalReply: null,
    replyMentionsFillbook: null,
    replyUsedLink: null,
    repliedAt: null,
    skipReason: null,
    discoveredAt: "2026-10-16T00:00:00Z",
    createdAt: "2026-10-16T00:00:00Z",
    updatedAt: "2026-10-16T00:00:00Z",
    ...overrides,
  };
}

const SHARP = "Two payouts secured, then size doubled the same afternoon. The floor was never the problem.";
const HELPFUL = "On most firms the trailing floor stops at the starting balance once you are up the drawdown amount. Check yours before sizing up.";

const off = async (): Promise<RecoveryState> => recoveryFromVisibility({ status: "ok", recentMedian: 8, recentCount: 5, baselineMedian: 7, baselineCount: 20 });
const on = async (): Promise<RecoveryState> => recoveryFromVisibility({ status: "dropped", recentMedian: 2.5, recentCount: 30, baselineMedian: 7, baselineCount: 20 });

function twoOption(over: Partial<ProspectingDraftResult> = {}): ProspectingDraftResult {
  return { isRelevant: true, reply: SHARP, helpfulReply: HELPFUL, mentionsFillbook: false, usesLink: false, showcase: "none", ...over };
}

function deps(repo: Repo, drafts: ProspectingDraftResult[], recovery = off, seen: ProspectingDraftContext[] = []) {
  let i = 0;
  return {
    repo,
    drafter: async (context: ProspectingDraftContext) => {
      seen.push(context);
      return drafts[Math.min(i++, drafts.length - 1)]!;
    },
    loadGrounding: async () => ({ brandRulesSummary: "", verifiedKnowledgeSummary: "" }),
    cheapRelevanceCheck: async () => true,
    loadStyleExamples: async () => [],
    loadRecovery: recovery,
  };
}

describe("two-option drafting", () => {
  it("makes ONE model call that returns both options, with the style block in the prompt and both fields in the schema", async () => {
    expect(PROSPECTING_TWO_OPTION_DRAFTS).toBe(true);
    const body = { content: [{ type: "tool_use", name: "submit_reply", input: twoOption() }] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response);
    const client = new LlmClient("test-key", fetchMock);
    const result = await draftProspectingReply(client, { platform: "x", authorHandle: "t", postText: "hi", discoveryQuery: "drawdown" }, "", "");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe(SHARP);
    expect(result.helpfulReply).toBe(HELPFUL);
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    const system = Array.isArray(sent.system) ? sent.system.map((b: { text: string }) => b.text).join(" ") : sent.system;
    expect(system).toContain("COLD REPLY STYLE: TWO OPTIONS");
    expect(system).toContain(PROSPECTING_COLD_NO_PITCH_GUIDANCE);
    expect(system).not.toContain("The Fillbook sentence is the point of the reply");
    expect(sent.tools[0].input_schema.required).toEqual(expect.arrayContaining(["reply", "helpfulReply"]));
    expect(sent.max_tokens).toBeLessThanOrEqual(1000);
  });

  it("keeps every shared hard rule in the prompt and leaves HUMAN_REPLY_VOICE_RULES itself untouched", () => {
    const system = buildProspectingSystemPrompt(prospectingPlatformProfile("x"), true);
    expect(system).toContain(HUMAN_REPLY_VOICE_RULES);
    expect(system).toContain("No em dashes or en dashes at all");
    expect(system).toContain("Never ask for a follow, a like or a repost");
    expect(HUMAN_REPLY_VOICE_RULES).not.toContain("COLD REPLY STYLE");
    expect(PROSPECTING_TWO_OPTION_STYLE_BLOCK).toMatch(/no em or en dashes/);
  });

  it("the single-style prompt (flag off) is exactly the old one", () => {
    const single = buildProspectingSystemPrompt(prospectingPlatformProfile("x"));
    expect(single).not.toContain("COLD REPLY STYLE");
    expect(single).toContain("The Fillbook sentence is the point of the reply, not an aside");
  });

  it("stores both options, with draftReply = the first option so older apps keep working", async () => {
    const repo = new Repo();
    repo.seed(candidate());
    const out = await draftProspectingCandidateReply({} as any, "c1", deps(repo, [twoOption()]));
    expect(out.draftReply).toBe(SHARP);
    expect(out.draftOptions).toEqual([
      { style: "sharp", text: SHARP },
      { style: "helpful", text: HELPFUL },
    ]);
    expect(out.status).toBe("ready");
    const json = toProspectingJson(out);
    expect(json.draftReply).toBe(SHARP);
    expect(json.draftOptions).toHaveLength(2);
  });

  it("a single-style draft (no helpfulReply) behaves exactly as before: draftReply only, no options", async () => {
    const repo = new Repo();
    repo.seed(candidate());
    const out = await draftProspectingCandidateReply({} as any, "c1", deps(repo, [{ isRelevant: true, reply: "Most firms reset at the end of the day.", mentionsFillbook: false, usesLink: false, showcase: "none" }]));
    expect(out.draftReply).toBe("Most firms reset at the end of the day.");
    expect(out.draftOptions ?? null).toBeNull();
  });

  it("a guardrail hit on ONE option regenerates the call with that option named, then stores the clean pair", async () => {
    const repo = new Repo();
    repo.seed(candidate());
    const seen: ProspectingDraftContext[] = [];
    const bad = twoOption({ helpfulReply: "Check the rulebook — the floor usually locks at the start balance once you are up." });
    const out = await draftProspectingCandidateReply({} as any, "c1", deps(repo, [bad, twoOption()], off, seen));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.retryFeedback).toContain("The helpful option");
    expect(seen[1]!.retryFeedback).toContain("Check the rulebook");
    expect(out.draftOptions?.map((o) => o.text)).toEqual([SHARP, HELPFUL]);
  });

  it("if one option never gets clean, the good one is still offered on its own", async () => {
    const repo = new Repo();
    repo.seed(candidate());
    const bad = twoOption({ reply: "Great point, this is a real problem for a lot of people trading funded accounts." });
    const out = await draftProspectingCandidateReply({} as any, "c1", deps(repo, [bad]));
    expect(out.draftOptions).toEqual([{ style: "helpful", text: HELPFUL }]);
    expect(out.draftReply).toBe(HELPFUL);
  });

  it("rejects the draft entirely when both options break a hard rule", async () => {
    const repo = new Repo();
    repo.seed(candidate());
    const bad = twoOption({ reply: "Great point on that one, honestly worth a careful look.", helpfulReply: "Learn more at fillbookhq.com about the floor." });
    await expect(draftProspectingCandidateReply({} as any, "c1", deps(repo, [bad]))).rejects.toThrow(/Draft rejected/);
  });

  it("neither option may name Fillbook on a cold reply unless the post asked about it", async () => {
    const repo = new Repo();
    repo.seed(candidate());
    const names = twoOption({ helpfulReply: "Fillbook's Account Health view shows the buffer left from your synced trades." });
    const seen: ProspectingDraftContext[] = [];
    const out = await draftProspectingCandidateReply({} as any, "c1", deps(repo, [names, twoOption()], off, seen));
    expect(seen[1]!.retryFeedback).toMatch(/names Fillbook in a cold reply/);
    expect(out.draftOptions?.every((o) => !/fillbook/i.test(o.text))).toBe(true);

    const asked = new Repo();
    asked.seed(candidate({ postText: "Does Fillbook track trailing drawdown for prop firm funded accounts?" }));
    const ok = await draftProspectingCandidateReply({} as any, "c1", deps(asked, [twoOption({ helpfulReply: "Fillbook's Account Health shows the buffer from your synced trades.", mentionsFillbook: true })]));
    expect(ok.draftOptions?.[1]?.text).toMatch(/Fillbook/);
  });

  it("recovery mode: no Fillbook in either option, even when the post names it", async () => {
    const repo = new Repo();
    repo.seed(candidate({ postText: "Does Fillbook track trailing drawdown for prop firm funded accounts?" }));
    const seen: ProspectingDraftContext[] = [];
    const named = twoOption({ helpfulReply: "Fillbook's Account Health shows the buffer from your synced trades.", mentionsFillbook: true });
    const out = await draftProspectingCandidateReply({} as any, "c1", deps(repo, [named, twoOption()], on, seen));
    expect(seen[0]!.recoveryNote).toMatch(/RECOVERY MODE/);
    expect(seen[1]!.retryFeedback).toMatch(/recovery mode/);
    expect(out.draftOptions?.every((o) => !/fillbook/i.test(o.text))).toBe(true);
  });

  it("soft style problems (sharp too long) get one retry and then the best attempt is shown", async () => {
    const repo = new Repo();
    repo.seed(candidate());
    const long = twoOption({ reply: "Sized up after two payouts on a Friday and the floor caught it before the week ended for good, which is a lot of words for a sharp line." });
    const seen: ProspectingDraftContext[] = [];
    const out = await draftProspectingCandidateReply({} as any, "c1", deps(repo, [long], off, seen));
    expect(seen).toHaveLength(2);
    expect(out.draftOptions).toHaveLength(2);
    expect(optionSoftProblem("sharp", long.reply)).toMatch(/words/);
  });
});

describe("sharp option slogan check", () => {
  it("flags the personified and punchline slogan shapes, and the balanced two-beat rhythm", () => {
    expect(optionSoftProblem("sharp", "The drawdown doesn't care why you sized up after the second payout hit.")).toMatch(/slogan/);
    expect(optionSoftProblem("sharp", "You sized up after two payouts on a Friday, and the floor just knows it by now.")).toMatch(/slogan/);
    expect(optionSoftProblem("sharp", "Payouts hit Friday. Size doubled by lunch time today.")).toMatch(/balanced|slogan/);
  });

  it("leaves ordinary specific lines and common phrases alone", () => {
    expect(optionSoftProblem("sharp", SHARP)).toBeNull();
    expect(optionSoftProblem("sharp", "Two payouts secured on a Friday, then double size by lunch. That Friday is worth a second look.")).toBeNull();
    expect(optionSoftProblem("sharp", "Nobody knows where the floor sits on that firm until the third trade on Monday morning.")).toBeNull();
    expect(optionSoftProblem("sharp", "I don't know any firm that resets the buffer on a Friday close, so check yours first.")).toBeNull();
  });

  it("the helpful option is not held to the slogan check", () => {
    expect(optionSoftProblem("helpful", "The floor doesn't care. Check it.")).toBeNull();
  });

  it("the prompt asks for a trade-log lens without naming a tool", () => {
    expect(PROSPECTING_TWO_OPTION_STYLE_BLOCK).toMatch(/trade log/);
    expect(PROSPECTING_TWO_OPTION_STYLE_BLOCK).toMatch(/Do NOT write a slogan/);
    expect(PROSPECTING_TWO_OPTION_STYLE_BLOCK).not.toMatch(/It just knows you did/);
  });
});

describe("posted style tag", () => {
  const options = [
    { style: "sharp" as const, text: SHARP },
    { style: "helpful" as const, text: HELPFUL },
  ];

  it("matches the posted text to an option, ignoring whitespace, and tags anything else edited", () => {
    expect(matchPostedStyle(SHARP, options, SHARP)).toBe("sharp");
    expect(matchPostedStyle(`  ${HELPFUL.replace(" ", "  ")} `, options, SHARP)).toBe("helpful");
    expect(matchPostedStyle("Something I typed myself.", options, SHARP)).toBe("edited");
    expect(matchPostedStyle("Old draft.", null, "Old draft.")).toBe("legacy");
    expect(matchPostedStyle("Changed.", null, "Old draft.")).toBe("edited");
    expect(matchPostedStyle(undefined, options, SHARP)).toBe("edited");
  });

  it("parseDraftOptions tolerates malformed storage", () => {
    expect(parseDraftOptions("not json")).toBeNull();
    expect(parseDraftOptions(JSON.stringify([{ style: "x", text: "a" }]))).toBeNull();
    expect(parseDraftOptions(JSON.stringify(options))).toEqual(options);
  });

  async function replied(final: string | undefined, over: Partial<ProspectingCandidate> = {}) {
    const repo = new Repo();
    repo.seed(candidate({ status: "ready", draftReply: SHARP, draftOptions: options, ...over }));
    return markProspectingReplied({} as any, "c1", final, false, false, { repo });
  }

  it("persists sharp when the app sends no finalReply (draftReply posted as is)", async () => {
    expect((await replied(undefined)).postedStyle).toBe("sharp");
  });
  it("persists helpful when the app sends the second option's text", async () => {
    const row = await replied(HELPFUL);
    expect(row.postedStyle).toBe("helpful");
    expect(row.finalReply).toBe(HELPFUL);
  });
  it("persists edited when the owner changed the text", async () => {
    expect((await replied("My own version.")).postedStyle).toBe("edited");
  });
  it("persists legacy for an old single-style draft posted unchanged", async () => {
    expect((await replied(undefined, { draftOptions: null, draftReply: "Old draft." })).postedStyle).toBe("legacy");
  });
});

describe("candidate filters", () => {
  const dropped = [
    "LIVE TRADING ACADEMY ✅ futures trading mentorship, prop firm funded account strategies. Limited spots. JOIN",
    "Dispopular opinion: CFD trading beats futures for prop firm funded accounts. CFD or Futures? #trading #futures #propfirm",
    "Join our free trading academy and learn futures trading and prop firm drawdown rules",
    "Futures trading signals for prop firm funded accounts, DM me for details",
    "Join the VIP signals group for futures traders, link in the replies",
    "#futures #trading #daytrading",
    "https://t.co/abc123 #futures",
    "Prop firm funded account tips https://example.com/course grab your spot today",
    "MT5 CFD broker with zero commission on futures trading, open an account",
  ];
  const kept = [
    "Passed my eval then blew the funded account in two days. Does trailing drawdown lock once you are up?",
    "Is it just me or does a futures prop firm daily loss limit make you trade worse? What do you do after the first loss?",
    "Anyone else size up after two green days on a funded futures account?",
    "CFD vs futures for a prop firm funded account, what are the actual cost differences?",
    "My futures trading journal says I lose most on Fridays. Telling myself to stop after 11am is not working.",
  ];

  it("drops sales funnels, CFD promo and hashtag/link-only posts", () => {
    for (const text of dropped) expect(isReplyWorthyPost(text), text).toBe(false);
  });

  it("keeps genuine trader questions and personal posts", () => {
    for (const text of kept) expect(isReplyWorthyPost(text), text).toBe(true);
  });

  it("the funnel check itself flags only the funnel shapes", () => {
    expect(isSalesFunnelOrEmptyPost(dropped[0]!)).toBe(true);
    expect(isSalesFunnelOrEmptyPost(kept[0]!)).toBe(false);
  });

  it("gives a small score boost for a post that invites replies, on top of the question points and 1k-30k bonus", () => {
    const topic = PROSPECTING_TOPICS[0]!;
    const now = new Date("2026-10-16T12:00:00Z");
    const base = { topic, postCreatedAt: now, publicMetrics: {}, authorFollowerCount: 2000, authorVerified: false, previouslyEngaged: false, now };
    const plain = scoreProspectingCandidate({ ...base, postText: "Funded account drawdown hit me again today after a sloppy session." });
    const invite = scoreProspectingCandidate({ ...base, postText: "Funded account drawdown hit me again today. What do you do after a bad session." });
    expect(invitesReplies("anyone else size up after a win?")).toBe(true);
    expect(invite.score).toBeGreaterThan(plain.score);
    expect(plain.breakdown.midSizedAccount).toMatch(/\+6/);
    expect(invite.breakdown.valueOpportunity).toMatch(/invites replies/);
  });
});

describe("weekly review: reply style results", () => {
  const mk = (i: number, candidateId: string, views: number, likes: number): OwnPostRow => ({
    tweetId: `t${i}`,
    kind: "reply",
    text: `reply ${i}`,
    createdAt: "2026-10-14T18:00:00Z",
    impressions: views,
    likes,
    prospectingCandidateId: candidateId,
  });

  it("stays out until a style has at least 3 replies", () => {
    const styles = new Map([["a", "sharp"], ["b", "sharp"], ["c", "helpful"]]);
    expect(replyStyleSection([mk(1, "a", 20, 1), mk(2, "b", 10, 0), mk(3, "c", 5, 0)], styles)).toBeNull();
  });

  it("reports median views and likes per style with sample sizes and a noise note", () => {
    const styles = new Map<string, string>();
    const posts: OwnPostRow[] = [];
    [12, 20, 40].forEach((v, i) => {
      styles.set(`s${i}`, "sharp");
      posts.push(mk(i, `s${i}`, v, i));
    });
    [3, 4, 9].forEach((v, i) => {
      styles.set(`h${i}`, "helpful");
      posts.push(mk(10 + i, `h${i}`, v, 0));
    });
    styles.set("e0", "edited");
    posts.push(mk(20, "e0", 7, 0));
    posts.push(mk(21, "unknown", 2, 0)); // no recorded tag -> legacy
    const lines = replyStyleSection(posts, styles)!;
    const text = lines.join("\n");
    expect(text).toMatch(/sharp: 3 replies, median 20 views, median 1 likes/);
    expect(text).toMatch(/helpful: 3 replies, median 4 views, median 0 likes/);
    expect(text).toMatch(/edited: 1 reply, too few for a median/);
    expect(text).toMatch(/legacy: 1 reply, too few/);
    expect(text).toMatch(/noise/);
    expect(text).not.toMatch(/because|caused|proves/);
  });

  it("appears in the digest body only when enough replies exist", () => {
    const styles = new Map<string, string>();
    const posts: OwnPostRow[] = [];
    [12, 20, 40].forEach((v, i) => {
      styles.set(`s${i}`, "sharp");
      posts.push(mk(i, `s${i}`, v, 1));
    });
    const withStyles = buildWeeklyDigest("2026-10-19", [], posts, {}, styles);
    expect(withStyles.body).toMatch(/Reply style results/);
    expect(buildWeeklyDigest("2026-10-19", [], posts.slice(0, 2), {}, styles).body).not.toMatch(/Reply style results/);
    expect(buildWeeklyDigest("2026-10-19", [], posts).body).not.toMatch(/Reply style results/);
  });
});

describe("Inbound is unchanged", () => {
  it("the shared voice rules and the Inbound prompt carry none of the new Prospecting style block", () => {
    const inbound = buildInboundSystemPrompt("x");
    expect(inbound).toContain(HUMAN_REPLY_VOICE_RULES);
    expect(inbound).not.toContain("COLD REPLY STYLE");
    expect(inbound).not.toContain("helpfulReply");
    // The line the style block overrides for Prospecting is still in the shared text Inbound uses.
    expect(HUMAN_REPLY_VOICE_RULES).toContain("Each reply must carry one thing a trader can keep");
  });
});
