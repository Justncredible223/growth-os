-- Engagement assistant (2026-10-10). Helps the owner interact with OTHER creators' YouTube Shorts and TikTok
-- videos (a thoughtful comment, a like) to build reach for @FillbookHQ. Open-and-paste only: nothing here ever
-- posts to a platform. The owner opens the video, copies a draft, and posts it with their own tap; the app only
-- records that they did. See docs/ENGAGEMENT_ASSISTANT.md.
--
-- Additive and idempotent. The backend tolerates this migration not being applied yet: the Engage screen
-- reports "not set up" instead of failing.

-- Creators and search queries to discover YouTube videos from (YouTube Data API, API key, read-only).
create table if not exists engagement_watchlist (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('channel','query')),
  -- channel: a channel id (UC...) or an @handle. query: free-text search words.
  value text not null,
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, value)
);
alter table engagement_watchlist enable row level security;

-- The review queue: one row per video. YouTube metadata/statistics are cached API data, so rows older than 30
-- days (fetched_at) are purged by the backend (YouTube API Developer Policies).
create table if not exists engagement_items (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('youtube','tiktok')),
  external_id text not null,
  url text not null,
  title text not null,
  creator_id text not null,
  creator_name text not null,
  thumbnail_url text,
  description text,
  top_comments jsonb not null default '[]'::jsonb,
  stats jsonb,
  source text not null default 'pasted' check (source in ('watchlist','search','pasted')),
  status text not null default 'new' check (status in ('new','drafted','done','skipped')),
  -- [{ "id": "d1", "text": "..." }, ...]
  drafts jsonb not null default '[]'::jsonb,
  skip_reason text,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_id)
);
create index if not exists engagement_items_status_idx on engagement_items (status, created_at);
create index if not exists engagement_items_fetched_idx on engagement_items (fetched_at);
alter table engagement_items enable row level security;

-- Audit log: one row for every drafted / opened / copied / done / skipped action. Daily cap, minimum spacing and
-- the per-creator cooldown are computed from the 'done' rows. The outcome columns are the owner's manual notes.
create table if not exists engagement_actions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references engagement_items(id) on delete set null,
  platform text not null check (platform in ('youtube','tiktok')),
  external_id text not null,
  creator_id text not null,
  creator_name text,
  kind text not null check (kind in ('drafted','opened','copied','done','skipped')),
  did text check (did in ('commented','liked','both')),
  draft_id text,
  draft_text text,
  final_text text,
  got_reply boolean,
  profile_visits integer check (profile_visits is null or profile_visits >= 0),
  outcome_note text,
  outcome_logged_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists engagement_actions_created_idx on engagement_actions (created_at);
create index if not exists engagement_actions_kind_idx on engagement_actions (kind, created_at);
create index if not exists engagement_actions_creator_idx on engagement_actions (platform, creator_id, created_at);
alter table engagement_actions enable row level security;

-- Every YouTube Data API call this feature makes, in quota units, so the daily budget guard survives restarts.
-- day is the Pacific-time date (YouTube's quota resets at midnight Pacific).
create table if not exists engagement_quota_ledger (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  endpoint text not null,
  units integer not null check (units >= 0),
  created_at timestamptz not null default now()
);
create index if not exists engagement_quota_ledger_day_idx on engagement_quota_ledger (day);
alter table engagement_quota_ledger enable row level security;
-- RLS enabled, no explicit policy -- service-role-only access, same convention every other table follows.
