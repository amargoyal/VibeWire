-- A `security definer` function in the `public` schema is reachable over
-- PostgREST as `/rest/v1/rpc/<name>`, by anyone holding the publishable key.
-- These two are trigger bodies and nothing else; Postgres checks EXECUTE when a
-- trigger is created, not when it fires, so the triggers keep working.

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
