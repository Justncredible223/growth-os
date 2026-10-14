import { describe, expect, it, vi, beforeEach } from "vitest";
import { createLlmClient, LlmClientError } from "../src/content/llmClient.js";
import { llmKeySource, logLlmKeySourceOnce, resetLlmKeyLogForTests, resolveAnthropicKey } from "../src/content/llmKey.js";
import { parseCostMode, useFastModel } from "../src/liveHost/liveHostModels.js";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("anthropic key source", () => {
  beforeEach(() => resetLlmKeyLogForTests());
  it("dedicated var wins", () => {
    expect(resolveAnthropicKey(env({ GROWTH_OS_ANTHROPIC_API_KEY: "a", ANTHROPIC_API_KEY: "b" }))).toEqual({ apiKey: "a", source: "dedicated" });
  });
  it("falls back and reports shared-fallback", () => {
    expect(llmKeySource(env({ ANTHROPIC_API_KEY: "b" }))).toBe("shared-fallback");
    expect(() => createLlmClient(env({ ANTHROPIC_API_KEY: "b" }))).not.toThrow();
  });
  it("missing reports missing and fails closed", () => {
    expect(llmKeySource(env({}))).toBe("missing");
    expect(() => createLlmClient(env({}))).toThrow(LlmClientError);
  });
  it("logs at most once and never a value", () => {
    const log = vi.fn();
    logLlmKeySourceOnce("shared-fallback", log);
    logLlmKeySourceOnce("shared-fallback", log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("falling back to ANTHROPIC_API_KEY, set GROWTH_OS_ANTHROPIC_API_KEY");
    resetLlmKeyLogForTests();
    const log2 = vi.fn();
    logLlmKeySourceOnce("dedicated", log2);
    expect(log2.mock.calls[0]![0]).toBe("LLM key: using GROWTH_OS_ANTHROPIC_API_KEY");
  });
});

describe("live host cost mode default", () => {
  it("defaults to balanced", () => {
    expect(parseCostMode(undefined, env({}))).toBe("balanced");
    expect(parseCostMode("junk", env({}))).toBe("balanced");
  });
  it("env override resolves to quality, explicit value wins", () => {
    expect(parseCostMode(undefined, env({ LIVE_HOST_COST_MODE: "quality" }))).toBe("quality");
    expect(parseCostMode(undefined, env({ LIVE_HOST_COST: "quality" }))).toBe("quality");
    expect(parseCostMode("low", env({ LIVE_HOST_COST_MODE: "quality" }))).toBe("low");
  });
  it("fallbacks unchanged", () => {
    const base = { segmentId: "joke", joinWelcome: false, duoReply: false, spendFraction: 0 };
    expect(useFastModel({ ...base, mode: "balanced" })).toBe(true);
    expect(useFastModel({ ...base, mode: "quality" })).toBe(false);
    expect(useFastModel({ ...base, mode: "quality", joinWelcome: true })).toBe(true);
    expect(useFastModel({ ...base, mode: "quality", duoReply: true })).toBe(true);
    expect(useFastModel({ ...base, mode: "quality", spendFraction: 0.6 })).toBe(true);
    expect(useFastModel({ ...base, mode: "quality", segmentId: "desk_lesson", spendFraction: 0.6 })).toBe(false);
    expect(useFastModel({ ...base, mode: "quality", segmentId: "desk_lesson", spendFraction: 0.85 })).toBe(true);
  });
});
