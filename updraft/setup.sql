-- Paste this whole thing into Supabase → SQL Editor → Run. One time only.

create table if not exists updraft_events (
  id uuid primary key,
  party text not null,          -- party code from the link (?party=lab)
  type text not null,           -- 'round' | 'build' | 'unbuild' | 'pickup' | 'crates' | 'warn' | 'climb' | 'done'
  data jsonb not null default '{}',
  who text,
  name text,
  created_at timestamptz not null default now()
);

create index if not exists updraft_events_party on updraft_events (party, created_at);

alter table updraft_events enable row level security;

drop policy if exists "players can read and write" on updraft_events;
create policy "players can read and write" on updraft_events
  for all using (true) with check (true);

alter publication supabase_realtime add table updraft_events;
