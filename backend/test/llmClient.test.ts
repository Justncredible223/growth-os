import { describe, it, expect, vi } from "vitest";
import { LlmClient, LlmClientError, DEFAULT_RETRY, MODEL_HAIKU, createLlmClient, type RetryOptions } from "../src/content/llmClient";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("LlmClient", () => {
  it("sends the tool-forcing request and returns the tool call's input", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [{ type: "tool_use", name: "submit_verdict", input: { pass: true, score: 0.9 } }],
      }),
    );
    const client = new LlmClient("test-key", fetchMock);

    const result = await client.callTool(
      "system prompt",
      "user message",
      "submit_verdict",
      { type: "object", properties: {} },
      undefined,
      undefined,
      MODEL_HAIKU,
    );

    expect(result).toEqual({ pass: true, score: 0.9 });
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((options.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    const body = JSON.parse(options.body as string);
    expect(body.tool_choice).toEqual({ type: "tool", name: "submit_verdict" });
    expect(body.system).toBe("system prompt");
  });

  it("defaults to Opus and retries once on the previous model when the API answers 404 for it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { type: "not_found_error" } }, false, 404))
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: "tool_use", name: "t", input: { ok: true } }] }));
    const client = new LlmClient("test-key", fetchMock);

    await expect(client.callTool("sys", "user", "t", {})).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).model).toBe("claude-opus-5-5");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string).model).toBe("claude-sonnet-4-5-20250929");
  });

  it("Opus is not forced into a tool call (the API rejects that): tool_choice auto, an instruction, low effort, a roomy token cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "tool_use", name: "t", input: { ok: true } }] }));
    const client = new LlmClient("test-key", fetchMock);

    await client.callTool("sys prompt", "user", "t", {}, undefined, 500);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.system).toContain("sys prompt");
    expect(body.system).toContain("calling the t tool");
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.max_tokens).toBe(4096);
  });

  it("keeps the cached system block first and puts the Opus instruction after it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "tool_use", name: "t", input: {} }] }));
    const client = new LlmClient("test-key", fetchMock);

    await client.callTool("sys prompt", "user", "t", {}, undefined, 500, undefined, true);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.system[0]).toEqual({ type: "text", text: "sys prompt", cache_control: { type: "ephemeral" } });
    expect(body.system[1].text).toContain("calling the t tool");
  });

  it("other models are still forced into the tool call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "tool_use", name: "t", input: {} }] }));
    const client = new LlmClient("test-key", fetchMock);

    await client.callTool("sys", "user", "t", {}, undefined, 500, MODEL_HAIKU);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.tool_choice).toEqual({ type: "tool", name: "t" });
    expect(body.max_tokens).toBe(500);
    expect(body.output_config).toBeUndefined();
  });

  it("falls back to the previous model when the API answers 400 'not supported for this model'", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "tool_choice: type \"tool\" and \"any\" are not supported for this model." } }, false, 400))
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: "tool_use", name: "t", input: { ok: true } }] }));
    const client = new LlmClient("test-key", fetchMock);

    await expect(client.callTool("sys", "user", "t", {})).resolves.toEqual({ ok: true });

    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string).model).toBe("claude-sonnet-4-5-20250929");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string).tool_choice).toEqual({ type: "tool", name: "t" });
  });

  it("retries once on the previous model, forced, when Opus answers without the tool call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: "text", text: "no tool call" }] }))
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: "tool_use", name: "t", input: { ok: true } }] }));
    const client = new LlmClient("test-key", fetchMock);

    await expect(client.callTool("sys", "user", "t", {})).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string).model).toBe("claude-sonnet-4-5-20250929");
  });

  it("does not fall back twice: a second 404 is an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, false, 404));
    const client = new LlmClient("test-key", fetchMock);

    await expect(client.callTool("sys", "user", "t", {})).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws LlmClientError with the response body on a failed request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "rate limited" }, false, 429));
    const client = new LlmClient("test-key", fetchMock);

    await expect(client.callTool("sys", "user", "tool", {})).rejects.toThrow(/HTTP 429/);
  });

  it("throws LlmClientError when no matching tool call is in the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "no tool call" }] }));
    const client = new LlmClient("test-key", fetchMock);

    await expect(client.callTool("sys", "user", "submit_verdict", {})).rejects.toThrow(LlmClientError);
  });

  it("fires onUsage with real token counts from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "tool_use", name: "submit_verdict", input: { pass: true } }],
        usage: { input_tokens: 42, output_tokens: 7 },
      }),
    );
    const onUsage = vi.fn();
    const client = new LlmClient("test-key", fetchMock, undefined, onUsage);

    await client.callTool("sys", "user", "submit_verdict", {});

    expect(onUsage).toHaveBeenCalledWith({
      model: "claude-sonnet-4-5-20250929",
      inputTokens: 42,
      outputTokens: 7,
    });
  });

  describe("retrying transient failures", () => {
    const ok = () => jsonResponse({ content: [{ type: "tool_use", name: "t", input: { pass: true } }] });
    const fail = (status: number, headers: Record<string, string> = {}) =>
      ({ ...jsonResponse({ error: "blip" }, false, status), headers: new Headers(headers) }) as Response;
    const retrying = (sleep = vi.fn(async () => {})): RetryOptions => ({ ...DEFAULT_RETRY, sleep });

    it("retries a 503 and returns the next successful answer", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(ok());
      const sleep = vi.fn(async () => {});
      const client = new LlmClient("k", fetchMock, undefined, undefined, retrying(sleep));

      await expect(client.callTool("s", "u", "t", {})).resolves.toEqual({ pass: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(1_000);
    });

    it.each([429, 500, 502, 504, 529])("retries HTTP %i", async (status) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(fail(status)).mockResolvedValueOnce(ok());
      const client = new LlmClient("k", fetchMock, undefined, undefined, retrying());
      await expect(client.callTool("s", "u", "t", {})).resolves.toEqual({ pass: true });
    });

    it("gives up after two retries with the last error, backing off 1s then 3s", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fail(503));
      const sleep = vi.fn(async () => {});
      const client = new LlmClient("k", fetchMock, undefined, undefined, retrying(sleep));

      await expect(client.callTool("s", "u", "t", {})).rejects.toThrow(/HTTP 503/);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[1_000], [3_000]]);
    });

    it("does not retry a client error such as 400 or 401", async () => {
      for (const status of [400, 401]) {
        const fetchMock = vi.fn().mockResolvedValue(fail(status));
        const client = new LlmClient("k", fetchMock, undefined, undefined, retrying());
        await expect(client.callTool("s", "u", "t", {}, undefined, undefined, "claude-sonnet-4-5-20250929")).rejects.toThrow(new RegExp(`HTTP ${status}`));
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    });

    it("honours Retry-After but never waits longer than the cap", async () => {
      const sleep = vi.fn(async () => {});
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(fail(429, { "retry-after": "2" }))
        .mockResolvedValueOnce(fail(429, { "retry-after": "60" }))
        .mockResolvedValueOnce(ok());
      const client = new LlmClient("k", fetchMock, undefined, undefined, retrying(sleep));

      await client.callTool("s", "u", "t", {});
      expect(sleep.mock.calls).toEqual([[2_000], [5_000]]);
    });

    it("retries a network error but not a timeout", async () => {
      const network = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok());
      await expect(new LlmClient("k", network, undefined, undefined, retrying()).callTool("s", "u", "t", {}))
        .resolves.toEqual({ pass: true });

      const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
      const hung = vi.fn().mockRejectedValue(abort);
      await expect(new LlmClient("k", hung, undefined, undefined, retrying()).callTool("s", "u", "t", {}))
        .rejects.toThrow(/timed out/);
      expect(hung).toHaveBeenCalledTimes(1);
    });

    it("is off for a directly constructed client and on for createLlmClient", async () => {
      const fetchMock = vi.fn().mockResolvedValue(fail(503));
      await expect(new LlmClient("k", fetchMock).callTool("s", "u", "t", {})).rejects.toThrow(/HTTP 503/);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const client = createLlmClient({ ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv);
      expect((client as unknown as { retry: RetryOptions }).retry).toBe(DEFAULT_RETRY);
    });
  });
});
