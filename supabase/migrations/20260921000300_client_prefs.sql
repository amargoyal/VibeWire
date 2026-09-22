-- What the client itself remembers, as opposed to what the host remembers.
--
-- Quality, sensitivity and natural scrolling are host settings and stay on the
-- host: they describe a machine, not a person. What lands here is the handful of
-- things a browser keeps in localStorage and loses the moment site data is
-- cleared or a second phone is used -- the keyboard bar's custom combos, and
-- whether the connect guide has been read.
--
-- One row per account, one jsonb document, because the shape belongs to the
-- client and a column per preference would make every new one a migration.

create table public.client_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.client_prefs is
  'Client-side preferences, one jsonb document per account.';

alter table public.client_prefs enable row level security;

create policy "prefs are readable by their owner"
  on public.client_prefs for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "prefs are insertable by their owner"
  on public.client_prefs for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "prefs are updatable by their owner"
  on public.client_prefs for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
