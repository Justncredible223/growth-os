import { describe, it, expect, vi } from "vitest";
import { checkShowcaseShown, capitalizationProblem, dashProblem, checkReplyGuardrails, checkReplySoftStyle, draftWithRetries, MAX_DRAFT_ATTEMPTS, MAX_SOFT_ATTEMPTS, containsAiTell, containsBannedGenericPhrase, containsLink, containsUnverifiedClaim, containsUnsupportedProductClaim, impliesContactOrLinkRequest } from "../src/content/xReplyGuardrails";

describe("checkReplyGuardrails", () => {
  it("passes a purely helpful reply where promotion would be inappropriate -- no Fillbook mention at all", () => {
    const reply = "Trailing drawdown resets at end of day for most prop firms, but a few (like the ones running static drawdown) lock it in permanently, but worth double-checking your specific firm's rulebook before you plan around it.";
    expect(checkReplyGuardrails(reply, false)).toBeNull();
  });

  it("passes a relevant post where a subtle, earned Fillbook mention fits -- soft invitation phrasing, no link, no CTA", () => {
    const reply = "That's the classic problem with spreadsheet journaling. You catch the pattern two weeks too late. That's one of the things we're trying to make easier with Fillbook: flagging the repeat mistake while it's still happening, not after the drawdown.";
    expect(checkReplyGuardrails(reply, false)).toBeNull();
  });

  it("passes a post where a resource link is justified -- expectsLink=true because the conversation specifically asked for a tool", () => {
    const reply = "Sure, Fillbook tracks that automatically and flags it before it becomes a pattern: fillbookhq.com/go/prospecting";
    expect(checkReplyGuardrails(reply, true)).toBeNull();
  });

  it("rejects an overly promotional draft using a banned generic phrase", () => {
    const reply = "Struggling with drawdown discipline? Check out our platform, it solves exactly this!";
    const violation = checkReplyGuardrails(reply, false);
    expect(violation).not.toBeNull();
    expect(violation!.reason).toContain('banned generic phrase "check out our platform"');
  });

  it("rejects a draft with unsupported customer/performance claims", () => {
    const reply = "Our traders saved an average of 22% on drawdown violations after switching to Fillbook.";
    const violation = checkReplyGuardrails(reply, false);
    expect(violation).not.toBeNull();
  });

  it("rejects a draft where Fillbook (a product) speaks as if it personally trades", () => {
    const reply = "I've made consistent profits every month since I started using this rule -- you should too.";
    const violation = checkReplyGuardrails(reply, false);
    expect(violation).not.toBeNull();
    expect(violation!.reason).toContain("personally trading");
  });

  it("rejects a link that appears without being declared intentional (expectsLink=false)", () => {
    const reply = "Worth trying fillbookhq.com for this, honestly.";
    const violation = checkReplyGuardrails(reply, false);
    expect(violation).not.toBeNull();
    expect(violation!.reason).toContain("link that wasn't declared as intentional");
  });

  it("rejects a guarantee-style claim", () => {
    expect(checkReplyGuardrails("This is guaranteed to fix your drawdown problem.", false)).not.toBeNull();
  });

  describe("approvedLinkDomains (Inbound's stricter domain check)", () => {
    it("preserves prospecting's exact old behavior when no allowlist is given -- any link passes once expectsLink=true", () => {
      expect(checkReplyGuardrails("Reach us at some-random-domain.com/anything", true)).toBeNull();
    });

    it("passes a link on an approved domain", () => {
      const reply = "Happy to help directly: fillbookhq.com/go/contact";
      expect(checkReplyGuardrails(reply, true, { approvedLinkDomains: ["fillbookhq.com"] })).toBeNull();
    });

    it("rejects a link on an arbitrary domain even with expectsLink=true", () => {
      const reply = "Reach us at some-random-domain.com/contact";
      const violation = checkReplyGuardrails(reply, true, { approvedLinkDomains: ["fillbookhq.com"] });
      expect(violation).not.toBeNull();
      expect(violation!.reason).toContain("isn't an approved Fillbook link");
      expect(violation!.reason).toContain("some-random-domain.com");
    });

    it("a subdomain of an approved domain is still approved", () => {
      const reply = "See https://help.fillbookhq.com/contact for details.";
      expect(checkReplyGuardrails(reply, true, { approvedLinkDomains: ["fillbookhq.com"] })).toBeNull();
    });

    it("the domain check never runs when expectsLink is false -- the existing undeclared-link rejection still fires first", () => {
      const reply = "Worth trying fillbookhq.com for this, honestly.";
      const violation = checkReplyGuardrails(reply, false, { approvedLinkDomains: ["fillbookhq.com"] });
      expect(violation!.reason).toContain("wasn't declared as intentional");
    });
  });
});

