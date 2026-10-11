/**
 * Episode report: what the Live Host recorded for the last few streams, compared with the one before, plus the
 * platform numbers that only YouTube Studio and the site's analytics have (printed as a fill-in section, never
 * invented).
 *
 *   npm run live-host:report [-- --limit 5]
 */
export {};

const baseUrl = (process.env.GROWTH_OS_BASE_URL ?? "https://fillbook-growth-os.vercel.app").replace(/\/$/, "");
const token = process.env.GROWTH_OS_AUTOMATION_TOKEN ?? "";
if (token.length < 32) {
  console.error("GROWTH_OS_AUTOMATION_TOKEN is not set (backend/.env.local).");
  process.exit(1);
}
const limitIndex = process.argv.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) || 5 : 5;

const res = await fetch(`${baseUrl}/api/approvals?resource=live-host`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    ...(process.env.GROWTH_OS_PROTECTION_BYPASS_SECRET ? { "x-vercel-protection-bypass": process.env.GROWTH_OS_PROTECTION_BYPASS_SECRET } : {}),
  },
  body: JSON.stringify({ action: "report", limit }),
});
if (!res.ok) {
  console.error(`Growth OS answered HTTP ${res.status}. If this is the first run after a change, the deploy may not be live yet.`);
  process.exit(1);
}
const report = (await res.json()) as {
  generatedAt: string;
  episodes: Array<{ sessionId: string; startedAt: string; minutes: number; linesSpoken: number; chatMessages: number; uniqueChatters: number; answeredMessages: number; fillbookMentions: number; spendThatDayUsd: number | null; segments: Record<string, number> }>;
  changeNotes: string[];
};

console.log(`Live Host episodes (${report.episodes.length}), newest first\n`);
for (const e of report.episodes) {
  const top = Object.entries(e.segments).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} x${v}`).join(", ") || "none";
  console.log(`${e.startedAt.slice(0, 16).replace("T", " ")}  ${String(e.minutes).padStart(3)} min  lines ${e.linesSpoken}  chat ${e.chatMessages} from ${e.uniqueChatters}  answered ${e.answeredMessages}  Fillbook mentions ${e.fillbookMentions}  spend that day ${e.spendThatDayUsd === null ? "n/a" : "$" + e.spendThatDayUsd.toFixed(2)}`);
  console.log(`   top segments: ${top}   session ${e.sessionId}`);
}
console.log("\nWhat to change next time");
for (const note of report.changeNotes) console.log(`  - ${note}`);
console.log(`
Fill in from YouTube Studio / site analytics (not available to the Live Host, never estimated):
  impressions and click-through rate:   ____
  peak and average concurrent viewers:  ____
  average view duration / retention:    ____
  returning viewers:                    ____
  clicks on the tracked link (utm_campaign fillbook-live-*):  ____
  signups / free-plan starts attributed to youtube:           ____
  first meaningful product action (activation):               ____   (definition: see docs/fillbook-live-growth/ATTRIBUTION.md)
`);
