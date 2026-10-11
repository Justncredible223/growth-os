import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage } from "../src/lib/errorMessage.js";
import { getServiceClient } from "../src/lib/supabaseClient.js";
import { requireAppAuth } from "../src/lib/requireAppAuth.js";
import { loadVideoHealth } from "../src/video/videoHealth.js";
import { retiredStepSkip } from "../src/retiredSteps.js";
import { INBOUND_CURSOR_SOURCE } from "../src/inbound/inboundIngestion.js";
import { createSearchConsoleAdapter } from "../src/signals/adapters/searchConsoleAdapter.js";

interface HealthItem {
  label: string;
  status: string;
  detail: string;
}

/**
 * No deployed endpoint calls the deep-review agents yet, so there's no
 * content_scores evidence to check the way Search Console checks for a
 * real signals row. A live API call on every health-check hit would cost
 * real money per poll, so this checks env var presence only -- verified
 * to actually work against the real API and real workspace once,
 * out-of-band (see docs/PROGRESS_LEDGER.md Phase 6).
 */
function checkAiProvider(): HealthItem {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasWorkspace = Boolean(process.env.ANTHROPIC_WORKSPACE_ID);
  if (hasKey && hasWorkspace) {
    return { label: "AI provider", status: "HEALTHY", detail: "ANTHROPIC_API_KEY + ANTHROPIC_WORKSPACE_ID configured" };
  }
  if (hasKey && !hasWorkspace) {
    return {
      label: "AI provider",
      status: "DEGRADED",
      detail: "ANTHROPIC_API_KEY set but ANTHROPIC_WORKSPACE_ID missing -- identity-linked keys need both",
    };
  }
  return { label: "AI provider", status: "NOT_CONNECTED", detail: "Needs an API key for deep content review (owner action)" };
}

/**
 * A row for `cursorSource` in signal_ingestion_cursors only ever gets
 * written after a real, successful ingest call (see xIngestion.ts) --
 * its presence is real evidence the adapter works, not just that
 * credentials exist.
 */
async function checkCursorBackedIntegration(
  client: SupabaseClient,
  label: string,
  cursorSource: string | string[],
  notYetVerifiedDetail: string,
): Promise<HealthItem> {
  try {
    const sources = Array.isArray(cursorSource) ? cursorSource : [cursorSource];
    // Newest cursor across the given sources: with the x_mentions step retired, Inbound's cursor is the live evidence.
    const { data } = await client
      .from("signal_ingestion_cursors")
      .select("updated_at")
      .in("source", sources)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      return { label, status: "HEALTHY", detail: `Verified live -- last synced ${(data as { updated_at: string }).updated_at}` };
    }
    return { label, status: "DEGRADED", detail: notYetVerifiedDetail };
  } catch (err) {
    return { label, status: "DEGRADED", detail: errorMessage(err) };
  }
}

/**
 * Search Console has no cursor (it's a periodic snapshot, not a discrete
 * event stream -- see searchConsoleIngestion.ts), so "has it ever
 * ingested successfully" is instead evidenced by the presence of any
 * search_console_query signal row.
 */
async function checkSearchConsole(client: SupabaseClient): Promise<HealthItem> {
  try {
    const { count } = await client
      .from("signals")
      .select("id", { count: "exact", head: true })
      .eq("source", "search_console_query");
    if ((count ?? 0) > 0) {
      return { label: "Search Console", status: "HEALTHY", detail: `Verified live -- ${count} query signals ingested` };
    }
    return {
      label: "Search Console",
      status: "DEGRADED",
      detail: "Credentials wired, not yet verified against the real API",
    };
  } catch (err) {
    return { label: "Search Console", status: "DEGRADED", detail: errorMessage(err) };
  }
}

/**
 * Reads `integration_health` (previously a dead table -- see
 * docs/PROGRESS_LEDGER.md's inbound-engagement audit) for the inbound
 * sync's real attempt/success/error state. This is deliberately not the
 * same check as X's `checkCursorBackedIntegration` above: a cursor
 * existing only proves ingestion worked ONCE, ever -- it can't tell a
 * caller "the last three attempts failed silently," which is exactly the
 * gap that lets a broken sync present as a merely-empty (not visibly
 * broken) inbound queue.
 */
async function checkInboundSync(client: SupabaseClient): Promise<HealthItem> {
  try {
    const { data } = await client
      .from("integration_health")
      .select("last_attempted_at, last_success_at, last_error")
      .eq("platform", "x_inbound")
      .maybeSingle();
    if (!data) {
      return { label: "Inbound Engagement", status: "NOT_CONNECTED", detail: "Never synced yet -- runs daily via /api/daily-pipeline" };
    }
    const row = data as { last_attempted_at: string | null; last_success_at: string | null; last_error: string | null };
    if (row.last_error) {
      return { label: "Inbound Engagement", status: "DOWN", detail: `Last attempt failed (${row.last_attempted_at}): ${row.last_error}` };
    }
    if (!row.last_success_at) {
      return { label: "Inbound Engagement", status: "DEGRADED", detail: `Attempted at ${row.last_attempted_at}, no confirmed success yet` };
    }
    return { label: "Inbound Engagement", status: "HEALTHY", detail: `Verified live -- last synced ${row.last_success_at}` };
  } catch (err) {
    return { label: "Inbound Engagement", status: "DOWN", detail: errorMessage(err) };
  }
}

