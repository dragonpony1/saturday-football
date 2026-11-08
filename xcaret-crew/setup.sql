-- Paste this whole thing into Supabase → SQL Editor → Run. One time only.

create table if not exists trip_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null,            -- 'plan' | 'idea' | 'note' | 'info'
  day text,                      -- '2026-11-08' etc. for plans
  slot text,                     -- 'Morning', 'Dinner', … (or info key)
  time text,                     -- optional, e.g. '6:00 PM'
  body text not null,
  who text,
  votes text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table trip_items enable row level security;

drop policy if exists "crew can read and write" on trip_items;
create policy "crew can read and write" on trip_items
  for all using (true) with check (true);

alter publication supabase_realtime add table trip_items;

insert into trip_items (kind, day, slot, time, body, who)
values ('plan', '2026-11-08', 'Dinner', '6:00 PM', 'Dinner at Arenal', 'Matt');
