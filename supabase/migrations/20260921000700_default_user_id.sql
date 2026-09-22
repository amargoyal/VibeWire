-- `user_id` defaults to the caller, so the client never sends it.
--
-- The row-level security check already refuses a row belonging to anyone else,
-- so sending it was never a hole -- but a client that has to state its own id
-- on every insert is a client that can get it wrong, and this removes the
-- question from the wire entirely.

alter table public.hosts alter column user_id set default auth.uid();
alter table public.client_prefs alter column user_id set default auth.uid();
alter table public.client_devices alter column user_id set default auth.uid();
