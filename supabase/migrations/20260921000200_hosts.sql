-- The computers an account has paired with.
--
-- Trust still lives where it always did: the private key is in the browser and
-- the public key is in the host's keychain, and nothing here can pair anything.
-- This is a list, so a phone that lost its site data can be told which machines
-- it used to reach and at which addresses, instead of showing an empty screen.

create table public.hosts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The host's own identifier, as `/v1/pair` returned it. Stable across
  -- addresses, which is the whole reason it is the key and the address is not.
  host_id text not null,
  name text not null,
  platform text not null default 'macos',
  origin text,
  alternates text[] not null default '{}',
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (user_id, host_id)
);

comment on table public.hosts is
  'Computers this account has paired with. A directory, not a credential.';

create index hosts_user_last_seen_idx on public.hosts (user_id, last_seen_at desc);

alter table public.hosts enable row level security;

create policy "hosts are readable by their owner"
  on public.hosts for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "hosts are insertable by their owner"
  on public.hosts for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "hosts are updatable by their owner"
  on public.hosts for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "hosts are deletable by their owner"
  on public.hosts for delete
  to authenticated
  using ((select auth.uid()) = user_id);
