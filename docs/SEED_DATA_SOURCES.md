# Seed Data Sources

Synthesis of FillbookHQ's existing (real, not prototype) growth practice,
captured 2026-08-31 from `C:\Users\Justin\fillbookhq`. This is the day-one
data for `brand_rules`, `platform_capabilities`, and `knowledge_documents`
once the database exists (see Phase 1 blocker in `docs/PROGRESS_LEDGER.md`).
Treat facts below as true as of 2026-08-31 — re-verify anything
time-sensitive (follower counts, paid-customer count, platform policy
status) before relying on it later.

## Product facts → `knowledge_documents`

- Fillbook: trading journal for **futures day traders and prop-firm funded
  accounts** (broker/platform import, futures-native P&L, prop-firm
  drawdown/rule tracking, AI coach). Positioned against TradeZella/TradesViz
  (broker-agnostic/stock-first).
- Domain: `fillbookhq.com`.
- Stack: React+TS+Tailwind frontend, Vercel serverless functions, Supabase
  (Postgres+Auth+Storage), RLS per trader. Hosting: Vercel, auto-deploy on
  push to `main`, **Hobby plan** (already hit the 12-function cap once).
- Pricing: Free (50 trades/1 account), Pro $14.99/mo, Elite $24.99/mo,
  7-day trial via Stripe Checkout.
- Scale as of 2026-08-31: 8 Supabase users, 3 real external signups, 1
  paying customer (Elite). 828 trades logged, 967 analytics events since
  2026-08-25.
- Source: `fillbookhq/README.md`, `fillbookhq/docs/CLAUDE_HANDOFF.md`.

## Brand Constitution → `brand_rules`

| rule_type | content | source_doc |
|---|---|---|
| positioning | Broad futures product, not MNQ/NQ-only — every piece of content checked against this misreading. | docs/CLAUDE_HANDOFF.md |
| positioning | Fillbook is a trading journal / analytics / futures / prop-firm-oriented product, not primarily a copy-trading product (though useful to multi-account/copy traders). | master prompt + docs/social/MASTER_SOCIAL_STRATEGY.md |
| voice | Concise, intelligent, relatable, trader-aware, slightly sharp when appropriate, useful. | docs/social/MASTER_SOCIAL_STRATEGY.md |
| vocabulary_prohibited | Corporate SaaS language, excessive em dashes, generic motivation, AI clichés, engagement bait, forced controversy. | docs/social/MASTER_SOCIAL_STRATEGY.md |
| claim_prohibited | Fillbook must never speak or be shown as if it personally trades — no fake personal trading story, ever. | docs/social/MASTER_SOCIAL_STRATEGY.md |
| claim_prohibited | Any trading data shown must be labeled example/demo data unless it's real, consenting-user data. | docs/social/MASTER_SOCIAL_STRATEGY.md |
| cta_philosophy | Product shown = evidence of a mechanism, never a feature list; product ≠ advertisement. | docs/social/MASTER_SOCIAL_STRATEGY.md |
| competitor_rule | A creator having competitive association (e.g. promoting TradeZella) does not automatically disqualify them from outreach — goal is ecosystem understanding, not purity-testing. Explicit affiliate-code pushing is a hard rejection reason. | docs/social/CREATOR_NETWORK.md |
| disclosure_rule | Never assert an account is "shadowbanned" without evidence. | docs/social/MASTER_SOCIAL_STRATEGY.md |
| financial_claim_restriction | Every claim classified VERIFIED FACT / EVIDENCE-SUPPORTED OBSERVATION / REASONABLE HYPOTHESIS / OPINION; never promote hypothesis/opinion into fact. | docs/social/MASTER_SOCIAL_STRATEGY.md |

Content mix guideline (not a hard rule, a target; revised 2026-10-15 because the
account keeps losing followers): 25% useful education, 25% relatable trader
psychology, 25% product functionality/demos, 15% conversation starters, 10%
direct promo/CTA -- product_demo + cta is 35% (it was 55%). Education,
psychology and conversation posts do not need a Fillbook clause. History: the
mix below was the majority-product share on purpose. (Raised twice 2026-09-21: first from 20%/5% to
25%/10% product-demo/CTA -- the business is actively growing, not just
building audience goodwill, and the writer's own voice rules were found to
structurally cancel out the CTA category regardless of this target; see
humanReplyVoice.ts's HUMAN_POST_VOICE_RULES -- then to 35%/20% once the owner
clarified the bar: both X posts and video scripts should be mainly about
Fillbook itself -- what it does, how it helps, and how to use it.)

Forbidden tactics (maps directly to `EXTERNAL_WRITE`/anti-slop rejection
reasons, not just brand color): purchased followers/engagement, engagement
pods, bot networks, fake testimonials/results, misleading claims, hashtag
spam, trending-topic hijacking, shadowban-evasion, disguising automation as
human activity.

## Platform Capability Registry → `platform_capabilities`

