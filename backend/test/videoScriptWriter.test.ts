import { describe, it, expect, vi } from "vitest";
import { LlmClient } from "../src/content/llmClient";
import {
  draftVideoScript,
  formatVideoScriptAsText,
  countSpokenWords,
  MAX_SCRIPT_WORDS,
  VideoScriptTooLongError,
  VideoHookRepeatError,
  MAX_HOOK_REWRITES,
  type VideoScript, hookOpeningProblems, videoCopyProblems, youtubeTitleProblems } from "../src/content/videoScriptWriter";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function scriptResponse(input: VideoScript) {
  return jsonResponse({ content: [{ type: "tool_use", name: "submit_video_script", input }] });
}

const opportunity = {
  title: "Traders confused about trailing drawdown",
  rationale: "High audience relevance, strong Fillbook fit.",
};

describe("draftVideoScript", () => {
  it("returns the structured video script from the tool call", async () => {
    const script: VideoScript = {
      hook: "Trailing drawdown can pull a funded account while winning.",
      script: "Trailing drawdown can pull a funded account while winning. Here's why trailing drawdown catches people off guard...",
      shotList: ["Fillbook UI: example rule alert (demo data)", "Fillbook UI: example drawdown chart (demo data)"],
      youtubeTitle: "Why Your Funded Account Gets Pulled Even When You're Winning",
      youtubeDescription: "Trailing drawdown catches even profitable traders off guard -- here's what to watch for.",
      tiktokCaption: "Trailing drawdown explained in 30 seconds.",
      instagramCaption: "Trailing drawdown explained -- and why it catches even winning trades.",
      hashtags: ["futurestrading", "propfirm"],
      disclosureCta: null,
      youtubeThumbnailConcept: "Bold text 'STILL LOSING?' over a split-screen of a green trade and a drawdown alert.",
    };
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(script));
    const client = new LlmClient("test-key", fetchMock);

    const result = await draftVideoScript(client, opportunity, "voice: concise", "Fillbook tracks prop-firm drawdown rules.");

    expect(result).toEqual(script);
    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((options as { body: string }).body);
    expect(body.tool_choice).toEqual({ type: "auto" }); // Opus rejects a forced tool call
    expect(body.tools[0].name).toBe("submit_video_script");
  });
});