describe("impliesContactOrLinkRequest", () => {
  it("recognizes a direct 'how do I contact you' question", () => {
    expect(impliesContactOrLinkRequest("Interesting how do I contact you though")).toBe(true);
  });

  it("recognizes other real phrasings of the same ask", () => {
    expect(impliesContactOrLinkRequest("what's your website?")).toBe(true);
    expect(impliesContactOrLinkRequest("where do I sign up for this")).toBe(true);
    expect(impliesContactOrLinkRequest("do you have a link for that")).toBe(true);
  });

  it("does not flag an ordinary, unrelated message", () => {
    expect(impliesContactOrLinkRequest("how does trailing drawdown work?")).toBe(false);
    expect(impliesContactOrLinkRequest("Fillbook actually tracks that automatically")).toBe(false);
  });
});

describe("containsBannedGenericPhrase", () => {
  it("catches each banned phrase, case-insensitively", () => {
    expect(containsBannedGenericPhrase("Check Out Our Platform for this.")).not.toBeNull();
    expect(containsBannedGenericPhrase("Learn more about how this works.")).not.toBeNull();
    expect(containsBannedGenericPhrase("DM me and I'll walk you through it.")).not.toBeNull();
  });

  it("does not flag ordinary text with none of the banned phrases", () => {
    expect(containsBannedGenericPhrase("Journaling every loss taught me more about my own patterns than any course did.")).toBeNull();
  });

  it("catches engagement-bait closers (owner-flagged 2026-09-10, real Inbound draft: \"Appreciate you -- let's keep the conversation going.\")", () => {
    expect(containsBannedGenericPhrase("Appreciate you -- let's keep the conversation going.")).not.toBeNull();
    expect(containsBannedGenericPhrase("Would love to hear more about your setup!")).not.toBeNull();
    expect(containsBannedGenericPhrase("What are your thoughts on that?")).not.toBeNull();
  });

  it("KNOWN LIMITATION: this is literal substring matching, not phrase-boundary-aware -- ordinary text that happens to contain an exact banned phrase as a substring is still flagged. Documented, not silently papered over: a false positive here just means a genuinely fine reply gets a rejection message and needs a light edit or a manual override, which is a far safer failure mode than a promotional phrase slipping through.", () => {
    expect(containsBannedGenericPhrase("I learn more about my own trading every time I journal a loss.")).not.toBeNull();
  });
});

describe("containsLink", () => {
  it("detects a full URL and a bare domain mention", () => {
    expect(containsLink("see fillbookhq.com/go/prospecting")).toBe(true);
    expect(containsLink("https://fillbookhq.com")).toBe(true);
  });

  it("does not flag ordinary text with no link-shaped content", () => {
    expect(containsLink("Most firms reset drawdown daily, not weekly.")).toBe(false);
  });
});

describe("containsUnverifiedClaim", () => {
  it("flags a percentage-improvement claim", () => {
    expect(containsUnverifiedClaim("Traders see 30% better consistency with this.")).not.toBeNull();
  });

  it("does not flag a real, hedged, non-quantified observation", () => {
    expect(containsUnverifiedClaim("Journaling tends to help traders notice their own patterns sooner.")).toBeNull();
  });
});


