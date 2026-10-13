/**
 * A deliberately small in-memory stand-in for the subset of the
 * supabase-js query builder this project's repositories use. Filters are
 * applied to plain row arrays; nested selects are served from whatever
 * nested objects the fixture rows already carry (the select string is
 * recorded but not interpreted). Every executed query is logged so tests
 * can assert on query COUNT and SHAPE, and any table can be told to fail
 * so error propagation is testable without a network.
 */
import { vi } from "vitest";

export type FakeRow = Record<string, any>;

export interface FakeQueryLog {
  table: string;
  op: "select" | "update" | "insert" | "upsert" | "delete";
  filters: Array<{ kind: string; column: string; value: unknown }>;
  select?: string;
  payload?: unknown;
  head?: boolean;
  limit?: number;
}

export interface FakeError {
  message: string;
  code?: string;
}

export class FakeSupabaseClient {
  readonly log: FakeQueryLog[] = [];
  private failures = new Map<string, FakeError>();
  /** Optional hook invoked before each query executes -- used to measure concurrency. */
  onExecute?: (log: FakeQueryLog) => Promise<void> | void;

  constructor(public tables: Record<string, FakeRow[]> = {}) {}

  /** Make every query against `table` (optionally only `op`) resolve with this error. */
  failTable(table: string, error: FakeError, op?: FakeQueryLog["op"]) {
    this.failures.set(op ? `${table}:${op}` : table, error);
  }

  from(table: string) {
    return new FakeQueryBuilder(this, table);
  }

  /**
   * Models exactly two Postgres functions this project's fake client
   * needs (reserve_partnership_budget / release_partnership_budget_reservation,
   * see migration 0024) -- not a generic RPC dispatcher. Deliberately has
   * NO internal `await`: a real Postgres function serializes concurrent
   * callers via pg_advisory_xact_lock, so two "concurrent" test calls
   * (raced via Promise.all) must see each other's effects in the order
   * their own promise chains actually reach this call, never interleaved
   * mid-computation. Since this method's body runs synchronously to
   * completion within its own microtask turn, that serialization is
   * preserved for free -- no lock object needed in the fake.
   */
  rpc(fnName: string, params: Record<string, any> = {}) {
    return new FakeRpcCall(this, fnName, params);
  }

  /** @internal */
  failureFor(table: string, op: FakeQueryLog["op"]): FakeError | undefined {
    return this.failures.get(`${table}:${op}`) ?? this.failures.get(table);
  }

  queriesFor(table: string): FakeQueryLog[] {
    return this.log.filter((q) => q.table === table);
  }
}

class FakeQueryBuilder implements PromiseLike<{ data: any; error: FakeError | null; count?: number | null }> {
  private entry: FakeQueryLog;
  private orderBy: { column: string; ascending: boolean } | null = null;
  private singleMode: "single" | "maybeSingle" | null = null;
  private countMode = false;
  private rangeBounds: { from: number; to: number } | null = null;

  constructor(private client: FakeSupabaseClient, table: string) {
    this.entry = { table, op: "select", filters: [] };
  }

  select(columns?: string, options?: { count?: string; head?: boolean }) {
    if (this.entry.op === "select") this.entry.select = columns ?? "*";
    if (options?.head) this.entry.head = true;
    if (options?.count) this.countMode = true;
    return this;
  }
  eq(column: string, value: unknown) { this.entry.filters.push({ kind: "eq", column, value }); return this; }
  neq(column: string, value: unknown) { this.entry.filters.push({ kind: "neq", column, value }); return this; }
  gte(column: string, value: unknown) { this.entry.filters.push({ kind: "gte", column, value }); return this; }
  gt(column: string, value: unknown) { this.entry.filters.push({ kind: "gt", column, value }); return this; }
  lt(column: string, value: unknown) { this.entry.filters.push({ kind: "lt", column, value }); return this; }
  lte(column: string, value: unknown) { this.entry.filters.push({ kind: "lte", column, value }); return this; }
  in(column: string, values: unknown[]) { this.entry.filters.push({ kind: "in", column, value: values }); return this; }
  is(column: string, value: unknown) { this.entry.filters.push({ kind: "is", column, value }); return this; }
  not(column: string, operator: string, value: unknown) { this.entry.filters.push({ kind: `not.${operator}`, column, value }); return this; }
  ilike(column: string, pattern: string) { this.entry.filters.push({ kind: "ilike", column, value: pattern }); return this; }
  /** Minimal PostgREST-style `or("col.eq.val,col2.eq.val2")` support -- only the `eq` operator, since that's all this project's callers use. */
  or(filterString: string) { this.entry.filters.push({ kind: "or", column: "", value: filterString }); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.orderBy = { column, ascending: options?.ascending ?? true }; return this; }
  limit(n: number) { this.entry.limit = n; return this; }
  /** PostgREST range(from, to), inclusive, applied after ordering. */
  range(from: number, to: number) { this.rangeBounds = { from, to }; return this; }
  maybeSingle() { this.singleMode = "maybeSingle"; return this; }
  single() { this.singleMode = "single"; return this; }
  update(payload: FakeRow) { this.entry.op = "update"; this.entry.payload = payload; return this; }
  insert(payload: FakeRow | FakeRow[]) { this.entry.op = "insert"; this.entry.payload = payload; return this; }
  upsert(payload: FakeRow | FakeRow[]) { this.entry.op = "upsert"; this.entry.payload = payload; return this; }
  delete() { this.entry.op = "delete"; return this; }