describe("draftVideoScript length guard", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? "Word0" : `word${i}`)).join(" ");
  const withScript = (script: string): VideoScript => ({
    hook: "The hook.",
    script,
    shotList: ["Fillbook UI: example rule alert (demo data)"],
    youtubeTitle: "Title",
    youtubeDescription: "Description.",
    tiktokCaption: "Caption.",
    instagramCaption: "Caption.",
    hashtags: ["futurestrading"],
    disclosureCta: null,
    youtubeThumbnailConcept: "x",
  });
  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
    JSON.parse((fetchMock.mock.calls[call]![1] as { body: string }).body) as { messages: Array<{ content: string }> };

  it("makes a single call when the script is within the cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(withScript(words(MAX_SCRIPT_WORDS))));
    const result = await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(countSpokenWords(result.script)).toBe(MAX_SCRIPT_WORDS);
  });

  it("sends an over-long script back once with its exact word count, and returns the shorter rewrite", async () => {
    const long = words(MAX_SCRIPT_WORDS + 13);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(scriptResponse(withScript(long)))
      .mockResolvedValueOnce(scriptResponse(withScript(words(MAX_SCRIPT_WORDS - 30))));
    const result = await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryText = JSON.stringify(bodyOf(fetchMock, 1));
    expect(retryText).toContain("LENGTH FIX REQUIRED");
    expect(retryText).toContain(`was ${MAX_SCRIPT_WORDS + 13} words`);
    expect(retryText).toContain(long);
    expect(countSpokenWords(result.script)).toBe(MAX_SCRIPT_WORDS - 30);
  });

  it("escalates the rewrite ask on a second miss, and returns the eventually-shorter script", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(scriptResponse(withScript(words(MAX_SCRIPT_WORDS + 13))))
      .mockResolvedValueOnce(scriptResponse(withScript(words(MAX_SCRIPT_WORDS + 4))))
      .mockResolvedValueOnce(scriptResponse(withScript(words(MAX_SCRIPT_WORDS - 30))));
    const result = await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const secondRetryText = JSON.stringify(bodyOf(fetchMock, 2));
    expect(secondRetryText).toContain("LENGTH FIX REQUIRED");
    expect(secondRetryText).toContain(`was ${MAX_SCRIPT_WORDS + 4} words`);
    expect(secondRetryText).toContain("Cut harder this time");
    expect(countSpokenWords(result.script)).toBe(MAX_SCRIPT_WORDS - 30);
  });

  it("throws VideoScriptTooLongError (no fourth attempt) when the script is still over the cap after every rewrite", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(withScript(words(MAX_SCRIPT_WORDS + 15))));
    const attempt = draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    await expect(attempt).rejects.toBeInstanceOf(VideoScriptTooLongError);
    await expect(attempt).rejects.toThrow(new RegExp(`${MAX_SCRIPT_WORDS + 15} words`));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("draftVideoScript hook variety", () => {
  const scriptWith = (hook: string): VideoScript => ({
    hook,
    script: Array.from({ length: 60 }, (_, i) => (i === 0 ? "Word0" : `word${i}`)).join(" "),
    shotList: ["Fillbook UI: example rule alert (demo data)"],
    youtubeTitle: "Title",
    youtubeDescription: "Description.",
    tiktokCaption: "Caption.",
    instagramCaption: "Caption.",
    hashtags: ["futurestrading"],
    disclosureCta: null,
    youtubeThumbnailConcept: "x",
  });
  const recentVideos = [{ hook: "Trailing drawdown never resets after a peak.", title: "Trade review" }];
  const bodyText = (fetchMock: ReturnType<typeof vi.fn>, call: number) => (fetchMock.mock.calls[call]![1] as { body: string }).body;

  it("shows the recent hooks to the writer and makes one call when the hook is fresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(scriptWith("Your loss limit doesn't care that the trade was good.")));
    await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts", recentVideos);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyText(fetchMock, 0)).toContain("RECENT VIDEOS");
    expect(bodyText(fetchMock, 0)).toContain("Trailing drawdown never resets after a peak.");
  });

  it("sends a repeated hook back with the hook it repeats, and returns the fresh rewrite", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(scriptResponse(scriptWith("Trailing drawdown never resets after a new high.")))
      .mockResolvedValueOnce(scriptResponse(scriptWith("Copy-trading five accounts means one mistake gets made five times.")));
    const result = await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts", recentVideos);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyText(fetchMock, 1)).toContain("HOOK REPEATS A RECENT VIDEO");
    expect(bodyText(fetchMock, 1)).toContain("Trailing drawdown never resets after a peak.");
    expect(result.hook).toContain("Copy-trading");
  });

  it("throws VideoHookRepeatError after MAX_HOOK_REWRITES rewrites instead of returning a repeat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(scriptWith("Trailing drawdown never resets after a new high.")));
    const attempt = draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts", recentVideos);
    await expect(attempt).rejects.toBeInstanceOf(VideoHookRepeatError);
    expect(fetchMock).toHaveBeenCalledTimes(1 + MAX_HOOK_REWRITES);
  });

  it("does no hook checking and adds no history section when there are no recent videos", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(scriptWith("Trailing drawdown never resets after a peak.")));
    await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyText(fetchMock, 0)).not.toContain("RECENT VIDEOS (already published");
  });

  it("the system prompt no longer teaches the repeated hook as its own example", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(scriptWith("Something else entirely.")));
    await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    const body = JSON.parse(bodyText(fetchMock, 0)) as { system: unknown };
    expect(JSON.stringify(body.system)).not.toContain("You already know which trade you're about to repeat");
  });
});

describe("countSpokenWords", () => {
  it("counts words, ignoring stray punctuation-only tokens", () => {
    expect(countSpokenWords("You already know -- which trade & you're about to repeat.")).toBe(9);
    expect(countSpokenWords("  ")).toBe(0);
    expect(countSpokenWords("Fillbook imports 107 trades.")).toBe(4);
  });
});

