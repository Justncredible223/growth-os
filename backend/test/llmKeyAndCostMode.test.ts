import { describe, expect, it, vi, beforeEach } from "vitest";
import { createLlmClient, LlmClientError } from "../src/content/llmClient.js";
import { llmKeySource, logLlmKeySourceOnce, resetLlmKeyLogForTests, resolveAnthropicKey } from "../src/content/llmKey.js";

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
