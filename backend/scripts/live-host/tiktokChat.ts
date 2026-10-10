/**
 * Reads the chat of the owner's own TikTok LIVE so the Live Host can answer it.
 *
 * OWNER DECISION (2026-10-09): TikTok offers no official way to read LIVE chat (docs/TIKTOK_COMMENTS_BLOCKED.md).
 * The owner chose, with the risks explained, to read it through the unofficial `tiktok-live-connector` library.
 * That is the "explicit, owner-approved exception" option 3 of that document describes. What that means here:
 *
 *   - Read-only. This file only listens. It never sends a chat message, a like, a follow or anything else, and
 *     it is never given a TikTok session or login: the library reads public chat with just the username.
 *     Posting would be an EXTERNAL_WRITE and stays rejected (docs/EXTERNAL_WRITE_FIREWALL.md).
 *   - Off unless the owner turns it on: the server only accepts TikTok messages while
 *     live_host_settings.tiktok_chat_enabled is true, and the worker only connects when the server says so.
 *   - Unofficial and fragile. The library is reverse-engineered, depends on a third-party signing service, and
 *     breaks when TikTok changes things. When it cannot connect the host keeps running its segments without
 *     chat; nothing else fails.
 *   - Not a dependency of this project. It is AGPL-licensed and optional, so it is installed on the streaming
 *     PC only (`npm run live-host:install-tiktok-reader`) and loaded at runtime if present.
 *
 * Everything read here goes to the server as untrusted text and through the same screening as YouTube chat
 * (liveHostGuardrails.ts) before the model or the stage ever sees it.
 */

export interface TiktokChatMessage {
  platform: "tiktok";
  externalId: string;
  authorName: string;
  body: string;
  receivedAt: string;
}

/** The fields this reader uses from a chat event. Everything is optional: the library's shapes change between versions. */
export interface TiktokChatEvent {
  comment?: unknown;
  msgId?: unknown;
  common?: { msgId?: unknown };
  user?: { nickname?: unknown; uniqueId?: unknown };
  nickname?: unknown;
  uniqueId?: unknown;
}

/** Turns one library chat event into a message for the server, or null when there is nothing usable in it. */
export function toChatMessage(event: TiktokChatEvent, now: Date = new Date(), sequence = 0): TiktokChatMessage | null {
  const body = typeof event.comment === "string" ? event.comment.trim() : "";
  if (!body) return null;
  const handle = event.user?.uniqueId ?? event.uniqueId;
  const name = event.user?.nickname ?? event.nickname ?? handle;
  const id = event.common?.msgId ?? event.msgId;
  return {
    platform: "tiktok",
    // The message id when TikTok gives one; otherwise something unique enough that a replay is not stored twice.
    externalId: id !== undefined && id !== null && String(id) !== "" ? String(id) : `${String(handle ?? "viewer")}-${now.getTime()}-${sequence}`,
    authorName: typeof name === "string" ? name : "",
    body,
    receivedAt: now.toISOString(),
  };
}

/** A join is only worth welcoming for this long; after that the viewer has settled in or left. */
export const JOIN_FRESH_MS = 90_000;
const MAX_JOINS = 30;