describe("formatVideoScriptAsText", () => {
  it("flattens the script into one readable, numbered text block, with all platform-specific metadata distinct from each other", () => {
    const script: VideoScript = {
      hook: "The hook line.",
      script: "The full spoken script.",
      shotList: ["Fillbook UI: example rule alert (demo data)", "Second shot"],
      youtubeTitle: "The YouTube title.",
      youtubeDescription: "The YouTube description.",
      tiktokCaption: "The TikTok caption.",
      instagramCaption: "The Instagram caption.",
      hashtags: ["futurestrading", "propfirm"],
      disclosureCta: "Example data shown for illustration only.",
      youtubeThumbnailConcept: "Bold text overlay over a split-screen visual.",
    };

    const text = formatVideoScriptAsText(script);

    expect(text).toContain("HOOK: The hook line.");
    expect(text).toContain("1. Fillbook UI: example rule alert (demo data)");
    expect(text).toContain("2. Second shot");
    expect(text).toContain("YOUTUBE TITLE:\nThe YouTube title.");
    expect(text).toContain("YOUTUBE DESCRIPTION:\nThe YouTube description.");
    expect(text).toContain("TIKTOK CAPTION:\nThe TikTok caption.");
    expect(text).toContain("INSTAGRAM CAPTION:\nThe Instagram caption.");
    expect(text).toContain("HASHTAGS: #futurestrading #propfirm");
    expect(text).toContain("DISCLOSURE/CTA: Example data shown for illustration only.");
  });

  it("omits the disclosure/CTA line entirely when null -- never fabricates a filler line", () => {
    const script: VideoScript = {
      hook: "The hook line.",
      script: "The full spoken script.",
      shotList: ["Fillbook UI: example rule alert (demo data)"],
      youtubeTitle: "The YouTube title.",
      youtubeDescription: "The YouTube description.",
      tiktokCaption: "The TikTok caption.",
      instagramCaption: "The Instagram caption.",
      hashtags: ["futurestrading"],
      disclosureCta: null,
      youtubeThumbnailConcept: "Bold text overlay over a split-screen visual.",
    };

    const text = formatVideoScriptAsText(script);

    expect(text).not.toContain("DISCLOSURE/CTA");
  });
});

describe("draftVideoScript capitalization (owner rule 2026-09-20)", () => {
  const package_ = (overrides: Partial<VideoScript> = {}): VideoScript => ({
    hook: "Your loss limit ignores good trades.",
    script: Array.from({ length: 60 }, (_, i) => (i === 0 ? "Word0" : `word${i}`)).join(" "),
    shotList: ["Fillbook UI: example rule alert (demo data)"],
    youtubeTitle: "Why Your Loss Limit Ignores Good Trades",
    youtubeDescription: "A short explainer.",
    tiktokCaption: "Loss limits explained.",
    instagramCaption: "Loss limits explained.",
    hashtags: ["futurestrading"],
    disclosureCta: null,
    youtubeThumbnailConcept: "Bold text over a red chart.",
    ...overrides,
  });
  const bodyText = (fetchMock: ReturnType<typeof vi.fn>, call: number) => (fetchMock.mock.calls[call]![1] as { body: string }).body;

  it("makes one call when every viewer-facing field is properly capitalized", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(package_()));
    await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a lowercase package back once, naming the field, and returns the fixed one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(scriptResponse(package_({ tiktokCaption: "loss limits explained." })))
      .mockResolvedValueOnce(scriptResponse(package_()));
    const result = await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyText(fetchMock, 1)).toContain("COPY FIX REQUIRED");
    expect(bodyText(fetchMock, 1)).toContain("TikTok caption");
    expect(result.tiktokCaption).toBe("Loss limits explained.");
  });

  it("keeps the script after one rewrite instead of failing the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(package_({ youtubeTitle: "why your loss limit ignores good trades" })));
    const result = await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.youtubeTitle).toBe("why your loss limit ignores good trades");
  });

  it("ignores hashtags and a field the model left out", async () => {
    const partial = package_({ hashtags: ["futurestrading", "propfirm"] }) as Partial<VideoScript>;
    delete partial.instagramCaption;
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(partial as VideoScript));
    await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the system prompt states the capitalization rule", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(package_()));
    await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    expect(bodyText(fetchMock, 0)).toContain("proper capitalization and grammar");
  });
});

