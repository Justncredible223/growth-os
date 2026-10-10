-- Live Host (2026-10-09). An AI character ("Tilt") that hosts the owner's
-- own live stream: it reads chat and answers out loud. Growth OS holds the
-- switch, the settings and the full record of what was heard and said; a
-- worker on the owner's PC renders the character and pushes the stream.
--
-- This is the one owner-approved exception to the External Write Firewall
-- (docs/EXTERNAL_WRITE_FIREWALL.md, "Live Host exception"). Every spoken
-- line is authorized by authorizeLiveHostSpeech() and lands in audit_logs
-- under its own class, so the audit check constraint gains that class here.
--
-- Additive only. The backend tolerates this migration not being applied
-- yet: the Live Host tab reports "not set up" instead of failing.

alter table audit_logs drop constraint if exists audit_logs_action_class_check;
alter table audit_logs add constraint audit_logs_action_class_check
  check (action_class in ('READ','INTERNAL_WRITE','EXTERNAL_DRAFT','EXTERNAL_WRITE','LIVE_HOST_SPEECH'));

-- Single-row settings, same shape as system_settings (migration 0006).
-- desired_state is the owner's switch: the worker only streams, and the
-- firewall only allows speech, while it is 'on'.
create table if not exists live_host_settings (
  id boolean primary key default true check (id = true),
  desired_state text not null default 'off' check (desired_state in ('on','off')),
  -- The YouTube live video the worker is streaming to; chat is read from it
  -- through the official Data API. Null means no YouTube chat.
  youtube_video_id text,
  -- TikTok has no official chat API (docs/TIKTOK_COMMENTS_BLOCKED.md). Chat
  -- is only read when the owner turns this on, through an unofficial reader
  -- running on the worker. Off by default.
  tiktok_chat_enabled boolean not null default false,
  tiktok_username text,
  -- Seconds of quiet before the host starts a segment on its own.
  idle_seconds integer not null default 45 check (idle_seconds between 15 and 600),
  -- The host stops drafting for the day once today's recorded spend
  -- (cost_events, all features) reaches this.
  daily_budget_usd numeric not null default 3 check (daily_budget_usd >= 0),
  updated_at timestamptz not null default now()
);
insert into live_host_settings (id) values (true) on conflict (id) do nothing;
alter table live_host_settings enable row level security;

create table if not exists live_host_sessions (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'live' check (status in ('live','ended')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_reason text,
  -- Set on every worker tick; the app shows the worker as offline when stale.
  last_heartbeat_at timestamptz not null default now(),
  worker_info jsonb not null default '{}'::jsonb,
  youtube_live_chat_id text,
  youtube_page_token text,
  youtube_next_poll_at timestamptz,
  last_utterance_at timestamptz,
  -- Which segment the host ran last, so segments rotate.
  last_segment text,
  created_at timestamptz not null default now()
);
create unique index if not exists live_host_sessions_one_live on live_host_sessions (status) where status = 'live';
alter table live_host_sessions enable row level security;

-- Everything the host said or was about to say.
create table if not exists live_host_utterances (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references live_host_sessions(id) on delete cascade,
  kind text not null check (kind in ('reply','segment')),
  segment text,
  spoken_text text not null,
  mood text not null default 'neutral',
  -- Optional on-screen card (for example a Roast My Trade card).
  card jsonb,
  mentions_fillbook boolean not null default false,
  status text not null default 'queued' check (status in ('queued','spoken','dropped')),
  created_at timestamptz not null default now(),
  spoken_at timestamptz
);
create index if not exists live_host_utterances_session_idx on live_host_utterances (session_id, created_at);
alter table live_host_utterances enable row level security;

-- Every chat message the host saw, and what became of it.
create table if not exists live_host_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references live_host_sessions(id) on delete cascade,
  platform text not null check (platform in ('youtube','tiktok')),
  external_id text not null,
  author_name text not null,
  body text not null,
  received_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','answered','skipped','blocked')),
  status_reason text,
  utterance_id uuid references live_host_utterances(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (platform, external_id)
);
create index if not exists live_host_messages_session_idx on live_host_messages (session_id, received_at);
create index if not exists live_host_messages_pending_idx on live_host_messages (session_id) where status = 'pending';
alter table live_host_messages enable row level security;
-- RLS enabled, no explicit policy -- service-role-only access, same
-- convention every other table in this project already follows.
