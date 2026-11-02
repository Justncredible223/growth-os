# Fillbook Growth OS — Architecture (v0.1, Phase 0)

## What this is

An Android "Mission Control" app + cloud backend that finds organic growth
opportunities for Fillbook (fillbookhq.com), drafts platform-native content
and video for them, and hands every external action to the human owner
(Justin) to personally publish. It never posts, replies, likes, follows, or
DMs on its own. See `docs/EXTERNAL_WRITE_FIREWALL.md`.

## Relationship to Fillbook

Fillbook Growth OS is a **separate repo and separate deployment** from the
Fillbook product repo (`C:\Users\Justin\fillbookhq`, GitHub
`Justncredible223/fillbook`). It reads from Fillbook (its public site, its
Search Console property, aggregated/anonymized product signals) but does not
share a codebase or a production database with it. This keeps a mistake in
Growth OS from ever being able to touch the paying product's data path.

Fillbook today (as of 2026-08-31, for sizing decisions — verify before
relying on this later): 3 real signups, 1 paying customer, Vercel Hobby tier,
small Supabase project. Growth OS is deliberately **right-sized to this
stage** — see "Build sequencing" below — not built as if Fillbook were a
funded, high-traffic company.

## Build sequencing (core first, expand later)

The master spec calls for 30+ subsystems. Building all of them before any of
them work end-to-end would be a mistake at this company stage. Sequencing:

**Core spine (Phases 0-7, build now):**
1. Data foundation (this phase) + Platform Capability Registry
2. Job infrastructure (Supabase-table-backed queue, not a separate message
   broker — right-sized for current volume)
3. Knowledge Brain + Brand Constitution (seeded from real `fillbookhq` docs)
4. Signal Graph (start with Search Console + public web signals — the
   sources that need no new OAuth app approvals)
5. Opportunity Engine
6. Campaign Factory + content review agents + ExternalWriteFirewall
7. Android Mission Control (Home, Radar, Approvals, minimum viable)

**Expansion (later phases, only after the spine is proven with real use):**
Video Factory, X/TikTok/YouTube integrations, SEO/Search Console depth,
Creator CRM, Research Lab, Attribution, Experiments, Growth Genome, Strategy
Evolution, Cost Intelligence, full Android polish (Analytics/Library/
Research/Creators/Strategy/System screens).

Each phase is recorded in `docs/PROGRESS_LEDGER.md` with status, tests, and
blockers, so work resumes safely across sessions without re-deriving context.

## Seeded from real prior work

Fillbook's repo already contains a manual growth practice (not a
prototype — real accounts, real posts, real findings). Growth OS imports
this as day-one data rather than starting cold:

- Brand voice, forbidden claims, positioning rules ← `docs/social/MASTER_SOCIAL_STRATEGY.md`
- Creator relationship ledger ← `docs/social/CREATOR_NETWORK.md`
- Platform policy findings (e.g. TikTok Promote is account-level blocked for
  `@fillbookhq`) ← `docs/CLAUDE_HANDOFF.md`
- The human-only-publish rule already exists as working practice, not just
  spec — Growth OS's ExternalWriteFirewall formalizes what Justin already
  does manually.

See `docs/SEED_DATA_SOURCES.md` for the exact mapping of doc → table.

## Tech stack

- **Backend**: Node.js + TypeScript, deployed as Vercel serverless functions
  (matches Fillbook's existing hosting relationship/expertise; separate
  Vercel project). Vitest for tests (matches Fillbook's existing tooling).
- **Database**: Supabase Postgres, **new dedicated project** (not Fillbook's
  production DB). Migrations as plain numbered SQL files, applied via the
  Supabase MCP tooling.
- **Jobs**: `system_jobs` table + a Vercel Cron-triggered worker endpoint,
  polling with `SELECT ... FOR UPDATE SKIP LOCKED`. This is a deliberately
  simple durable queue — no separate message broker until real volume
  justifies one.
- **Android**: Kotlin + Jetpack Compose, native (not Capacitor — Fillbook's
  own untracked `frontend/android` Capacitor scaffold is unrelated and is
  not reused here).
- **AI**: provider-agnostic call layer from day one (model per workload,
  cost/latency/quality tracked) — see `backend/src/lib/ai/`.

## Non-negotiable safety boundary

See `docs/EXTERNAL_WRITE_FIREWALL.md`. Enforced server-side in
`backend/src/firewall/`, with tests proving every EXTERNAL_WRITE class is
rejected. This is not a UI setting and has no override.

## Known open items inherited from Fillbook (not Growth OS bugs, but Growth OS should be aware)

- Vercel MCP access was returning 403 as of 2026-08-31 — don't assume
  Vercel API deploy-verification works until rechecked.
- UTM attribution gap: TikTok/X traffic shows as 0 in Fillbook's own
  dashboard (suspected in-app-browser UTM stripping, unconfirmed). Growth OS's
  Attribution Engine (later phase) should treat this as a known-broken input
  until Fillbook's own tracking is fixed — do not build on top of it
  silently.