  private matches(row: FakeRow): boolean {
    return this.entry.filters.every(({ kind, column, value }) => {
      // PostgREST JSON path: "context->>endpoint" reads one key of a jsonb column as text.
      const jsonPath = /^(.+)->>(.+)$/.exec(column);
      const actual = jsonPath ? (row[jsonPath[1]!] as Record<string, unknown> | null | undefined)?.[jsonPath[2]!] : row[column];
      switch (kind) {
        case "eq": return actual === value;
        case "neq": return actual !== value;
        case "gte": return actual >= (value as any);
        case "gt": return actual > (value as any);
        case "lt": return actual < (value as any);
        case "lte": return actual <= (value as any);
        case "in": return (value as unknown[]).includes(actual);
        case "is": return value === null ? actual === null || actual === undefined : actual === value;
        case "not.is": return value === null ? actual !== null && actual !== undefined : actual !== value;
        case "ilike": {
          if (actual === null || actual === undefined) return false;
          const pattern = String(value).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
          return new RegExp(`^${pattern}$`).test(String(actual).toLowerCase());
        }
        case "or": {
          const clauses = String(value).split(",");
          return clauses.some((clause) => {
            const match = /^([^.]+)\.([^.]+)\.(.*)$/.exec(clause);
            if (!match) return false;
            const [, col, op, val] = match;
            if (op !== "eq" || !col) return false;
            return row[col] === val;
          });
        }
        default: throw new Error(`FakeSupabaseClient: unsupported filter ${kind}`);
      }
    });
  }