describe("containsUnsupportedProductClaim (claims the product cannot support, 2026-11-18)", () => {
  const blocked: Array<[string, string]> = [
    ["real-time", "Fillbook syncs your trades in real-time."],
    ["real time", "Get real time updates on every fill."],
    ["live sync", "Turn on live sync and forget it."],
    ["instantly syncing", "Your trades are instantly synced from the broker."],
    ["as they happen", "It imports fills as they happen."],
    ["get funded", "Fillbook helps you get funded."],
    ["funded faster", "Journal your trades and get funded faster."],
    ["pass your eval", "Use it to pass your evaluation."],
    ["pass the challenge", "It will help you pass the challenge."],
    ["payout promise", "It helps you keep your payouts."],
    ["never fail", "You will never fail an eval again."],
    ["never lose", "Never lose a funded account."],
    ["risk-free", "A risk-free way to track trades."],
    ["no-risk", "It is a no-risk tool."],
    ["official partner", "We are an official partner of the firm."],
    ["partnered with", "Fillbook partnered with Tradovate."],
    ["endorsed by", "Endorsed by top prop firms."],
    ["approved by", "Approved by the prop firms."],
    ["certified", "A certified trading journal."],
    ["a negation in an earlier clause excuses nothing", "It is not guaranteed, but it syncs in real-time."],
    ["a second match after an excused one", "It is not real-time. It is real-time on weekends."],
  ];
  for (const [name, text] of blocked) {
    it(`flags: ${name}`, () => {
      expect(containsUnsupportedProductClaim(text)).not.toBeNull();
    });
  }

  const allowed: Array<[string, string]> = [
    ["negated real-time", "It is not real-time. It syncs about every few minutes."],
    ["never real-time", "Fillbook never claims real-time syncing."],
    ["without live sync", "It works without live sync, using the Sync now button."],
    ["store listing", "Fillbook is live on Google Play."],
    ["negated funded", "It will not get you funded. It shows what happened in your trades."],
    ["not risk-free", "Trading is not risk-free."],
    ["not endorsed", "Fillbook is not endorsed by any prop firm."],
    ["not affiliated phrasing", "Fillbook is not an official partner of any firm."],
    ["plain journal advice", "Review your trades after each session to see where the plan slipped."],
    ["imports", "It imports your fills from the broker when you tap Sync now."],
    ["time word", "Check your trade time and session before you review."],
    ["partner as a noun", "Find an accountability partner and review together."],
  ];
  for (const [name, text] of allowed) {
    it(`allows: ${name}`, () => {
      expect(containsUnsupportedProductClaim(text)).toBeNull();
    });
  }

  it("is part of containsUnverifiedClaim and therefore checkReplyGuardrails (hard reject on generation, warning on copy)", () => {
    expect(containsUnverifiedClaim("Syncs in real-time.")).not.toBeNull();
    expect(checkReplyGuardrails("Fillbook syncs in real-time.", false)?.reason).toContain("real-time");
    expect(checkReplyGuardrails("Fillbook is not real-time and says so.", false)).toBeNull();
  });
});

describe("containsAiTell -- replies that read as bot-written", () => {
  const flagged: Array<[string, string]> = [
    ["em dash", "Static drawdown never moves — check your rulebook."],
    ["en dash", "Funded accounts – especially trailing ones bite."],
    ["double-hyphen dash stand-in", "Most firms reset daily -- a few don't."],
    ["praise opener", "Great point. Trailing drawdown catches people out."],
    ["love this opener", "Love this take on consistency rules."],
    ["it's not X, it's Y", "It's not about the strategy, it's about the rules you break."],
    ["not just X, but Y", "It's not just a journal, but a mirror."],
    ["less about X more about Y", "Trading is less about entries, more about exits."],
    ["stock AI vocabulary", "Let's delve into how the consistency rule works."],
    ["solicitation closer", "Trailing drawdown resets daily. Thoughts?"],
    ["emoji", "Log it before the next trade \u{1F525}"],
    ["hashtag", "Log every loss #futures"],
    ["multiple exclamation marks", "Log it! Every single one!"],
  ];
  for (const [label, text] of flagged) {
    it(`flags: ${label}`, () => {
      expect(containsAiTell(text)).not.toBeNull();
      expect(checkReplyGuardrails(text, false)).not.toBeNull();
    });
  }

  const clean = [
    "Topstep's trailing drawdown locks at the starting balance once you're up 2k. Check yours.",
    "Logging the loser before you take the next trade is the whole trick",
    "Which firm? The consistency rule differs a lot between them.",
    "That's a 3 contract stop on NQ, so about $180 a pop.",
    "Not sure that's right. Apex resets the threshold at the end of day.",
  ];
  for (const text of clean) {
    it(`passes a natural reply: "${text.slice(0, 40)}"`, () => {
      expect(containsAiTell(text)).toBeNull();
    });
  }
});

describe("pushy-sales phrasing is rejected", () => {
  for (const phrase of ["check it out", "give it a try", "free trial", "use code"]) {
    it(`rejects "${phrase}"`, () => {
      const violation = checkReplyGuardrails(`Logging every loss helps, so ${phrase} sometime.`, false);
      expect(violation?.reason).toContain(phrase);
    });
  }

  it("still allows a plain, single Fillbook mention with no pitch", () => {
    expect(checkReplyGuardrails("Trailing drawdown locks at the starting balance once you're up 2k. We track that automatically in Fillbook.", false)).toBeNull();
  });
});

