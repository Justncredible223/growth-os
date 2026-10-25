import type { VercelRequest, VercelResponse } from "@vercel/node";
import { errorMessage } from "../src/lib/errorMessage.js";
import { getServiceClient } from "../src/lib/supabaseClient.js";
import { SupabaseSignalRepository } from "../src/signals/supabaseSignalRepository.js";
import { SignalGraph } from "../src/signals/signalGraph.js";
import { createXSignalAdapter } from "../src/signals/adapters/xAdapter.js";
import { createSearchConsoleAdapter } from "../src/signals/adapters/searchConsoleAdapter.js";
import { SupabaseIngestionCursorStore } from "../src/signals/adapters/ingestionCursorStore.js";
import { ingestXMentions } from "../src/signals/adapters/xIngestion.js";
import { ingestSearchConsoleQueries } from "../src/signals/adapters/searchConsoleIngestion.js";
import { requireAppAuth, constantTimeEquals } from "../src/lib/requireAppAuth.js";
import { runProspectingSearch } from "../src/prospecting/prospectingSearch.js";
import { SupabaseProspectingRepository } from "../src/prospecting/supabaseProspectingRepository.js";
import { prospectingRunExtras } from "../src/prospecting/prospectingRunDeps.js";
import { recordSyncAttempt, recordSyncSuccess, recordSyncFailure } from "../src/lib/integrationHealth.js";
import { recordConversionEvent, CONVERSION_EVENT_TYPES, type ConversionEventType } from "../src/attribution/conversionEvents.js";
import { recordLinkClick, isAllowedRedirectTarget } from "../src/attribution/linkClicks.js";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The sources this endpoint can still trigger by hand. "x" and
 * "search_console" are Signal Graph ingestion sources; "x_prospecting" is
 * a different pipeline (finds new outreach candidates, not signals) folded
 * in here rather than as its own file -- see this file's own doc comment
 * on the Vercel Hobby 12-function cap. Added to close the gap
 * prospectingSearch.ts's ProspectingRunDeps doc comment used to name
 * directly: growth-pulse.ts's scheduled run was the only caller, so there
 * was no way to search for new candidates from the Android app between
 * scheduled slots.
 */
export const MANUAL_INGEST_SOURCES = ["x", "search_console", "x_prospecting"] as const;
export type ManualIngestSource = (typeof MANUAL_INGEST_SOURCES)[number];

export function isManualIngestSource(value: unknown): value is ManualIngestSource {
  return typeof value === "string" && (MANUAL_INGEST_SOURCES as readonly string[]).includes(value);
}

/**
 * Manual single-source trigger -- POST /api/ingest?source=x | search_console
 * | x_prospecting. Consolidated from separate endpoint files
 * (ingest-x-mentions.ts, ingest-search-console.ts) into one, because
 * Vercel's Hobby plan caps serverless functions per deployment at 12 and
 * this project hit it. The scheduled jobs (api/daily-pipeline.ts for
 * Search Console, api/growth-pulse.ts for X mentions/inbound/prospecting)
 * run all three sources automatically; this endpoint stays for triggering
 * just one by hand -- debugging, re-running after fixing an issue with one
 * adapter without waiting for the others, or (x_prospecting specifically)
 * the owner deliberately wanting fresh candidates right now instead of
 * waiting for the next 08:00/13:00/18:00 slot.
 *
 * YouTube and TikTok are gone from here for good, not just from the
 * schedule: the owner distributes video through Fliki, neither source
 * ever produced a signal the owner acted on, and keeping their adapters
 * reachable only from this manual path meant two integrations that
 * could never be verified but still showed up as "degraded" on the
 * health screen. Their adapter/ingestion modules and tests were removed
 * with this change; the `youtube_video`/`tiktok_video` signal source
 * values remain valid for the historical rows already in the database.
 */
/**
 * Public, unauthenticated short-link redirect -- GET /api/ingest?source=click
 * &key=<linkKey>&to=<targetUrl>. Has to stay reachable with no Authorization
 * header at all: the person clicking it is a stranger on X or a
 * partnership contact's inbox, not this project's own Android app.
 * `to` is checked against isAllowedRedirectTarget's strict host allowlist
 * before every redirect, so this can never become an open redirect. A
 * failure to log the click never blocks the redirect itself -- the
 * clicker still needs to land on FillbookHQ even if this project's own DB
 * write fails.
 */
async function handleLinkClickRedirect(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const linkKey = typeof req.query.key === "string" ? req.query.key : null;
  const target = typeof req.query.to === "string" ? req.query.to : null;
  if (!linkKey || !target || !isAllowedRedirectTarget(target)) {
    res.status(400).json({ error: "Missing or invalid 'key'/'to' query params" });
    return;
  }

  try {
    const client = getServiceClient();
    await recordLinkClick(client, {
      linkKey,
      targetUrl: target,
      referer: typeof req.headers.referer === "string" ? req.headers.referer : null,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    });
  } catch {
    // See doc comment above -- logging failures must never block the redirect.
  }

  res.writeHead(302, { Location: target });
  res.end();
}

