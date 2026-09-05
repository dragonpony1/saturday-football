-- Full schema for a fresh install. Run once in the Supabase SQL editor
-- (Dashboard > SQL Editor > New query). Existing projects were migrated
-- to this shape on 2026-09-05.

create table if not exists leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  passcode text not null unique,
  pick_mode text not null default 'all', -- all | ranked | big12ranked | main
  icon text not null default '🏈',
  icon_url text, -- optional league photo, stored in the public 'league-pics' bucket
  created_at timestamptz default now()
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id),
  name text not null,
  last_seen timestamptz,
  last_via text, -- 'home screen' or 'browser', from the open-app ping
  created_at timestamptz default now(),
  unique (league_id, name)
);

create table if not exists picks (
  player_id uuid not null references players(id) on delete cascade,
  league_id uuid not null references leagues(id),
  season int not null,
  week int not null,
  game_id text not null,
  team_id text not null,
  updated_at timestamptz default now(),
  primary key (player_id, season, week, game_id)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);

-- Family-style app: the anon key may read and write freely. Leagues are
-- "closed" only by their passcode. Don't put anything private here.
alter table leagues enable row level security;
alter table players enable row level security;
alter table picks enable row level security;

create policy "anyone can find a league"  on leagues for select using (true);
create policy "anyone can start a league" on leagues for insert with check (true);

create policy "family can read players"   on players for select using (true);
create policy "family can add players"    on players for insert with check (true);
create policy "family can rename players" on players for update using (true);

create policy "family can read picks"   on picks for select using (true);
create policy "family can make picks"   on picks for insert with check (true);
create policy "family can change picks" on picks for update using (true);

alter table messages enable row level security;
create policy "family can read chat"  on messages for select using (true);
create policy "family can write chat" on messages for insert with check (true);
