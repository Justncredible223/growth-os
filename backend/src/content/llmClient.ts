import { logLlmKeySourceOnce, resolveAnthropicKey } from "./llmKey.js";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
export const MODEL_SONNET = "claude-sonnet-4-5-20250929";
/** Writers (drafts, scripts, replies) and the review agents: the strongest model, for better drafts and stricter checks. */
export const MODEL_OPUS = "claude-opus-5-5";
/** Cheap and fast: relevance prechecks and the live host's quick lines. */
export const MODEL_HAIKU = "claude-haiku-5-5";

/** Default model for content generation (drafts, scripts). */
const MODEL = MODEL_OPUS;

/**
 * Where a call goes when the API cannot serve its model (404: the key or workspace cannot use it; 400 "not supported
 * for this model": a request option the model rejects) or the model answers without the tool call: the model that ran
 * before this upgrade, so a model problem degrades quality instead of stopping every draft.
 */
const FALLBACK_MODELS: Record<string, string> = {
  [MODEL_OPUS]: MODEL_SONNET,
  [MODEL_HAIKU]: "claude-haiku-4-5-20251001",
};

/**
 * Models that answer HTTP 400 to a forced tool call (tool_choice type "tool" or "any"). Opus 5.5 is one: it takes
 * tool_choice "auto" plus an instruction naming the tool. It also always thinks, and thinking tokens count against
 * max_tokens, so these calls run at low effort with a larger token cap (billing is by tokens used, not by the cap).
 */
const NO_FORCED_TOOL_MODELS = new Set<string>([MODEL_OPUS]);
const NO_FORCED_TOOL_MIN_MAX_TOKENS = 4096;

/**
 * Previously there was NO per-call timeout at all -- a single hung request
 * could consume an entire Vercel invocation's 60s maxDuration with no way
 * for the caller to bound or recover from it. 20s is conservative against
 * real Claude Messages API latency for a 1024-max-token tool-forced call
 * (typically single-digit seconds), while still leaving room for two
 * sequential round-trips (draft, then the parallel review batch) plus DB
 * writes inside one 60s invocation. Configurable via env for tuning
 * without a code change.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_CALL_TIMEOUT_MS) || 20_000;

export class LlmClientError extends Error {}

/**
 * Thrown BEFORE any network call when the daily LLM budget (src/cost/llmBudget.ts) is used up. It is a clean
 * "skip", not a failure: callers that run on a schedule turn it into a "skipped -- daily LLM budget reached" line.
 */
export class LlmBudgetError extends LlmClientError {
  constructor(message = "skipped -- daily LLM budget reached") {
    super(message);
    this.name = "LlmBudgetError";
  }
}

export function isLlmBudgetError(err: unknown): err is LlmBudgetError {
  return err instanceof LlmBudgetError || (err instanceof Error && err.name === "LlmBudgetError");
}

/** Consulted before every model call; throws LlmBudgetError when the call must not be made. */
export interface LlmBudgetGuard {
  check(): Promise<void>;
}

/**
 * Retry policy for transient Claude API failures. On 2026-09-29 every
 * Campaign Run for six minutes died on a single "HTTP 503 -- credential
 * validation failed" from one review-agent call, a blip the API recovered
 * from on its own; one retry a second later would have carried the run.
 *
 * Only statuses that mean "try again" are retried (429 rate limit, 5xx,
 * 529 overloaded) plus network errors. Timeouts are NOT retried: callers run
 * inside a 60s Vercel invocation (see DEFAULT_TIMEOUT_MS), and a second 20s
 * wait on a hung request would blow that budget. Delays stay short for the
 * same reason; a server Retry-After is honoured but capped.
 */
