-- Run this once in the Supabase SQL editor (Dashboard > SQL Editor > New query).

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz default now()
);

create table if not exists picks (
  player_id uuid not null references players(id) on delete cascade,
  season int not null,
  week int not null,
  game_id text not null,
  team_id text not null,
  updated_at timestamptz default now(),
  primary key (player_id, season, week, game_id)
);

-- This is a family league, so the anon key may read and write freely.
-- The passcode in js/config.js is the only gate. Don't put anything private here.
alter table players enable row level security;
alter table picks enable row level security;

create policy "family can read players" on players for select using (true);
create policy "family can add players"  on players for insert with check (true);

create policy "family can read picks"   on picks for select using (true);
create policy "family can make picks"   on picks for insert with check (true);
create policy "family can change picks" on picks for update using (true);
