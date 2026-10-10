import { createHash, randomUUID } from "node:crypto";

/**
 * A minimal client for OBS Studio's built-in WebSocket server (obs-websocket v5, shipped with OBS 28+). The Live
 * Host worker only needs three things from OBS: is it streaming, start streaming, stop streaming. OBS itself
 * does the real work (it shows the stage page as a Browser Source, captures its audio, and pushes RTMP), so
 * nothing here knows about stream keys.
 */

/** obs-websocket v5 authentication string: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export function obsAuthResponse(password: string, salt: string, challenge: string): string {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

interface ObsMessage {
  op: number;
  d: Record<string, any>;
}

export class ObsClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, { resolve: (data: Record<string, any>) => void; reject: (err: Error) => void }>();
  private identified = false;

  constructor(
    private url: string,
    private password: string | undefined,
    private log: (line: string) => void = () => {},
  ) {}

  get connected(): boolean {
    return this.identified && this.socket?.readyState === WebSocket.OPEN;
  }

  /** Connects and identifies. Rejects if OBS is not running, the WebSocket server is off, or the password is wrong. */
  connect(timeoutMs = 5_000): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.close();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const timer = setTimeout(() => {
        reject(new Error(`OBS did not answer at ${this.url}`));
        this.close();
      }, timeoutMs);

      socket.addEventListener("message", (event) => {
        let message: ObsMessage;
        try {
          message = JSON.parse(String(event.data)) as ObsMessage;
        } catch {
          return;
        }
        if (message.op === 0) {
          // Hello: identify, answering the auth challenge when OBS has a password set.
          const auth = message.d.authentication as { challenge: string; salt: string } | undefined;
          if (auth && !this.password) {
            clearTimeout(timer);
            reject(new Error("OBS WebSocket needs a password: set OBS_WEBSOCKET_PASSWORD"));
            this.close();
            return;
          }
          socket.send(
            JSON.stringify({
              op: 1,
              d: { rpcVersion: 1, eventSubscriptions: 0, ...(auth ? { authentication: obsAuthResponse(this.password ?? "", auth.salt, auth.challenge) } : {}) },
            }),
          );
        } else if (message.op === 2) {
          clearTimeout(timer);
          this.identified = true;
          resolve();
        } else if (message.op === 7) {
          const waiter = this.pending.get(message.d.requestId as string);
          if (!waiter) return;
          this.pending.delete(message.d.requestId as string);
          const status = message.d.requestStatus as { result: boolean; comment?: string; code: number };
          if (status.result) waiter.resolve((message.d.responseData as Record<string, any>) ?? {});
          else waiter.reject(new Error(`OBS ${message.d.requestType as string} failed: ${status.comment ?? `code ${status.code}`}`));
        }
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        this.identified = false;
        for (const waiter of this.pending.values()) waiter.reject(new Error("OBS connection closed"));
        this.pending.clear();
        reject(new Error(`Could not connect to OBS at ${this.url}`));
      });
      socket.addEventListener("error", () => {
        // The close handler reports it.
      });
    });
  }

  /** One obs-websocket request. Rejects with OBS's own comment when the request fails. */
  request(requestType: string, requestData: Record<string, unknown> = {}): Promise<Record<string, any>> {
    if (!this.connected || !this.socket) return Promise.reject(new Error("OBS is not connected"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.socket!.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new Error(`OBS ${requestType} timed out`));
      }, 8_000);
    });
  }

  async isStreaming(): Promise<boolean> {
    return (await this.request("GetStreamStatus")).outputActive === true;
  }

  async startStream(): Promise<void> {
    if (await this.isStreaming()) return;
    await this.request("StartStream");
    this.log("OBS: stream started");
  }

  async stopStream(): Promise<void> {
    if (!(await this.isStreaming())) return;
    await this.request("StopStream");
    this.log("OBS: stream stopped");
  }

  /** Reloads a Browser Source, the same as pressing "Refresh cache of current page" in its properties. */
  async refreshBrowserSource(inputName: string): Promise<void> {
    await this.request("PressInputPropertiesButton", { inputName, propertyName: "refreshnocache" });
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
    this.socket = null;
    this.identified = false;
  }
}
