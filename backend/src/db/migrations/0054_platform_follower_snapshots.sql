-- Daily follower counts for the other platforms (2026-10-15), next to x_follower_snapshots (0053).
--
-- YouTube is read once a day from the public channel statistics by the daily pipeline. TikTok and Instagram have no read
-- access for this, so the owner types the number in (POST approvals?resource=posting, action record-followers). One row per
-- platform per Arizona day; a second entry on the same day replaces the first.
--
-- Additive and idempotent. The backend tolerates this migration not being applied yet.
-- Growth OS migrations have no runner: the owner pastes this in the Supabase SQL editor.

create table if not exists platform_follower_snapshots (
  platform text not null check (platform in ('youtube', 'tiktok', 'instagram')),
  day date not null,
  followers integer not null,
  source text not null default 'api',
  captured_at timestamptz not null default now(),
  primary key (platform, day)
);
alter table platform_follower_snapshots enable row level security;
