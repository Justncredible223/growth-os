/**
 * A warm voice process for the Live Host worker.
 *
 * Starting Python and importing edge_tts took 6 to 9 seconds on the owner's laptop, paid again for every line
 * (measured 2026-10-10: `python -c pass` alone took about 6 seconds). This keeps one helper process
 * (tts_server.py) alive and sends it a line at a time over stdin/stdout, so a line costs only the synthesis.
 *
 * It never decides what is said and never throws into the worker: if the helper cannot start or dies, `ready`
 * is false and the caller falls back to launching the one-shot script, exactly as before.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface TtsRequest {
  voice: string;
  rate: string;
  textFile: string;
  mediaPath: string;
  wordsPath: string;
}

interface Pending {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const RESTART_AFTER_MS = 30_000;

export class TtsDaemon {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private counter = 0;
  private lastStartAt = 0;
  private isReady = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** True while the helper is running and has finished importing edge_tts. */
  get ready(): boolean {
    return this.isReady && this.child !== null;
  }

  start(): void {
    if (this.child || Date.now() - this.lastStartAt < RESTART_AFTER_MS) return;
    this.lastStartAt = Date.now();
    this.isReady = false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, this.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      this.log(`voice helper could not start (${err instanceof Error ? err.message : String(err)}); using the slower per-line voice`);
      return;
    }
    this.child = child;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.on("data", () => {
      // The helper reports errors per request; stray stderr (library warnings) is not worth the log.
    });
    child.on("error", (err) => this.onExit(`voice helper error: ${err.message}`));
    child.on("exit", (code) => this.onExit(`voice helper stopped (exit ${code ?? "?"})`));
    child.stdin.on("error", () => {
      // A write to a dead helper surfaces through the exit handler.
    });
  }

  /** Synthesizes one line. Rejects if the helper is not ready, dies, or takes longer than `timeoutMs`. */
  synthesize(request: TtsRequest, timeoutMs: number): Promise<void> {
    const child = this.child;
    if (!child || !this.isReady) return Promise.reject(new Error("voice helper is not ready"));
    const id = `r${++this.counter}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("voice helper timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`voice helper write failed: ${err.message}`));
        }
      });
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.isReady = false;
    this.failAll(new Error("voice helper stopped"));
    if (child) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: { ready?: boolean; id?: string; ok?: boolean; error?: string };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (message.ready) {
        this.isReady = true;
        this.log("voice helper is warm");
        continue;
      }
      const entry = message.id ? this.pending.get(message.id) : undefined;
      if (!entry || !message.id) continue;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.ok) entry.resolve();
      else entry.reject(new Error(message.error || "voice helper could not synthesize the line"));
    }
  }

  private onExit(reason: string): void {
    if (!this.child) return;
    this.child = null;
    this.isReady = false;
    this.buffer = "";
    this.log(`${reason}; using the slower per-line voice until it restarts`);
    this.failAll(new Error(reason));
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}