describe("profit-promise language is rejected", () => {
  for (const text of [
    "Fillbook makes you profitable by showing your patterns.",
    "Log everything and you will become profitable.",
    "This will turn you funded in a month.",
  ]) {
    it(`rejects: ${text}`, () => {
      expect(checkReplyGuardrails(text, false)?.reason).toContain("profitable");
    });
  }
  it("still allows the honest behavior frame", () => {
    expect(checkReplyGuardrails("We track that in Fillbook so you can see what you're actually doing before deciding what to change.", false)).toBeNull();
  });
});

describe("hard length limit vs soft style tells (owner review 2026-09-20)", () => {
  it("rejects a reply over X's 280-character limit outright", () => {
    const violation = checkReplyGuardrails("word ".repeat(60) + "end", false);
    expect(violation?.reason).toContain("too long to post on X");
  });

  it("accepts a reply right at the limit", () => {
    expect(checkReplyGuardrails("A".repeat(280), false)).toBeNull();
  });

  for (const text of [
    "Halving size after a drawdown is the move most traders skip.",
    "The gap between the plan and the click is where it goes wrong.",
    "The second you log the loss, the urge fades.",
    "Same loss every time. That's the gap between a review and a vent.",
    "One. Two. Three. Four.",
    "Halving size works. What's your trigger to go back to full risk?",
  ]) {
    it(`does NOT hard-reject the style tell: ${text.slice(0, 45)}`, () => {
      expect(checkReplyGuardrails(text, false)).toBeNull();
    });
  }

  for (const [text, reason] of [
    ["Halving size after a drawdown is the move most traders skip.", "most traders"],
    ["The gap between the plan and the click is where it goes wrong.", "stock AI framing"],
    ["The second you log the loss, the urge fades.", "stock AI framing"],
    ["Same loss every time. That's the gap between a review and a vent.", "gap between"],
    ["One. Two. Three. Four.", "4 sentences"],
    ["Halving size works. What's your trigger to go back to full risk?", "ends a multi-sentence reply with a question"],
  ] as const) {
    it(`flags it as a soft tell: ${text.slice(0, 45)}`, () => {
      expect(checkReplySoftStyle(text)?.reason).toContain(reason);
    });
  }

  for (const text of [
    "Trailing drawdown locks once you're up 2k.",
    "What was the stop on that one?",
    "Fair, we earned that.",
    "appreciate it",
    "Two contracts on a tighter stop is more risk than the three that lost. Worth checking.",
  ]) {
    it(`raises no soft tell for: ${text}`, () => {
      expect(checkReplySoftStyle(text)).toBeNull();
    });
  }
});

