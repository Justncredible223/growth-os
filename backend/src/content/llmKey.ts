/**
 * Which environment variable supplies Growth OS's Anthropic key. Growth OS reads its own dedicated variable first so
 * it can be rotated independently of other apps; ANTHROPIC_API_KEY is only a transitional fallback. Only the NAME of
 * the variable is ever exposed (logs, health, cost summary), never a value.
 */
export type LlmKeySource = "dedicated" | "shared-fallback" | "missing";

export const DEDICATED_KEY_VAR = "GROWTH_OS_ANTHROPIC_API_KEY";
export const SHARED_KEY_VAR = "ANTHROPIC_API_KEY";

export function resolveAnthropicKey(env: NodeJS.ProcessEnv = process.env): { apiKey: string | undefined; source: LlmKeySource } {
  if (env[DEDICATED_KEY_VAR]) return { apiKey: env[DEDICATED_KEY_VAR], source: "dedicated" };
  if (env[SHARED_KEY_VAR]) return { apiKey: env[SHARED_KEY_VAR], source: "shared-fallback" };
  return { apiKey: undefined, source: "missing" };
}

export function llmKeySource(env: NodeJS.ProcessEnv = process.env): LlmKeySource {
  return resolveAnthropicKey(env).source;
}

let logged = false;
/** Logs which variable name is in use, at most once per cold start. Never prints a value. */
export function logLlmKeySourceOnce(source: LlmKeySource, log: (message: string) => void = console.log): void {
  if (logged || source === "missing") return;
  logged = true;
  log(source === "dedicated" ? `LLM key: using ${DEDICATED_KEY_VAR}` : `LLM key: falling back to ${SHARED_KEY_VAR}, set ${DEDICATED_KEY_VAR}`);
}

/** Test hook. */
export function resetLlmKeyLogForTests(): void {
  logged = false;
}