/** The display name from a join (member) event, or null. */
export function joinerName(event: TiktokChatEvent): string | null {
  const name = event.user?.nickname ?? event.nickname ?? event.user?.uniqueId ?? event.uniqueId;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Most messages held between two ticks. A flood keeps the newest; the server trims further. */
const MAX_BUFFERED = 200;
const RETRY_AFTER_MS = 30_000;

interface Connection {
  on(event: string, handler: (data: TiktokChatEvent) => void): void;
  connect(): Promise<unknown>;
  disconnect?(): unknown;
}

export class TiktokChatReader {
  private connection: Connection | null = null;
  private username: string | null = null;
  private nextAttemptAt = 0;
  private lastProblem: string | null = null;
  private sequence = 0;
  private readonly buffer: TiktokChatMessage[] = [];
  private joins: Array<{ name: string; at: number }> = [];

  constructor(private log: (line: string) => void = () => {}) {}

  get connected(): boolean {
    return this.connection !== null;
  }

  /** Takes everything read since the last call. */
  drain(): TiktokChatMessage[] {
    return this.buffer.splice(0, this.buffer.length);
  }

  /** Viewers who joined recently and have not been welcomed yet. Not removed until clearJoins(). */
  recentJoins(now: number = Date.now()): Array<{ name: string }> {
    this.joins = this.joins.filter((join) => now - join.at < JOIN_FRESH_MS);
    return this.joins.map((join) => ({ name: join.name }));
  }

  /** Called when the server says it welcomed (or dropped) the joins it was sent. */
  clearJoins(): void {
    this.joins = [];
  }

  /** Records one join. Public so it can be exercised without a live connection. */
  noteJoin(name: string | null, now: number = Date.now()): void {
    if (!name || this.joins.some((join) => join.name === name)) return;
    this.joins.push({ name, at: now });
    if (this.joins.length > MAX_JOINS) this.joins.splice(0, this.joins.length - MAX_JOINS);
  }

  /** Puts messages back at the front, for when a tick failed and they were not delivered. */
  restore(messages: TiktokChatMessage[]): void {
    this.buffer.unshift(...messages);
    if (this.buffer.length > MAX_BUFFERED) this.buffer.splice(0, this.buffer.length - MAX_BUFFERED);
  }

  /** Connects when it should be reading and is not; disconnects when it should not be. Safe to call on every tick. */
  async ensure(shouldRead: boolean, username: string | null): Promise<void> {
    if (!shouldRead || !username) {
      this.stop();
      return;
    }
    if (this.connection && this.username === username) return;
    if (Date.now() < this.nextAttemptAt) return;
    this.stop();
    this.nextAttemptAt = Date.now() + RETRY_AFTER_MS;

    try {
      // Loaded by name at runtime so the project builds and tests without the optional package installed.
      const packageName = "tiktok-live-connector";
      const library = (await import(packageName)) as Record<string, any>;
      const ConnectionClass = library.TikTokLiveConnection ?? library.WebcastPushConnection;
      if (!ConnectionClass) throw new Error("the installed tiktok-live-connector has no connection class this reader knows");
      // The options object is required: this library version reads fields from it without checking it exists.
      const connection = new ConnectionClass(username, {}) as Connection;
      const events = (library.WebcastEvent ?? {}) as Record<string, string>;

      connection.on(events.CHAT ?? "chat", (data) => {
        const message = toChatMessage(data, new Date(), this.sequence++);
        if (!message) return;
        this.buffer.push(message);
        if (this.buffer.length > MAX_BUFFERED) this.buffer.splice(0, this.buffer.length - MAX_BUFFERED);
      });
      connection.on(events.MEMBER ?? "member", (data) => this.noteJoin(joinerName(data)));
      // Without a listener, an "error" event from the library would crash the whole worker.
      connection.on("error", (data) => this.log(`TikTok chat: ${String((data as { info?: unknown })?.info ?? "connection error").slice(0, 160)}`));
      const dropped = () => {
        if (this.connection === connection) {
          this.connection = null;
          this.log("TikTok chat: connection closed. Will reconnect.");
        }
      };
      connection.on(events.DISCONNECTED ?? "disconnected", dropped);
      connection.on(events.STREAM_END ?? "streamEnd", dropped);

      await connection.connect();
      this.connection = connection;
      this.username = username;
      this.lastProblem = null;
      this.log(`TikTok chat: reading @${username}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const problem = /Cannot find (package|module)|ERR_MODULE_NOT_FOUND/i.test(message)
        ? "TikTok chat is switched on, but the reader is not installed on this PC. Run: npm run live-host:install-tiktok-reader"
        : `TikTok chat: cannot read @${username} yet (${message.slice(0, 160)}). The account must be LIVE on TikTok. Retrying.`;
      // Say each distinct problem once, not every 30 seconds.
      if (problem !== this.lastProblem) this.log(problem);
      this.lastProblem = problem;
    }
  }

  stop(): void {
    const connection = this.connection;
    this.connection = null;
    this.username = null;
    this.joins = [];
    try {
      connection?.disconnect?.();
    } catch {
      // Already gone.
    }
  }
}
