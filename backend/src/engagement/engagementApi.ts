import type { VercelRequest, VercelResponse } from "@vercel/node";
import { errorMessage } from "../lib/errorMessage.js";
import { getServiceClient } from "../lib/supabaseClient.js";
import {
  EngagementActionError,
  EngagementBlockedError,
  addLink,
  addWatch,
  discoverYoutube,
  draftItem,
  getEngagementStats,
  getEngagementStatus,
  isMissingEngagementTables,
  logOutcome,
  markDone,
  recordCopy,
  recordOpen,
  removeWatch,
  skipItem,
  toItemJson,
  type EngagementDeps,
} from "./engagementHandlers.js";

const NOT_SET_UP = "The engagement assistant is not set up yet: migration 0050_engagement_assistant.sql has not been applied.";

/**
 * `/api/approvals?resource=engagement` is the engagement assistant (docs/ENGAGEMENT_ASSISTANT.md). Routed from
 * api/approvals.ts for the same reason as that file's other resources: Vercel Hobby's function cap.
 *
 * Owner token only. api/approvals.ts never passes allowAutomation for this resource, so the automation token is
 * refused (and engagementApi.test.ts pins that). Nothing here posts to YouTube or TikTok: every action is the owner's
 * own tap, and "done" only records that they did it.
 *
 *   GET                      status + queue + watchlist + today's counts + quota
 *   GET  ?stats=1&days=14    counts per day/platform and the outcomes the owner logged
 *   POST { action: "add-watch" | "remove-watch" | "discover" | "add-link" | "draft" | "open" | "copy"
 *                  | "done" | "skip" | "outcome" }
 */
export async function handleEngagement(req: VercelRequest, res: VercelResponse, deps: EngagementDeps = {}): Promise<void> {
  const client = getServiceClient();

  if (req.method === "GET") {
    try {
      if (req.query.stats === "1") {
        const days = Number(req.query.days ?? 14);
        res.status(200).json(await getEngagementStats(client, Number.isFinite(days) ? days : 14, deps));
      } else {
        res.status(200).json(await getEngagementStatus(client, deps));
      }
    } catch (err) {
      if (isMissingEngagementTables(err)) {
        res.status(200).json({ configured: false, message: NOT_SET_UP });
        return;
      }
      res.status(500).json({ error: errorMessage(err) });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    switch (body.action) {
      case "add-watch":
        res.status(200).json({ entry: await addWatch(client, { kind: body.kind, value: body.value, label: body.label }, deps) });
        return;
      case "remove-watch":
        if (typeof body.id !== "string" || !body.id) throw new EngagementActionError("Body must include { id: string }");
        await removeWatch(client, body.id);
        res.status(200).json({ id: body.id, removed: true });
        return;
      case "discover":
        res.status(200).json(await discoverYoutube(client, deps));
        return;
      case "add-link":
        res.status(200).json({ item: toItemJson(await addLink(client, body.url, deps)) });
        return;
      case "draft":
        res.status(200).json({ item: toItemJson(await draftItem(client, body.id, deps)) });
        return;
      case "open":
        res.status(200).json(await recordOpen(client, body.id, deps));
        return;
      case "copy":
        res.status(200).json(await recordCopy(client, { id: body.id, draftId: body.draftId, text: body.text }, deps));
        return;
      case "done":
        res.status(200).json(await markDone(client, { id: body.id, did: body.did, draftId: body.draftId, finalText: body.finalText }, deps));
        return;
      case "skip":
        res.status(200).json(await skipItem(client, { id: body.id, reason: body.reason }, deps));
        return;
      case "outcome":
        res.status(200).json(await logOutcome(client, { actionId: body.actionId, gotReply: body.gotReply, profileVisits: body.profileVisits, note: body.note }, deps));
        return;
      default:
        res.status(400).json({ error: "action must be one of: add-watch, remove-watch, discover, add-link, draft, open, copy, done, skip, outcome" });
    }
  } catch (err) {
    if (err instanceof EngagementBlockedError) {
      res.status(429).json({ error: err.message, block: err.block });
      return;
    }
    if (err instanceof EngagementActionError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (isMissingEngagementTables(err)) {
      res.status(409).json({ error: NOT_SET_UP });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
}