describe("draftWithRetries", () => {
  const clean = { reply: "clean" };
  const assessFor = (table: Record<string, { hard: string | null; soft: string | null }>) => (draft: { reply: string }) => table[draft.reply]!;
  const sequence = (replies: string[]) => {
    const generate = vi.fn(async (_feedback?: string) => ({ reply: replies[Math.min(generate.mock.calls.length - 1, replies.length - 1)]! }));
    return generate;
  };

  it("returns a clean first draft with one call", async () => {
    const generate = sequence(["clean"]);
    const result = await draftWithRetries({ generate, assess: assessFor({ clean: { hard: null, soft: null } }) });
    expect(result.draft).toEqual(clean);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("retries a soft-only draft once with the reason fed back, then shows it as the best attempt", async () => {
    const generate = sequence(["soft", "soft"]);
    const result = await draftWithRetries({ generate, assess: assessFor({ soft: { hard: null, soft: "uses a stock framing" } }) });
    expect(result.draft).toEqual({ reply: "soft" });
    expect(generate).toHaveBeenCalledTimes(MAX_SOFT_ATTEMPTS);
    expect(generate.mock.calls[1]![0]).toContain("uses a stock framing");
  });

  it("takes the clean draft when the soft retry fixes it", async () => {
    const generate = sequence(["soft", "clean"]);
    const result = await draftWithRetries({
      generate,
      assess: assessFor({ soft: { hard: null, soft: "tell" }, clean: { hard: null, soft: null } }),
    });
    expect(result.draft).toEqual(clean);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("retries a hard problem up to MAX_DRAFT_ATTEMPTS and then reports it without a draft", async () => {
    const generate = sequence(["bad"]);
    const result = await draftWithRetries({ generate, assess: assessFor({ bad: { hard: "uses a banned phrase", soft: null } }) });
    expect(result.draft).toBeNull();
    expect(result.hardReason).toBe("uses a banned phrase");
    expect(generate).toHaveBeenCalledTimes(MAX_DRAFT_ATTEMPTS);
  });

  it("keeps an earlier acceptable draft when the soft retry comes back with a hard problem", async () => {
    const generate = sequence(["soft", "bad"]);
    const result = await draftWithRetries({
      generate,
      assess: assessFor({ soft: { hard: null, soft: "tell" }, bad: { hard: "uses a banned phrase", soft: null } }),
    });
    expect(result.draft).toEqual({ reply: "soft" });
  });

  it("recovers when a hard problem is fixed on a later attempt", async () => {
    const generate = sequence(["bad", "clean"]);
    const result = await draftWithRetries({
      generate,
      assess: assessFor({ bad: { hard: "too long", soft: null }, clean: { hard: null, soft: null } }),
    });
    expect(result.draft).toEqual(clean);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("lets assess abort the loop by throwing, with no further attempts", async () => {
    const generate = sequence(["x"]);
    await expect(
      draftWithRetries({
        generate,
        assess: () => {
          throw new Error("irrelevant");
        },
      }),
    ).rejects.toThrow("irrelevant");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("proper capitalization and grammar (owner rule 2026-09-20)", () => {
  const draftFromTheApp =
    "fees are the silent killer. every spread, every sweep that should've been a limit order, the Friday half-size trade that still cost a full commission.";

  it("rejects an all-lowercase draft like the one that reached the Inbound screen", () => {
    expect(checkReplyGuardrails(draftFromTheApp, false)?.reason).toContain("lowercase");
  });

  for (const [text, reason] of [
    ["appreciate it", "starts with a lowercase letter"],
    ["Fees add up. every spread counts.", "starts a sentence with a lowercase letter"],
    ["Is that right? we thought so too.", "starts a sentence with a lowercase letter"],
    ["Honestly that was my mistake and i fixed it.", 'pronoun "I" in lowercase'],
    ["Yeah, i'm the same way about stops.", 'pronoun "I" in lowercase'],
  ] as const) {
    it(`rejects: ${text}`, () => {
      expect(checkReplyGuardrails(text, false)?.reason).toContain(reason);
    });
  }

  for (const text of [
    "Appreciate it.",
    "Fees add up. Every spread counts.",
    "Is that right? We thought so too.",
    "I fixed it after the second stop got moved.",
    "2 contracts on a tighter stop is more risk than the 3 that lost.",
    "MNQ and ES behave differently on the open.",
    "Wait... what was the stop on that one?",
    "Most firms count e.g. the profit target differently than the buffer.",
    "Use \"quotes\" fine. Then continue.",
    "Loss limits are checked vs. the high-water mark, not the start.",
    "Check the rule in your firm's rulebook, not a forum post.",
    "Tagging @someone here. The rule is simple.",
  ]) {
    it(`accepts properly capitalized text: ${text.slice(0, 50)}`, () => {
      expect(checkReplyGuardrails(text, false)).toBeNull();
    });
  }

  it("feeds a clear reason back to the writer on retry so it fixes the capitalization", () => {
    expect(capitalizationProblem("appreciate it")?.reason).toMatch(/proper capitalization and grammar/);
  });
});

describe("dashProblem (video copy rule, owner direction 2026-09-21)", () => {
  for (const text of ["It's structure\u2014not words.", "Range 2020\u20132024", "wait -- what", "no--spaces"]) {
    it(`flags a dash: ${text}`, () => {
      expect(dashProblem(text)?.reason).toContain("dash");
    });
  }
  for (const text of ["A plain hyphen: drawdown-based rules are fine.", "Two sentences. No dashes.", "A range of 5-10 trades."]) {
    it(`allows: ${text}`, () => {
      expect(dashProblem(text)).toBeNull();
    });
  }
});

describe("checkShowcaseShown (owner direction 2026-09-25)", () => {
  it("passes a reply that names Fillbook for the view it picked", () => {
    expect(checkShowcaseShown("Fillbook puts each setup on its own row with its own net P&L.", "setup_breakdown")).toBeNull();
  });

  it("passes a reply that picked no view", () => {
    expect(checkShowcaseShown("Tuesday's CPI print moved it, not your entry.", "none")).toBeNull();
    expect(checkShowcaseShown("Tuesday's CPI print moved it, not your entry.", undefined)).toBeNull();
    expect(checkShowcaseShown("Fillbook tracks that.", undefined)).toBeNull(); // older drafts carry no showcase
  });

  it("flags a reply that picked no view but names Fillbook anyway", () => {
    expect(checkShowcaseShown("Fillbook puts every trade in one place.", "none")?.reason).toMatch(/without picking one of its views/);
  });

  it("flags a reply that picked a view but never shows it", () => {
    expect(checkShowcaseShown("One setup is usually eating the rest.", "setup_breakdown")?.reason).toMatch(/setup_breakdown/);
  });
});
