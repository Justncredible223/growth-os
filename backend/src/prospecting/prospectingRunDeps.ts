import type { SupabaseClient } from "@supabase/supabase-js";
import { createRecordedLlmClient } from "../cost/recordedLlmClient.js";
import { getProspectingMonthSpendUsd, getTodayXSearchCount, getTodayXSearchSpendUsd } from "../cost/costTracking.js";
import { checkRelevanceCheap } from "./prospectingReplyWriter.js";
import type { ProspectingRunDeps } from "./prospectingSearch.js";

/**
 * The parts of a Prospecting search run that every caller wires the same way (scheduled run, owner-tapped "search now", and the
 * refill after a reply): the monthly spend gate, the pause switch, the daily search limit, and the cheap model relevance screen that
 * keeps posts that are not futures prop-firm or own-capital relevant from ever reaching the queue (2026-10-24).
 */
export function prospectingRunExtras(client: SupabaseClient): Pick<ProspectingRunDeps, "getMonthSpendUsd" | "isPaused" | "getTodaySearchCount" | "getTodaySearchSpendUsd" | "screenRelevance" | "watchlistIncludeVetted"> {
  let llm: ReturnType<typeof createRecordedLlmClient> | null = null;
  return {
    watchlistIncludeVetted: false,
    getMonthSpendUsd: () => getProspectingMonthSpendUsd(client),
    isPaused: async () => {
      const { data } = await client.from("system_settings").select("paused").eq("id", true).single();
      return data?.paused ?? false;
    },
    getTodaySearchCount: () => getTodayXSearchCount(client),
    getTodaySearchSpendUsd: () => getTodayXSearchSpendUsd(client),
    screenRelevance: (post) => {
      // Created on first use so a run that screens nothing never builds a model client; a missing key throws here and the run treats that as "relevant".
      llm ??= createRecordedLlmClient(client, { step: "prospecting-relevance-check", tier: "owner", context: { screenedAtDiscovery: true }, eventType: "prospecting_llm_call" });
      return checkRelevanceCheap(llm, { platform: "x", authorHandle: post.authorHandle, postText: post.postText, discoveryQuery: post.discoveryQuery });
    },
  };
}
