-- Paste this whole thing into Supabase → SQL Editor → Run. One time only.

create table if not exists mahj_events (
  id uuid primary key,
  night text not null,          -- night code from the link
  type text not null,           -- 'title' | 'player' | 'player_out' | 'round' | 'seats' | 'game' | 'game_del'
  data jsonb not null default '{}',
  who text,
  created_at timestamptz not null default now()
);

create index if not exists mahj_events_night on mahj_events (night, created_at);

alter table mahj_events enable row level security;

drop policy if exists "players can read and write" on mahj_events;
create policy "players can read and write" on mahj_events
  for all using (true) with check (true);

alter publication supabase_realtime add table mahj_events;