describe("draftVideoScript em dashes and trial wording (owner direction 2026-09-21)", () => {
  const goodPackage = (overrides: Partial<VideoScript> = {}): VideoScript => ({
    hook: "Your loss limit ignores good trades.",
    script: Array.from({ length: 60 }, (_, i) => (i === 0 ? "Word0" : `word${i}`)).join(" "),
    shotList: ["Fillbook UI: example rule alert (demo data)"],
    youtubeTitle: "Why Your Loss Limit Ignores Good Trades",
    youtubeDescription: "A short explainer. See fillbookhq.com.",
    tiktokCaption: "Loss limits explained. Link in bio.",
    instagramCaption: "Loss limits explained. Link in bio.",
    hashtags: ["futurestrading"],
    disclosureCta: null,
    youtubeThumbnailConcept: "Bold text over a red chart.",
    ...overrides,
  });
  const bodyText = (fetchMock: ReturnType<typeof vi.fn>, call: number) => (fetchMock.mock.calls[call]![1] as { body: string }).body;

  it("catches an em dash in the copy and names the field", async () => {
    // Taken from the 2026-09-21 render's YouTube description and TikTok caption.
    const bad = goodPackage({
      youtubeDescription: "Your plan isn't just words in a doc\u2014it's structure that keeps you funded. See fillbookhq.com.",
      tiktokCaption: "Your trading plan needs enforcement, not just good intentions. Max daily loss, position sizing rules\u2014Fillbook builds the guardrails. Link in bio.",
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(scriptResponse(bad)).mockResolvedValueOnce(scriptResponse(goodPackage()));

    const result = await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = bodyText(fetchMock, 1);
    expect(retry).toContain("COPY FIX REQUIRED");
    expect(retry).toContain("YouTube description");
    expect(retry).toContain("TikTok caption");
    expect(retry).toContain("em or en dash");
    expect(result).toEqual(goodPackage());
  });

  it("names every problem in one rewrite, not one call per problem", async () => {
    const bad = goodPackage({ youtubeTitle: "why your loss limit ignores good trades", tiktokCaption: "Loss limits\u2014explained. Link in bio." });
    const fetchMock = vi.fn().mockResolvedValueOnce(scriptResponse(bad)).mockResolvedValueOnce(scriptResponse(goodPackage()));
    await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = bodyText(fetchMock, 1);
    expect(retry).toContain("YouTube title");
    expect(retry).toContain("lowercase");
    expect(retry).toContain("dash");
  });

  it("makes one call for a clean package", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(goodPackage()));
    await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT treat 'free trial' as a problem: it is Fillbook's own accurate wording (14-day free trial, no card required)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      scriptResponse(goodPackage({ youtubeDescription: "Start your 14-day free trial at fillbookhq.com. No card required." })),
    );
    const result = await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.youtubeDescription).toContain("free trial");
  });

  it("keeps the script after one rewrite instead of failing the request", async () => {
    const stubborn = goodPackage({ youtubeDescription: "A plan\u2014written down. See fillbookhq.com." });
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(stubborn));
    const result = await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.youtubeDescription).toContain("\u2014");
  });

  it("does not flag the legitimate caption wording 'link in bio'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(goodPackage({ tiktokCaption: "Loss limits explained. Link in bio." })));
    await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the system prompt bans dashes and ties any trial claim to the verified knowledge instead of banning 'free trial'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(scriptResponse(goodPackage()));
    await draftVideoScript(new LlmClient("k", fetchMock), opportunity, "voice", "facts");
    const system = (JSON.parse(bodyText(fetchMock, 0)) as { system: string | Array<{ text: string }> }).system;
    const prompt = typeof system === "string" ? system : system.map((block) => block.text).join(" ");
    expect(prompt).toContain("No em dashes or en dashes anywhere");
    expect(prompt).toContain("Any trial claim must match the verified knowledge exactly");
    expect(prompt).toContain("14-day free trial, no card required");
    expect(prompt).not.toContain('Never say "free trial"');
  });
});

describe("hookOpeningProblems (first-second retention rules, 2026-09-21)", () => {
  const base = (over: Partial<VideoScript>): VideoScript => ({
    hook: "Trailing drawdown never resets after a peak.",
    script: "x", shotList: ["Fillbook UI: example rule alert (demo data)"],
    youtubeTitle: "t", youtubeDescription: "d", tiktokCaption: "c", instagramCaption: "i",
    hashtags: [], disclosureCta: null, youtubeThumbnailConcept: "x",
    ...over,
  });

  it("passes a short, rule-first hook with a concrete first shot", () => {
    expect(hookOpeningProblems(base({}))).toEqual([]);
  });

  it("flags a first sentence longer than 10 words, the shape of every video that lost viewers at 0:01", () => {
    const p = hookOpeningProblems(base({ hook: "You pass the eval because the rules are tight and the account stays." }));
    expect(p.some((x) => x.field === "hook" && x.reason.includes("10 or fewer"))).toBe(true);
  });

  it("only counts the first sentence, so a short hook followed by a payoff sentence is fine", () => {
    expect(hookOpeningProblems(base({ hook: "Daily loss limits reset. Trailing drawdown does not, and most funded traders only watch one." }))).toEqual([]);
  });

  it("flags lead-in and generic-observation openers", () => {
    for (const hook of ["Most traders never review their wins.", "Did you know drawdown trails your peak?", "Imagine blowing an account on a rule.", "You already know which rule you will break."]) {
      expect(hookOpeningProblems(base({ hook })).some((x) => x.reason.includes("lead-in")), hook).toBe(true);
    }
  });

  it("flags a first shot that is a plain text card or generic stock scene", () => {
    for (const shot of ["Text card: the hook line", "Trader at desk looking frustrated", "First shot"]) {
      expect(hookOpeningProblems(base({ shotList: [shot] })).some((x) => x.field === "first shot"), shot).toBe(true);
    }
  });

  it("accepts a text card that carries a specific rule or number", () => {
    expect(hookOpeningProblems(base({ shotList: ["Text card: Trailing drawdown, big white text"] }))).toEqual([]);
  });

  it("feeds into videoCopyProblems so the existing one-rewrite retry handles it", () => {
    const problems = videoCopyProblems(base({ hook: "Did you know your drawdown trails the peak of your balance today?" }));
    expect(problems.some((x) => x.reason.includes("lead-in"))).toBe(true);
  });
});