export interface RetryOptions {
  /** Extra attempts after the first; 0 disables retrying. */
  retries: number;
  /** Delay before retry n (1-based), in ms. */
  delaysMs: number[];
  /** Upper bound on any single wait, including a server Retry-After. */
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

export const NO_RETRY: RetryOptions = { retries: 0, delaysMs: [], maxDelayMs: 0, sleep: async () => {} };

export const DEFAULT_RETRY: RetryOptions = {
  retries: 2,
  delaysMs: [1_000, 3_000],
  maxDelayMs: 5_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function retryDelayMs(retry: RetryOptions, attempt: number, retryAfter: string | null): number {
  const fromHeader = retryAfter !== null && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : null;
  const planned = retry.delaysMs[Math.min(attempt, retry.delaysMs.length) - 1] ?? 0;
  return Math.min(fromHeader ?? planned, retry.maxDelayMs);
}

export interface ToolCallResult<T> {
  toolName: string;
  input: T;
}

export interface LlmUsage {
  /** The job that made the call (e.g. "engagement-draft"); set by the client from its options. */
  step?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache on this call (billed at 1.25x input rate). */
  cacheCreationInputTokens?: number;
  /** Tokens read from the prompt cache on this call (billed at 0.1x input rate). */
  cacheReadInputTokens?: number;
}

/**
 * Thin wrapper around the Claude Messages API. Forces the model to
 * respond via a single tool call rather than free text, so review agents
 * get a reliably-structured verdict instead of parsing prose. Injectable
 * fetchImpl for tests, same pattern as XSignalAdapter/SearchConsoleAdapter.
 * Optional onUsage fires after every successful call with real token
 * counts from the response -- Cost Intelligence's one data source, not a
 * separate estimate.
 */
export class LlmClient {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
    private workspaceId?: string,
    // May return a promise: callTool awaits it, so a cost row is written before the invocation can be frozen.
    private onUsage?: (usage: LlmUsage) => unknown,
    // Off unless asked for, so a test's failing fetch mock fails once and
    // fast; createLlmClient (every production caller) turns it on.
    private retry: RetryOptions = NO_RETRY,
    private options: { step?: string; guard?: LlmBudgetGuard } = {},
  ) {}

  /**
   * @param cacheSystemPrompt - When true, marks the system prompt with
   *   cache_control so Anthropic caches it for 5 minutes. Subsequent calls
   *   with the same system prompt within that window pay ~10% of normal
   *   input-token cost instead of 100%. Use for calls with large, stable
   *   system prompts that repeat within the same Vercel invocation (e.g.
   *   the 9 review agents on a 2-attempt pipeline run).
   */
  async callTool<T>(
    systemPrompt: string,
    userMessage: string,
    toolName: string,
    toolSchema: object,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTokens = 1024,
    model = MODEL,
    cacheSystemPrompt = false,
  ): Promise<T> {
    // Budget check first: no tokens are spent (and nothing is recorded) when today's ceiling is already reached.
    await this.options.guard?.check();

    const systemValue = cacheSystemPrompt
      ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
      : systemPrompt;

    const bodyFor = (forModel: string) => {
      const tools = [{ name: toolName, description: `Submit your ${toolName} result`, input_schema: toolSchema }];
      if (!NO_FORCED_TOOL_MODELS.has(forModel)) {
        return JSON.stringify({
          model: forModel,
          max_tokens: maxTokens,
          system: systemValue,
          messages: [{ role: "user", content: userMessage }],
          tools,
          tool_choice: { type: "tool", name: toolName },
        });
      }
      const instruction = `Respond only by calling the ${toolName} tool exactly once. Do not write any other text.`;
      return JSON.stringify({
        model: forModel,
        max_tokens: Math.max(maxTokens, NO_FORCED_TOOL_MIN_MAX_TOKENS),
        // The instruction goes after the cached block, so the cached system prompt stays byte-identical.
        system: Array.isArray(systemValue)
          ? [...systemValue, { type: "text", text: instruction }]
          : `${systemValue}\n\n${instruction}`,
        messages: [{ role: "user", content: userMessage }],
        tools,
        tool_choice: { type: "auto" },
        output_config: { effort: "low" },
      });
    };
    let requestBody = bodyFor(model);
    let fellBack = false;

    let res: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.post(requestBody, timeoutMs);
      } catch (err) {
        // fetch rejects with a TypeError on a network failure (DNS, reset);
        // a timeout arrives here as an LlmClientError and is not retried.
        if (err instanceof TypeError && attempt < this.retry.retries) {
          await this.retry.sleep(retryDelayMs(this.retry, attempt + 1, null));
          continue;
        }
        throw err;
      }
      if (res.ok) break;

      const body = await res.text();
      const fallbackModel = FALLBACK_MODELS[model];
      // Any 400 or 404 on a model with a fallback: a request option the new model refuses must never stop every draft.
      const modelRejected = res.status === 404 || res.status === 400;
      if (modelRejected && fallbackModel && !fellBack) {
        fellBack = true;
        console.warn(`LLM model ${model} rejected (HTTP ${res.status}); falling back to ${fallbackModel}`);
        requestBody = bodyFor(fallbackModel);
        continue;
      }
      if (RETRYABLE_STATUSES.has(res.status) && attempt < this.retry.retries) {
        await this.retry.sleep(retryDelayMs(this.retry, attempt + 1, res.headers?.get("retry-after") ?? null));
        continue;
      }
      throw new LlmClientError(`Claude API request failed: HTTP ${res.status} -- ${body}`);
    }

