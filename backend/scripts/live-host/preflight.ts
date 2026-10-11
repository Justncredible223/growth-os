#!/usr/bin/env node
/**
 * Before going live:
 *
 *   npm run live-host:preflight
 *
 * Checks everything the stream depends on and prints PASS / WARN / FAIL for each, so a problem is found at the
 * desk and not in front of an audience. It changes nothing: it does not flip the switch, start the stream or
 * speak. Secrets are never printed.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ObsClient } from "./obsClient.js";
import { OBS_SCENE_NAME, OBS_SOURCE_NAME, STAGE_HEIGHT, STAGE_WIDTH } from "./setupObs.js";

export type CheckStatus = "PASS" | "WARN" | "FAIL";
export interface CheckResult {
  status: CheckStatus;
  name: string;
  detail: string;
}

const check = (status: CheckStatus, name: string, detail: string): CheckResult => ({ status, name, detail });

/** The environment the worker needs. Pure, so it can be tested without a network. */
export function checkEnvironment(env: NodeJS.ProcessEnv): CheckResult[] {
  const results: CheckResult[] = [];
  const token = env.GROWTH_OS_AUTOMATION_TOKEN ?? "";
  results.push(token.length >= 32 ? check("PASS", "Automation token", `set (${token.length} characters)`) : check("FAIL", "Automation token", "GROWTH_OS_AUTOMATION_TOKEN is missing or shorter than 32 characters"));
  results.push(env.GROWTH_OS_PROTECTION_BYPASS_SECRET ? check("PASS", "Protection bypass secret", "set") : check("WARN", "Protection bypass secret", "not set; fine only if the deployment has no protection on this URL"));
  const obsOff = env.OBS_WEBSOCKET_URL === "off";
  if (!obsOff) results.push(env.OBS_WEBSOCKET_PASSWORD ? check("PASS", "OBS password", "set") : check("WARN", "OBS password", "OBS_WEBSOCKET_PASSWORD is empty; fine only if OBS has no WebSocket password"));
  const mode = (env.LIVE_HOST_MODE ?? "").toLowerCase();
  results.push(mode === "duo" ? check("PASS", "Mode", "duo (co-host console, Tilt speaks only when addressed)") : check("WARN", "Mode", "solo: Tilt will run segments by himself; set LIVE_HOST_MODE=duo for TikTok"));
  const platform = (env.LIVE_HOST_PLATFORM ?? "").toLowerCase();
  results.push(platform ? check("PASS", "Platform", platform) : check("WARN", "Platform", "LIVE_HOST_PLATFORM not set; he will point to the bio instead of saying the website"));
  return results;
}

/** Turns the Growth OS status payload into checks. Pure. */
export function checkGrowthOsStatus(status: {
  configured?: boolean;
  systemPaused?: boolean;
  budgetReached?: boolean;
  todaySpendUsd?: number;
  settings?: { desiredState?: string; dailyBudgetUsd?: number };
  session?: { workerOnline?: boolean } | null;
}): CheckResult[] {
  const results: CheckResult[] = [];
  results.push(status.configured === false ? check("FAIL", "Live Host tables", "not set up: apply migration 0049_live_host.sql") : check("PASS", "Live Host tables", "present"));
  results.push(status.systemPaused ? check("FAIL", "System pause", "Growth OS is paused; Tilt will not speak") : check("PASS", "System pause", "not paused"));
  const budget = status.settings?.dailyBudgetUsd ?? 0;
  const spent = status.todaySpendUsd ?? 0;
  results.push(
    status.budgetReached
      ? check("FAIL", "Daily budget", `reached ($${spent.toFixed(2)} of $${budget.toFixed(2)}); he will stay quiet`)
      : spent >= budget * 0.8 && budget > 0
        ? check("WARN", "Daily budget", `$${spent.toFixed(2)} of $${budget.toFixed(2)} used`)
        : check("PASS", "Daily budget", `$${spent.toFixed(2)} of $${budget.toFixed(2)} used`),
  );
  results.push(
    status.settings?.desiredState === "on"
      ? check("WARN", "Owner switch", "ON: the worker will start Tilt (and the OBS stream, unless LIVE_HOST_OBS_STREAM=off) as soon as it runs")
      : check("PASS", "Owner switch", "off"),
  );
  return results;
}

