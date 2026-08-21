create or replace function public.random_join_code()
returns text
language sql
as $$
  select upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
$$;

grant execute on function public.random_join_code() to authenticated;
