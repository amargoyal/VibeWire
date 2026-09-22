-- `updated_at` columns that are only set by their default lie the moment a row
-- is updated: the client writes prefs and the timestamp still reports the
-- insert. One trigger function, applied to every table that carries the column.

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create trigger client_prefs_touch_updated_at
  before update on public.client_prefs
  for each row execute function public.touch_updated_at();