async function growthOs(env: NodeJS.ProcessEnv): Promise<CheckResult[]> {
  const base = (env.GROWTH_OS_BASE_URL ?? "https://fillbook-growth-os.vercel.app").replace(/\/+$/, "");
  const token = env.GROWTH_OS_AUTOMATION_TOKEN ?? "";
  if (token.length < 32) return [];
  try {
    const started = Date.now();
    const res = await fetch(`${base}/api/approvals?resource=live-host`, {
      headers: { authorization: `Bearer ${token}`, ...(env.GROWTH_OS_PROTECTION_BYPASS_SECRET ? { "x-vercel-protection-bypass": env.GROWTH_OS_PROTECTION_BYPASS_SECRET } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) return [check("FAIL", "Growth OS login", "401: the automation token does not match APP_API_TOKEN_AUTOMATION in Vercel")];
    if (!res.ok) return [check("FAIL", "Growth OS login", `HTTP ${res.status}`)];
    const body = (await res.json()) as Parameters<typeof checkGrowthOsStatus>[0];
    return [check("PASS", "Growth OS login", `ok (${((Date.now() - started) / 1000).toFixed(1)}s round trip)`), ...checkGrowthOsStatus(body)];
  } catch (err) {
    return [check("FAIL", "Growth OS login", `could not reach ${base}: ${err instanceof Error ? err.message : String(err)}`)];
  }
}

async function obs(env: NodeJS.ProcessEnv): Promise<CheckResult[]> {
  if (env.OBS_WEBSOCKET_URL === "off") return [check("WARN", "OBS", "OBS control is off; start and stop the stream by hand")];
  const client = new ObsClient(env.OBS_WEBSOCKET_URL || "ws://127.0.0.1:4455", env.OBS_WEBSOCKET_PASSWORD || undefined);
  const results: CheckResult[] = [];
  try {
    await client.connect();
    results.push(check("PASS", "OBS connection", "connected"));
    const scenes = (await client.request("GetSceneList")).scenes as Array<{ sceneName: string }> | undefined;
    results.push(scenes?.some((scene) => scene.sceneName === OBS_SCENE_NAME) ? check("PASS", "OBS scene", `"${OBS_SCENE_NAME}" exists`) : check("FAIL", "OBS scene", `no "${OBS_SCENE_NAME}" scene: run npm run live-host:setup-obs`));
    try {
      const items = (await client.request("GetSceneItemList", { sceneName: OBS_SCENE_NAME })).sceneItems as Array<{ sourceName: string; sourceType: string; inputKind?: string }> | undefined;
      results.push(items?.some((item) => item.sourceName === OBS_SOURCE_NAME) ? check("PASS", "Stage source", `"${OBS_SOURCE_NAME}" is in the scene`) : check("FAIL", "Stage source", `"${OBS_SOURCE_NAME}" is missing from the scene`));
      const camera = items?.some((item) => /dshow_input|v4l2_input|av_capture_input|macos-avcapture|window_capture|monitor_capture|game_capture/.test(item.inputKind ?? ""));
      results.push(camera ? check("PASS", "Camera / capture", "a capture source is in the scene") : check("WARN", "Camera / capture", "no camera or capture source in the scene yet (duo mode needs you on camera)"));
    } catch {
      results.push(check("WARN", "Stage source", "could not list the scene items"));
    }
    const video = await client.request("GetVideoSettings");
    results.push(
      video.baseWidth === STAGE_WIDTH && video.baseHeight === STAGE_HEIGHT
        ? check("PASS", "Canvas", `${STAGE_WIDTH} x ${STAGE_HEIGHT}`)
        : check("FAIL", "Canvas", `${video.baseWidth} x ${video.baseHeight}: expected ${STAGE_WIDTH} x ${STAGE_HEIGHT} (do not run OBS's auto-configuration wizard)`),
    );
    try {
      const service = (await client.request("GetStreamServiceSettings")).streamServiceSettings as { server?: string; key?: string } | undefined;
      results.push(service?.key ? check("PASS", "Stream key", "set") : check("WARN", "Stream key", "not set in OBS > Settings > Stream (needed only when you go live)"));
    } catch {
      results.push(check("WARN", "Stream key", "could not read the stream settings"));
    }
    results.push((await client.isStreaming()) ? check("WARN", "Streaming", "OBS is already streaming") : check("PASS", "Streaming", "not streaming"));
  } catch (err) {
    results.push(check("FAIL", "OBS connection", `${err instanceof Error ? err.message : String(err)} (is OBS open, with Tools > WebSocket Server Settings enabled?)`));
  } finally {
    client.close();
  }
  return results;
}

function voice(env: NodeJS.ProcessEnv): Promise<CheckResult[]> {
  const python = env.LIVE_HOST_PYTHON || "python";
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(python, ["-c", "import edge_tts"], { timeout: 60_000, windowsHide: true }, (error) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      resolve([
        error
          ? check("FAIL", "Voice (Python + edge-tts)", `${python} could not import edge_tts: run pip install edge-tts`)
          : check("PASS", "Voice (Python + edge-tts)", `ok; cold start ${seconds}s (the worker keeps it warm, so this is paid once)`),
      ]);
    });
  });
}

export async function runPreflight(env: NodeJS.ProcessEnv = process.env): Promise<CheckResult[]> {
  const [growth, obsResults, voiceResults] = await Promise.all([growthOs(env), obs(env), voice(env)]);
  return [...checkEnvironment(env), ...growth, ...obsResults, ...voiceResults];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = await runPreflight();
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  const warned = results.filter((r) => r.status === "WARN").length;
  console.log(`\n${failed === 0 ? "Ready to go live" : "Not ready"}: ${failed} failed, ${warned} to look at.`);
  process.exit(failed === 0 ? 0 : 1);
}
