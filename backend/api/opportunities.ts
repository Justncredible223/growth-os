import type { VercelRequest, VercelResponse } from "@vercel/node";
import { errorMessage } from "../src/lib/errorMessage.js";
import { getServiceClient } from "../src/lib/supabaseClient.js";
import { SupabaseOpportunityRepository } from "../src/opportunities/supabaseOpportunityRepository.js";
import { requireAppAuth } from "../src/lib/requireAppAuth.js";
import { draftOpportunityReply, OpportunityReplyError } from "../src/opportunities/opportunityReplyWriter.js";
import { loadGroundingContext } from "../src/inbound/inboundHandlers.js";
import { createRecordedLlmClient } from "../src/cost/recordedLlmClient.js";

/**
 * GET: the existing opportunity list.
 *
 * POST { action: 'draft-reply', opportunityId }: the lightweight
 * engagement-reply path (see opportunityReplyWriter.ts) -- one real LLM
 * call, never the multi-agent campaign pipeline. Stateless: nothing is
 * written to the database here, the draft is only ever returned to the
 * caller for review. Folded into this file rather than a new endpoint
 * because this project is already at Vercel Hobby's 12-function cap
 * (same reasoning as api/approvals.ts's ?resource=inbound).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAppAuth(req, res)) return;
  const client = getServiceClient();

  if (req.method === "POST") {
    try {
      const body = req.body as { action?: string; opportunityId?: string } | undefined;
      if (body?.action !== "draft-reply" || !body.opportunityId) {
        res.status(400).json({ error: "Body must be { action: 'draft-reply', opportunityId: string }" });
        return;
      }

      const { brandRulesSummary, verifiedKnowledgeSummary } = await loadGroundingContext(client);
      const llmClient = createRecordedLlmClient(client, { step: "opportunity-reply-draft", tier: "owner", context: { opportunityId: body.opportunityId } });

      const draft = await draftOpportunityReply(client, llmClient, body.opportunityId, brandRulesSummary, verifiedKnowledgeSummary);
      res.status(200).json({ draft });
    } catch (err) {
      if (err instanceof OpportunityReplyError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: errorMessage(err) });
    }
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const repo = new SupabaseOpportunityRepository(client);
    const opportunities = await repo.listOpen();
    res.status(200).json({ opportunities });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}
