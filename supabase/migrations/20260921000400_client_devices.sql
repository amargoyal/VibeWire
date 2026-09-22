-- The browsers and phones that have signed into this account.
--
-- Deliberately not a credential either. Revoking a device is still the host's
-- job and still destroys a key in its keychain; this row only answers "where am
-- I signed in", which nothing else can answer once a session moves between a
-- phone, a laptop and a published copy of the client on a different origin.

create table public.client_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The client's own device id, the one the host knows it by. Absent until the
  -- browser has paired with something.
  device_id text,
  name text not null,
  kind text not null default 'browser',
  platform text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, name, kind)
);

comment on table public.client_devices is
  'Browsers and phones signed into this account. A directory, not a credential.';

create index client_devices_user_last_seen_idx
  on public.client_devices (user_id, last_seen_at desc);

alter table public.client_devices enable row level security;

create policy "devices are readable by their owner"
  on public.client_devices for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "devices are insertable by their owner"
  on public.client_devices for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "devices are updatable by their owner"
  on public.client_devices for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "devices are deletable by their owner"
  on public.client_devices for delete
  to authenticated
  using ((select auth.uid()) = user_id);