describe("youtubeTitleProblems (search-first titles, 2026-09-21)", () => {
  const withTitle = (youtubeTitle: string): VideoScript => ({
    hook: "Trailing drawdown never resets after a peak.", script: "x", shotList: ["Fillbook UI: example rule alert (demo data)"],
    youtubeTitle, youtubeDescription: "d", tiktokCaption: "c", instagramCaption: "i", hashtags: [], disclosureCta: null, youtubeThumbnailConcept: "x",
  });

  it("passes a search-style rule explainer", () => {
    expect(youtubeTitleProblems(withTitle("Static vs Trailing Drawdown: What Funded Traders Need to Know"))).toEqual([]);
    expect(youtubeTitleProblems(withTitle("Funded Trader Drawdown Rules Explained"))).toEqual([]);
  });

  it("flags a hashtag in the title", () => {
    expect(youtubeTitleProblems(withTitle("Funded Trader Drawdown Rules Explained #shorts")).map((p) => p.reason)).toEqual([
      "contains a hashtag; keep hashtags out of the title",
    ]);
  });

  it("flags a first-person title, like the one with the lowest watch rate", () => {
    expect(youtubeTitleProblems(withTitle("I Blew a Funded Account Over a Number I Didn't Track")).some((p) => p.reason.includes("first person"))).toBe(true);
    expect(youtubeTitleProblems(withTitle("My Trailing Drawdown Mistake")).some((p) => p.reason.includes("first person"))).toBe(true);
  });

  it("flags emoji, ALL CAPS words and titles over 70 characters", () => {
    expect(youtubeTitleProblems(withTitle("How to Stop Overtrading: Avoid the Midday Leak \u{1F4C9}")).some((p) => p.reason.includes("emoji"))).toBe(true);
    expect(youtubeTitleProblems(withTitle("Blew an Account Over ONE Number")).some((p) => p.reason.includes("ALL CAPS"))).toBe(true);
    expect(youtubeTitleProblems(withTitle("A".repeat(10) + " trailing drawdown explained for funded traders who want the full picture here")).some((p) => p.reason.includes("under 70"))).toBe(true);
  });

  it("does not flag short acronyms of three letters or fewer, or an empty title", () => {
    expect(youtubeTitleProblems(withTitle("How Apex and NQ Drawdown Rules Work"))).toEqual([]);
    expect(youtubeTitleProblems(withTitle(""))).toEqual([]);
  });

  it("feeds into videoCopyProblems so the existing one-rewrite retry handles it", () => {
    expect(videoCopyProblems(withTitle("I Blew a Funded Account")).some((p) => p.field === "YouTube title")).toBe(true);
  });
});

describe("youtubeTitleProblems acronym handling", () => {
  const withTitle = (youtubeTitle: string) => ({ hook: "Trailing drawdown never resets after a peak.", script: "x", shotList: ["Fillbook UI: example rule alert (demo data)"], youtubeTitle, youtubeDescription: "d", tiktokCaption: "c", instagramCaption: "i", hashtags: [], disclosureCta: null, youtubeThumbnailConcept: "x" }) as VideoScript;
  it("allows real trading acronyms but still flags shouting like ONE", () => {
    expect(youtubeTitleProblems(withTitle("MNQ Trailing Drawdown Rules Explained"))).toEqual([]);
    expect(youtubeTitleProblems(withTitle("Blew an Account Over ONE Number")).some((p) => p.reason.includes("ONE"))).toBe(true);
  });
});
