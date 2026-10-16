-- Daily follower count for @FillbookHQ (2026-10-15).
--
-- Followers kept falling and nothing recorded follower numbers over time, so a loss could not be tied to a day, a reply, a
-- giveaway or a post. One row per Arizona calendar day, written by the x_followers step of api/growth-pulse.ts from the
-- /users/me call the run already makes. Line a loss up against x_own_posts (what was posted that day) and the reply log.
--
-- Additive and idempotent. The backend tolerates this migration not being applied yet: the step reports "skipped".
-- Growth OS migrations have no runner: the owner pastes this in the Supabase SQL editor.

create table if not exists x_follower_snapshots (
  day date primary key,
  followers integer not null,
  following integer,
  tweet_count integer,
  captured_at timestamptz not null default now()
);
alter table x_follower_snapshots enable row level security;
