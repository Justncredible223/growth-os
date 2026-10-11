#!/usr/bin/env node
/**
 * Runs the Live Host worker and restarts it if it ever exits, so an unattended stream survives a crash:
 *
 *   npm run live-host:supervised
 *
 * It passes its environment straight through (LIVE_HOST_PLATFORM, LIVE_HOST_MODE and so on), waits a growing
 * time between restarts (3s, 6s, 12s ... up to 60s) and starts again from 3s once a run has lasted two minutes.
 * Ctrl+C stops the worker and the supervisor together. It never decides what is said and holds no credentials.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RESTART_MIN_MS = 3_000;
export const RESTART_MAX_MS = 60_000;
/** A run at least this long counts as healthy, so the next restart waits the minimum again. */
export const HEALTHY_RUN_MS = 120_000;

/** How long to wait before the next restart, given the last wait and how long the last run lasted. */
export function nextRestartDelay(previousDelayMs: number | null, ranMs: number): number {
  if (previousDelayMs === null || ranMs >= HEALTHY_RUN_MS) return RESTART_MIN_MS;
  return Math.min(RESTART_MAX_MS, previousDelayMs * 2);
}

function log(line: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] supervisor: ${line}`);
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGTERM");
}

async function main(): Promise<void> {
  let stopping = false;
  let child: ChildProcess | null = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("stopping");
    if (child) killTree(child);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let delay: number | null = null;
  while (!stopping) {
    const startedAt = Date.now();
    log("starting the worker");
    child = spawn("npm", ["run", "live-host"], { stdio: "inherit", shell: true, env: process.env });
    const code = await new Promise<number | null>((resolve) => {
      child!.on("exit", (exitCode) => resolve(exitCode));
      child!.on("error", () => resolve(null));
    });
    child = null;
    if (stopping) break;
    delay = nextRestartDelay(delay, Date.now() - startedAt);
    log(`the worker exited (code ${code ?? "?"}); restarting in ${Math.round(delay / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, delay!));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