  private async execute(): Promise<{ data: any; error: FakeError | null; count?: number | null }> {
    this.client.log.push(this.entry);
    if (this.client.onExecute) await this.client.onExecute(this.entry);

    const failure = this.client.failureFor(this.entry.table, this.entry.op);
    if (failure) return { data: null, error: failure, count: null };

    const rows = this.client.tables[this.entry.table] ?? [];

    if (this.entry.op === "insert" || this.entry.op === "upsert") {
      const inserted = (Array.isArray(this.entry.payload) ? this.entry.payload : [this.entry.payload]) as FakeRow[];
      const withIds = inserted.map((r, i) => ({ id: `${this.entry.table}-${rows.length + i + 1}`, ...r }));
      this.client.tables[this.entry.table] = [...rows, ...withIds];
      return this.finish(withIds);
    }

    let matched = rows.filter((r) => this.matches(r));

    if (this.entry.op === "update") {
      matched = matched.map((r) => Object.assign(r, this.entry.payload as FakeRow));
      return this.finish(matched);
    }
    if (this.entry.op === "delete") {
      this.client.tables[this.entry.table] = rows.filter((r) => !this.matches(r));
      return this.finish(matched);
    }

    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      matched = [...matched].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1));
    }
    if (this.rangeBounds) matched = matched.slice(this.rangeBounds.from, this.rangeBounds.to + 1);
    if (this.entry.limit !== undefined) matched = matched.slice(0, this.entry.limit);
    if (this.entry.head) return { data: null, error: null, count: matched.length };
    return this.finish(matched);
  }

  private finish(rows: FakeRow[]): { data: any; error: FakeError | null; count?: number | null } {
    const count = this.countMode ? rows.length : undefined;
    if (this.singleMode === "single") {
      if (rows.length !== 1) return { data: null, error: { message: `single() expected exactly one row, got ${rows.length}`, code: "PGRST116" }, count };
      return { data: rows[0], error: null, count };
    }
    if (this.singleMode === "maybeSingle") return { data: rows[0] ?? null, error: null, count };
    return { data: rows, error: null, count };
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: FakeError | null; count?: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

const PARTNERSHIP_BUDGET_EVENT_TYPES: Record<string, string[]> = {
  discovery: ["partnership_x_search_read"],
  generation: ["partnership_llm_call"],
};
const PARTNERSHIP_SHARED_EVENT_TYPES = ["partnership_llm_call", "partnership_x_search_read"];

class FakeRpcCall implements PromiseLike<{ data: any; error: FakeError | null }> {
  constructor(
    private client: FakeSupabaseClient,
    private fnName: string,
    private params: Record<string, any>,
  ) {}

  private execute(): { data: any; error: FakeError | null } {
    if (this.fnName === "reserve_partnership_budget") return this.reserve();
    if (this.fnName === "release_partnership_budget_reservation") return this.release();
    if (this.fnName === "reserve_video_storage_bytes") return this.reserveVideoStorage();
    if (this.fnName === "commit_video_storage_reservation") return this.commitVideoStorage();
    if (this.fnName === "release_video_storage_reservation") return this.releaseVideoStorage();
    throw new Error(`FakeSupabaseClient: unmodeled rpc "${this.fnName}"`);
  }

  /**
   * Models migration 0027's reserve_video_storage_bytes exactly: sweeps
   * any 'reserved' row past its expires_at to 'released' first (the
   * crash-recovery self-heal), then sums 'committed' + still-open
   * 'reserved' rows only -- never a mere reservation as permanent usage.
   */
  private reserveVideoStorage(): { data: any; error: FakeError | null } {
    const { p_video_render_id, p_bytes, p_cap } = this.params;
    const now = new Date();
    const rows: FakeRow[] = this.client.tables["video_storage_reservations"] ?? [];

    const swept = rows.map((r) =>
      r.status === "reserved" && new Date(r.expires_at).getTime() < now.getTime()
        ? { ...r, status: "released", released_at: now.toISOString() }
        : r,
    );
    this.client.tables["video_storage_reservations"] = swept;

    const committed = swept.filter((r) => r.status === "committed").reduce((s, r) => s + Number(r.reserved_bytes ?? 0), 0);
    const reserved = swept.filter((r) => r.status === "reserved").reduce((s, r) => s + Number(r.reserved_bytes ?? 0), 0);

    if (committed + reserved + p_bytes > p_cap) {
      return {
        data: [
          {
            reservation_id: null,
            eligible: false,
            reason: `storage_cap_reached (committed ${committed} + reserved ${reserved} + requested ${p_bytes} exceeds cap ${p_cap})`,
          },
        ],
        error: null,
      };
    }

    const id = `vres-${swept.length + 1}`;
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const row = { id, video_render_id: p_video_render_id, reserved_bytes: p_bytes, status: "reserved", reserved_at: now.toISOString(), expires_at: expiresAt, committed_at: null, released_at: null, deleted_at: null };
    this.client.tables["video_storage_reservations"] = [...swept, row];
    return { data: [{ reservation_id: id, eligible: true, reason: null }], error: null };
  }

  private commitVideoStorage(): { data: any; error: FakeError | null } {
    const { p_reservation_id } = this.params;
    const rows: FakeRow[] = this.client.tables["video_storage_reservations"] ?? [];
    this.client.tables["video_storage_reservations"] = rows.map((r) =>
      r.id === p_reservation_id && r.status === "reserved" ? { ...r, status: "committed", committed_at: new Date().toISOString() } : r,
    );
    return { data: null, error: null };
  }

  private releaseVideoStorage(): { data: any; error: FakeError | null } {
    const { p_reservation_id } = this.params;
    const rows: FakeRow[] = this.client.tables["video_storage_reservations"] ?? [];
    this.client.tables["video_storage_reservations"] = rows.map((r) =>
      r.id === p_reservation_id && r.status === "reserved" ? { ...r, status: "released", released_at: new Date().toISOString() } : r,
    );
    return { data: null, error: null };
  }

  private reserve(): { data: any; error: FakeError | null } {
    const {
      p_amount_usd,
      p_bucket,
      p_prospect_id = null,
      p_bucket_budget_usd,
      p_total_budget_usd,
      p_expiry_seconds = 300,
    } = this.params;
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const inMonth = (r: FakeRow) => {
      const t = new Date(r.created_at).getTime();
      return t >= monthStart && t < monthEnd;
    };

    // Settle any reservation abandoned past its expiry into a real,
    // conservative cost_events charge BEFORE computing totals below --
    // mirrors migration 0025's reserve_partnership_budget exactly (see
    // its own doc comment for why this must happen here, not just at
    // release time).
    const expiryMs = p_expiry_seconds * 1000;
    const allReservations: FakeRow[] = this.client.tables["partnership_budget_reservations"] ?? [];
    const isExpiredOpen = (r: FakeRow) => r.released_at == null && now.getTime() - new Date(r.created_at).getTime() > expiryMs;
    const costEventsForSettlement: FakeRow[] = this.client.tables["cost_events"] ?? [];
    const settledRows: FakeRow[] = [];
    for (const r of allReservations) {
      if (!isExpiredOpen(r)) continue;
      settledRows.push({
        event_type: r.bucket === "discovery" ? "partnership_x_search_read" : "partnership_llm_call",
        provider: r.bucket === "discovery" ? "x" : "anthropic",
        model: r.bucket === "discovery" ? "search/recent" : "reservation-settlement",
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: r.amount_usd,
        context: { settledReservationId: r.id, reason: "expired_unreleased_reservation_conservatively_settled" },
        created_at: now.toISOString(),
      });
    }
    if (settledRows.length > 0) {
      this.client.tables["cost_events"] = [...costEventsForSettlement, ...settledRows.map((r, i) => ({ id: `cost_events-settled-${i}`, ...r }))];
      this.client.tables["partnership_budget_reservations"] = allReservations.map((r) => (isExpiredOpen(r) ? { ...r, released_at: now.toISOString(), settled_as_charge: true } : r));
    }

    const costEvents: FakeRow[] = this.client.tables["cost_events"] ?? [];
    const bucketTypes = PARTNERSHIP_BUDGET_EVENT_TYPES[p_bucket] ?? [];
    const actualBucket = costEvents.filter((r) => bucketTypes.includes(r.event_type) && inMonth(r)).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
    const actualTotal = costEvents.filter((r) => PARTNERSHIP_SHARED_EVENT_TYPES.includes(r.event_type) && inMonth(r)).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);

    // Expiry is now fully handled by the settlement pass above -- nothing
    // left with released_at == null can be stale.
    const reservations: FakeRow[] = this.client.tables["partnership_budget_reservations"] ?? [];
    const isActive = (r: FakeRow) => r.released_at == null;
    const reservedBucket = reservations.filter((r) => r.bucket === p_bucket && isActive(r)).reduce((s, r) => s + Number(r.amount_usd ?? 0), 0);
    const reservedTotal = reservations.filter(isActive).reduce((s, r) => s + Number(r.amount_usd ?? 0), 0);

    if (actualBucket + reservedBucket + p_amount_usd > p_bucket_budget_usd) {
      return {
        data: [
          {
            reservation_id: null,
            eligible: false,
            reason: `bucket_budget_reached (${p_bucket}: actual $${actualBucket.toFixed(4)} + in-flight $${reservedBucket.toFixed(4)} + requested $${p_amount_usd.toFixed(4)} exceeds bucket cap $${p_bucket_budget_usd.toFixed(2)})`,
          },
        ],
        error: null,
      };
    }
    if (actualTotal + reservedTotal + p_amount_usd > p_total_budget_usd) {
      return {
        data: [
          {
            reservation_id: null,
            eligible: false,
            reason: `shared_budget_reached (actual $${actualTotal.toFixed(4)} + in-flight $${reservedTotal.toFixed(4)} + requested $${p_amount_usd.toFixed(4)} exceeds shared cap $${p_total_budget_usd.toFixed(2)})`,
          },
        ],
        error: null,
      };
    }

    const id = `resv-${reservations.length + 1}`;
    const row = { id, bucket: p_bucket, amount_usd: p_amount_usd, prospect_id: p_prospect_id, created_at: now.toISOString(), released_at: null, settled_as_charge: false };
    this.client.tables["partnership_budget_reservations"] = [...reservations, row];
    return { data: [{ reservation_id: id, eligible: true, reason: null }], error: null };
  }

  private release(): { data: any; error: FakeError | null } {
    const { p_reservation_id, p_confirmed_real_cost_recorded = false } = this.params;
    const reservations: FakeRow[] = this.client.tables["partnership_budget_reservations"] ?? [];
    const target = reservations.find((r) => r.id === p_reservation_id);

    if (target?.settled_as_charge && p_confirmed_real_cost_recorded) {
      // Real cost_events rows now exist for this same attempt -- reverse
      // the earlier conservative ceiling charge so it's never
      // double-counted against the real recorded cost.
      const costEvents: FakeRow[] = this.client.tables["cost_events"] ?? [];
      this.client.tables["cost_events"] = costEvents.filter((r) => r.context?.settledReservationId !== p_reservation_id);
    }

    this.client.tables["partnership_budget_reservations"] = reservations.map((r) =>
      r.id === p_reservation_id && r.released_at == null ? { ...r, released_at: new Date().toISOString() } : r,
    );
    return { data: null, error: null };
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: FakeError | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }
}

/** Cast helper so a FakeSupabaseClient can be handed to code typed against SupabaseClient. */
export function asSupabase(client: FakeSupabaseClient): any {
  return client;
}

/** A spy-wrapped client for tests that just need to count `from()` calls. */
export function spyClient(client: FakeSupabaseClient) {
  const from = vi.spyOn(client, "from");
  return { client, from };
}
