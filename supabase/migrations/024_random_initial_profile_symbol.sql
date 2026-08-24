create or replace function public.random_profile_symbol()
returns text
language sql
volatile
as $$
  select (array['hat', 'tree', 'leaf', 'mushroom', 'star', 'spade', 'heart', 'train', 'car'])[floor(random() * 9 + 1)::int];
$$;

create or replace function public.random_profile_symbol_color()
returns text
language sql
volatile
as $$
  select (array[
    '#f70404',
    '#ff52a8',
    '#fcf700',
    '#92400e',
    '#03c74b',
    '#00fcde',
    '#044be6',
    '#9063fa',
    '#9ca3af',
    '#111827'
  ])[floor(random() * 10 + 1)::int];
$$;

create or replace function public.ensure_own_profile()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.profiles (id, alias, symbol, symbol_color)
  values (auth.uid(), 'Fältanvändare', public.random_profile_symbol(), public.random_profile_symbol_color())
  on conflict (id) do nothing;
end;
$$;

grant execute on function public.ensure_own_profile() to authenticated;

create or replace function public.create_group_with_owner(group_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_group_id uuid;
  code text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.profiles (id, alias, symbol, symbol_color)
  values (auth.uid(), 'Fältanvändare', public.random_profile_symbol(), public.random_profile_symbol_color())
  on conflict (id) do nothing;

  loop
    code := public.random_join_code();
    exit when not exists (select 1 from public.groups where join_code = code);
  end loop;

  insert into public.groups (name, owner_id, join_code)
  values (group_name, auth.uid(), code)
  returning id into new_group_id;

  insert into public.group_members (group_id, user_id, role, status, approved_at)
  values (new_group_id, auth.uid(), 'owner', 'approved', now());

  return new_group_id;
end;
$$;

grant execute on function public.create_group_with_owner(text) to authenticated;

