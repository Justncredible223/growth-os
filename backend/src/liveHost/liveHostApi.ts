import type { VercelRequest, VercelResponse } from "@vercel/node";
import { errorMessage } from "../lib/errorMessage.js";
import { getServiceClient } from "../lib/supabaseClient.js";
import {
  LiveHostActionError,
  getLiveHostStatus,
  isMissingLiveHostTables,
  markUtteranceSpoken,
  runLiveHostTick,
  setLiveHostDesiredState,
  updateLiveHostSettings,
  type LiveHostSettingsPatch,
  type TickInput,
} from "./liveHostHandlers.js";

/** The Live Host actions the PC worker performs with the automation token. Everything else on the resource is owner-only. */
const LIVE_HOST_WORKER_ACTIONS = new Set(["tick", "spoken"]);

/** True for the Live Host calls the automation token may make: reading status, and the worker's own tick/spoken. */
export function isLiveHostAutomationRequest(req: VercelRequest): boolean {
  if (req.query.resource !== "live-host") return false;
  if (req.method === "GET") return true;
  const action = (req.body as { action?: unknown } | undefined)?.action;
  return req.method === "POST" && typeof action === "string" && LIVE_HOST_WORKER_ACTIONS.has(action);
}

/**
 * `/api/approvals?resource=live-host` is the Live Host: the AI character that hosts the owner's own live stream
 * (see docs/LIVE_HOST.md). Routed from api/approvals.ts for the same reason as that file's other resources,
 * Vercel Hobby's function cap.
 *
 *   GET                                status for the Live Host tab (switch, worker, counts, chat and spoken lines)
 *   POST { action: "set-desired" }     the owner's on/off switch                         (app token only)
 *   POST { action: "update-settings" } YouTube video, TikTok chat, quiet time, budget    (app token only)
 *   POST { action: "tick" }            the PC worker's heartbeat: chat in, next line out (automation token allowed)
 *   POST { action: "spoken" }          the worker confirms a line was said               (automation token allowed)
 *
 * The switch and the settings are deliberately NOT reachable with the automation token: only the owner can turn
 * the host on, and the firewall only allows speech while it is on.
 */
export async function handleLiveHost(req: VercelRequest, res: VercelResponse): Promise<void> {
  const client = getServiceClient();

  if (req.method === "GET") {
    try {
      res.status(200).json(await getLiveHostStatus(client));
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = (req.body ?? {}) as {
      action?: string;
      desired?: string;
      settings?: LiveHostSettingsPatch;
      messages?: TickInput["messages"];
      busy?: boolean;
      workerInfo?: Record<string, unknown>;
      utteranceId?: string;
      outcome?: string;
    };
    switch (body.action) {
      case "set-desired":
        if (body.desired !== "on" && body.desired !== "off") {
          res.status(400).json({ error: 'Body must include { desired: "on" | "off" }' });
          return;
        }
        res.status(200).json({ settings: await setLiveHostDesiredState(client, body.desired) });
        return;
      case "update-settings":
        if (!body.settings || typeof body.settings !== "object") {
          res.status(400).json({ error: "Body must include { settings: {...} }" });
          return;
        }
        res.status(200).json({ settings: await updateLiveHostSettings(client, body.settings) });
        return;
      case "tick":
        res.status(200).json(
          await runLiveHostTick(client, {
            messages: Array.isArray(body.messages) ? body.messages : [],
            busy: body.busy === true,
            workerInfo: body.workerInfo && typeof body.workerInfo === "object" ? body.workerInfo : {},
          }),
        );
        return;
      case "spoken":
        if (!body.utteranceId) {
          res.status(400).json({ error: "Body must include { utteranceId: string }" });
          return;
        }
        await markUtteranceSpoken(client, body.utteranceId, body.outcome === "dropped" ? "dropped" : "spoken");
        res.status(200).json({ id: body.utteranceId, status: body.outcome === "dropped" ? "dropped" : "spoken" });
        return;
      default:
        res.status(400).json({ error: "action must be one of: set-desired, update-settings, tick, spoken" });
    }
  } catch (err) {
    if (err instanceof LiveHostActionError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (isMissingLiveHostTables(err)) {
      res.status(409).json({ error: "The Live Host is not set up yet: migration 0049_live_host.sql has not been applied." });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
}