    const json = (await res.json()) as {
      model: string;
      content: Array<{ type: string; name?: string; input?: unknown }>;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

    if (json.usage && this.onUsage) {
      // Awaited and shielded: a failed cost write must never lose the model's answer, and awaiting it means a
      // serverless invocation cannot end before the row is written (the old fire-and-forget lost rows).
      try {
        await this.onUsage({
          step: this.options.step,
          model: json.model,
          inputTokens: json.usage.input_tokens,
          outputTokens: json.usage.output_tokens,
          cacheCreationInputTokens: json.usage.cache_creation_input_tokens,
          cacheReadInputTokens: json.usage.cache_read_input_tokens,
        });
      } catch {
        // Cost visibility is best-effort here; recordCostEvent already swallows its own failures.
      }
    }

    const toolUse = json.content.find((block) => block.type === "tool_use" && block.name === toolName);
    if (!toolUse && NO_FORCED_TOOL_MODELS.has(model) && !fellBack && FALLBACK_MODELS[model]) {
      // The model was only asked (not forced) to call the tool and answered without it: one retry on the forced path.
      console.warn(`LLM model ${model} answered without the ${toolName} tool call; retrying on ${FALLBACK_MODELS[model]}`);
      return this.callTool<T>(systemPrompt, userMessage, toolName, toolSchema, timeoutMs, maxTokens, FALLBACK_MODELS[model], cacheSystemPrompt);
    }
    if (!toolUse) {
      throw new LlmClientError(`Claude API response did not include a ${toolName} tool call`);
    }
    return toolUse.input as T;
  }

  /** One request with its own timeout; a timeout becomes an LlmClientError. */
  private async post(body: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": "prompt-caching-2024-07-31",
          ...(this.workspaceId ? { "anthropic-workspace-id": this.workspaceId } : {}),
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmClientError(`Claude API request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createLlmClient(
  env: NodeJS.ProcessEnv = process.env,
  onUsage?: (usage: LlmUsage) => unknown,
  options: { step?: string; guard?: LlmBudgetGuard } = {},
): LlmClient {
  const { apiKey, source } = resolveAnthropicKey(env);
  if (!apiKey) {
    throw new LlmClientError(
      "GROWTH_OS_ANTHROPIC_API_KEY (or the transitional fallback ANTHROPIC_API_KEY) is not set in the environment. Add it to backend/.env.local for local " +
        "dev and to Vercel's project env vars for production -- never commit it.",
    );
  }
  logLlmKeySourceOnce(source);
  // Identity-linked keys (the default type Console now issues) require the
  // workspace they act in to be named explicitly on every request.
  return new LlmClient(apiKey, fetch, env.ANTHROPIC_WORKSPACE_ID, onUsage, DEFAULT_RETRY, options);
}