function isConversionEventType(v: unknown): v is ConversionEventType {
  return typeof v === "string" && (CONVERSION_EVENT_TYPES as string[]).includes(v);
}

/**
 * Server-to-server webhook from FillbookHQ -- POST
 * /api/ingest?source=fillbook_signup, body `{ event_type, external_event_id,
 * subject_hash, utm_*, event_touch_utm_*, referral_code, occurred_at }`.
 *
 * Growth loop (2026-09-18): now called from FillbookHQ's own SERVER-side
 * sync cron (`frontend/src/lib/growthOsSync.ts` + its Vercel Cron endpoint
 * on FillbookHQ's project), not a client-side fetch -- the previous
 * client-beacon approach (growthOs.ts's notifyGrowthOsSignup, now removed)
 * shipped FILLBOOK_WEBHOOK_SECRET in FillbookHQ's browser bundle, which a
 * server-side caller no longer needs to. Every event_type
 * (signup/activation/first_trade/first_paid) shares this one endpoint
 * rather than four, same "one authenticated boundary" reasoning as
 * api/approvals.ts's ?resource= dispatch.
 *
 * Gated by FILLBOOK_WEBHOOK_SECRET -- the entire blast radius of an
 * abused secret is "someone can insert fake rows into this project's own
 * conversion_events table," never a read or write into FillbookHQ's
 * database (see docs/ARCHITECTURE.md's isolation goal), and never any
 * PII: only utm_*, referral_code, a pseudonymous subject_hash, and a
 * timestamp are ever accepted, no email/user_id.
 */
async function handleFillbookSignupWebhook(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const secret = process.env.FILLBOOK_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: "FILLBOOK_WEBHOOK_SECRET is not configured on the server" });
    return;
  }
  const header = req.headers.authorization;
  if (!header || !constantTimeEquals(header, `Bearer ${secret}`)) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const eventType = isConversionEventType(body.event_type) ? body.event_type : "signup";

  try {
    const client = getServiceClient();
    const result = await recordConversionEvent(client, {
      source: "fillbook_signup",
      eventType,
      externalEventId: str(body.external_event_id),
      subjectHash: str(body.subject_hash),
      utmSource: str(body.utm_source),
      utmMedium: str(body.utm_medium),
      utmCampaign: str(body.utm_campaign),
      utmContent: str(body.utm_content),
      eventTouchUtmSource: str(body.event_touch_utm_source),
      eventTouchUtmMedium: str(body.event_touch_utm_medium),
      eventTouchUtmCampaign: str(body.event_touch_utm_campaign),
      eventTouchUtmContent: str(body.event_touch_utm_content),
      referralCode: str(body.referral_code),
      occurredAt: str(body.occurred_at) ?? new Date().toISOString(),
    });
    res.status(200).json({ recorded: true, inserted: result.inserted });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const source = req.query.source;

  if (source === "click") {
    await handleLinkClickRedirect(req, res);
    return;
  }
  if (source === "fillbook_signup") {
    await handleFillbookSignupWebhook(req, res);
    return;
  }

  if (!requireAppAuth(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!isManualIngestSource(source)) {
    res.status(400).json({ error: `Query param 'source' must be one of: ${MANUAL_INGEST_SOURCES.join(", ")}` });
    return;
  }

  try {
    const client = getServiceClient();
    const signalGraph = new SignalGraph(new SupabaseSignalRepository(client));

    if (source === "x") {
      const adapter = createXSignalAdapter(client);
      const cursorStore = new SupabaseIngestionCursorStore(client);
      const userId = await adapter.resolveOwnUserId();
      const signals = await ingestXMentions(adapter, signalGraph, cursorStore, userId);
      res.status(200).json({ ingested: signals.length });
      return;
    }

    if (source === "x_prospecting") {
      await recordSyncAttempt(client, "prospecting");
      try {
        const adapter = createXSignalAdapter(client);
        const repo = new SupabaseProspectingRepository(client);
        const now = new Date();
        const result = await runProspectingSearch({
          adapter,
          repo,
          client,
          ...prospectingRunExtras(client),
          now,
          // Manual trigger: pick a topic slice independent of the current
          // scheduled slot so hitting "search now" right before/after a
          // scheduled run still has a real chance of surfacing something
          // new instead of re-running the exact same 2 topics.
          runIndexOverride: Math.floor(Math.random() * 1_000_000),
        });
        if (result.skipped) {
          await recordSyncSuccess(client, "prospecting", `manual run skipped -- ${result.skipReason}`);
        } else {
          await recordSyncSuccess(client, "prospecting", `manual run: ${result.newCandidates} new, ${result.postsRead} read`);
        }
        res.status(200).json({ result });
        return;
      } catch (err) {
        await recordSyncFailure(client, "prospecting", errorMessage(err));
        throw err;
      }
    }

    // source === "search_console"
    const adapter = createSearchConsoleAdapter(client);
    const siteUrl = await adapter.resolveSiteUrl();
    const now = new Date();
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() - 3);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 7);
    const signals = await ingestSearchConsoleQueries(adapter, signalGraph, siteUrl, isoDate(startDate), isoDate(endDate), now);
    res.status(200).json({ ingested: signals.length, siteUrl });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}