| platform | capability | status | notes | source |
|---|---|---|---|---|
| tiktok | promote_ads | blocked | Account-level classification ("Prohibited Industry - Financial Opportunity") confirmed via two rejected test videos — one normal, one stripped of all $ amounts/%/trading hashtags. Not fixable by wording; business verification already on. Real paths: TikTok Ads Manager financial-services vertical approval, or stay fully organic. | docs/CLAUDE_HANDOFF.md |
| tiktok | organic_post | implemented (manual) | 7 videos live, ~500 combined views, `@fillbookhq`. Owner uploads manually via TikTok app/Studio; Growth OS should stage the rendered video + caption, never auto-upload. | docs/CLAUDE_HANDOFF.md |
| tiktok | profile_scan_logged_out | unreliable | Logged-out viewer sees a generic "suggested accounts" wall, not the real video grid — previously misread as "0 videos" when 7 were live. Always verify via logged-in session. | docs/CLAUDE_HANDOFF.md |
| x | organic_post | implemented (manual) | `@FillbookHQ`, 46 posts. ~1 post/day + 1-2 replies/day is directional cadence, not a mechanical quota. | docs/CLAUDE_HANDOFF.md |
| youtube | shorts_upload | implemented (manual) | `@FillbookHQ`, 6 Shorts live (5-41 views each). | docs/CLAUDE_HANDOFF.md |
| x / tiktok | utm_attribution | broken/unconfirmed | FillbookHQ's own dashboard shows **zero** attributed TikTok/X visitors despite real traffic; suspected in-app-browser UTM stripping, unconfirmed. Growth OS's Attribution Engine (later phase) must not build on this silently — treat as a known-broken input until FillbookHQ fixes its own tracking. | docs/CLAUDE_HANDOFF.md |
| discord | join_new_account | blocked (unconfirmed cause) | A brand-new Fillbook Discord account is silently blocked from joining a target server (hCaptcha clears, join still fails) — attributed to anti-spam trust flagging a same-day account. Decision made: wait it out. | docs/CLAUDE_HANDOFF.md |

All rows above need `verified_at` set to when this was captured
(2026-08-31) and `source_url` — the docs above are internal notes, not
official policy URLs; **before Phase 9/11/12 (X/YouTube/TikTok
integration) actually build anything, re-verify against the platforms'
current official developer docs per the master spec's requirement**, don't
just trust these internal notes as the final word on current policy.

## Creator Network → `creators` / `creator_interactions` (Phase 14, not yet in schema)

Relationship-readiness scale (0-10): 0 Discovered → 1 Vetted → 2 Interacted
once → ... → 10 Organic advocate. Never skip stages; never advance without a
logged, evidence-based interaction.

Tier B (active, score 2 each, one confirmed interaction): @RisenTrade/Coach R,
@MSroad2millions, @wannabechamp, @fxgolfer, @Saint4423898285,
@StructureXTime, Degen Rehab (YouTube).

Research-next (unvetted): @gatietrades (TikTok 47.8K, also promotes
TradeZella), @ItsJayCook, @AthenTrades, Market Mamas (YouTube), Her Trading
Journal (YouTube 95.9K), Prop Firm Match, Trading Psychology Lab (copycat-handle
warning), RoadToFunded, God of Finance, AbduTrades, retiredby30.

Rejected (10 entries, reasons): affiliate/discount-code accounts,
signal-selling, Telegram-channel pushers, AI content farms, tip-jar/cash-app
accounts. Full detail in `fillbookhq/docs/social/CREATOR_NETWORK.md` — import
verbatim when Phase 14 schema exists, don't re-derive.

## Known-stale items — do not seed these, they were corrected

- "5 paid profiles" → corrected to 3 real signups, 1 paying customer.
- Dashboard SIGNUPS/ACTIVATED counts include internal/test accounts — raw
  `signup_completed` event count is closer to truth. Unfixed P2 in
  FillbookHQ itself.
- "TikTok 0 videos" was a stale logged-out read; actually 7 live.
- "YouTube Shorts not yet confirmed" was wrong; 6 were live.
- A "7-Day Social Content Plan" was referenced as the primary active
  content track but **does not exist as a persisted file** in the repo —
  don't assume it's real; reconstruct from scratch if Growth OS needs it.

## Gaps the spine phases should plan for

- No `user_activated` event exists yet in FillbookHQ (proposed definition:
  5-trade Edge Score threshold, not implemented). Growth OS's funnel
  instrumentation (later phase) needs FillbookHQ to ship this first, or
  Growth OS must define its own proxy and label it clearly as a proxy.
- No automated video pipeline exists today — current process is manual
  CLI steps (`edge-tts` + ffmpeg + hand-written `.ass` captions), documented
  in `fillbookhq/docs/social/VIDEO_PRODUCTION_WORKFLOW.md`. Phase 10 (Video
  Factory) should industrialize this exact pipeline, not invent a different
  one — it's already been debugged (e.g. `drawtext` segfaults, raw
  `.srt`+`force_style` clips/blanks — both are known dead ends).