/** Same real attempt/success/error evidence as checkInboundSync above, keyed to Prospecting's own integration_health row -- a search failure (rate limit, expired token, etc.) must be visible here, not silently presented as "just an empty/thin queue today." */
async function checkProspectingSync(client: SupabaseClient): Promise<HealthItem> {
  try {
    const { data } = await client
      .from("integration_health")
      .select("last_attempted_at, last_success_at, last_error")
      .eq("platform", "prospecting")
      .maybeSingle();
    if (!data) {
      return { label: "Prospecting", status: "NOT_CONNECTED", detail: "Never synced yet -- runs daily via /api/daily-pipeline" };
    }
    const row = data as { last_attempted_at: string | null; last_success_at: string | null; last_error: string | null };
    if (row.last_error) {
      return { label: "Prospecting", status: "DOWN", detail: `Last attempt failed (${row.last_attempted_at}): ${row.last_error}` };
    }
    if (!row.last_success_at) {
      return { label: "Prospecting", status: "DEGRADED", detail: `Attempted at ${row.last_attempted_at}, no confirmed success yet` };
    }
    return { label: "Prospecting", status: "HEALTHY", detail: `Verified live -- last synced ${row.last_success_at}` };
  } catch (err) {
    return { label: "Prospecting", status: "DOWN", detail: errorMessage(err) };
  }
}

/**
 * Growth loop item 8 (2026-09-18): a real, bounded, read-only probe of
 * Search Console -- checkSearchConsole() above only ever looks at whether
 * a `signals` row exists from some PAST ingestion, never actually calls
 * the live API. This calls it right now: resolves the verified property,
 * pulls the last 7 days' top queries (rowLimit small and fixed -- this is
 * a verification probe, not a real ingestion run), and reports exactly
 * what happened. Read-only by construction (SearchConsoleAdapter has no
 * write method at all) -- never rotates the OAuth token's scope or
 * touches property permissions, only refreshes the access token via the
 * normal OAuth refresh flow if it's expired, same as every other call.
 */
export async function verifySearchConsoleLive(client: SupabaseClient): Promise<Record<string, unknown>> {
  const startedAt = new Date();
  try {
    const adapter = createSearchConsoleAdapter(client);
    const property = await adapter.resolveSiteUrl(startedAt);
    const endDate = startedAt.toISOString().slice(0, 10);
    const startDate = new Date(startedAt.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows = await adapter.fetchTopQueries(property, startDate, endDate, 10, startedAt);
    return {
      status: "HEALTHY",
      property,
      startDate,
      endDate,
      rowCount: rows.length,
      freshness: `queried through ${endDate}`,
      checkedAt: startedAt.toISOString(),
    };
  } catch (err) {
    return { status: "DOWN", error: errorMessage(err), checkedAt: startedAt.toISOString() };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAppAuth(req, res)) return;
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (req.query.verify === "search_console") {
    const client = getServiceClient();
    const result = await verifySearchConsoleLive(client);
    res.status(200).json(result);
    return;
  }

  const health: HealthItem[] = [];
  const client = getServiceClient();

  try {
    const { error, count } = await client.from("system_jobs").select("id", { count: "exact", head: true });
    if (error) throw error;
    health.push({ label: "Supabase", status: "HEALTHY", detail: "fillbook-growth-os project, live" });

    const { count: deadLetterCount } = await client
      .from("system_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "dead_letter");

    health.push({
      label: "Job queue",
      status: (deadLetterCount ?? 0) > 0 ? "DEGRADED" : "HEALTHY",
      detail: `${count ?? 0} total jobs, ${deadLetterCount ?? 0} dead-lettered`,
    });
  } catch (err) {
    health.push({ label: "Supabase", status: "DOWN", detail: errorMessage(err) });
  }

  health.push(checkAiProvider());
  health.push(
    await checkCursorBackedIntegration(
      client,
      "X",
      retiredStepSkip("x_mentions") ? ["x_mention", INBOUND_CURSOR_SOURCE] : "x_mention",
      "Credentials wired, not yet verified against the real API"),
  );
  health.push(await checkSearchConsole(client));
  // YouTube and TikTok signal ingestion were removed outright (see
  // api/ingest.ts) -- video distribution happens through Fliki, outside
  // this system -- so they are deliberately absent here rather than
  // permanently reporting "not yet verified" for adapters that no longer
  // exist.

  health.push(await checkInboundSync(client));
  health.push(await checkProspectingSync(client));
  try {
    health.push(...(await loadVideoHealth(client)));
  } catch (err) {
    health.push({ label: "Video loop", status: "DEGRADED", detail: errorMessage(err) });
  }

  res.status(200).json({ health });
}
