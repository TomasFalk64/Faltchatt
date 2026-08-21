alter table public.profiles
drop constraint if exists profiles_symbol_check;

update public.profiles
set symbol = 'hat'
where symbol not in ('hat', 'tree', 'leaf', 'mushroom', 'star', 'spade', 'heart', 'train', 'car');

alter table public.profiles
alter column symbol set default 'hat';

alter table public.profiles
add constraint profiles_symbol_check
check (symbol in ('hat', 'tree', 'leaf', 'mushroom', 'star', 'spade', 'heart', 'train', 'car'));

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

  insert into public.profiles (id, alias, symbol, email)
  values (auth.uid(), coalesce(nullif(split_part(auth.jwt() ->> 'email', '@', 1), ''), 'Fältanvändare'), 'hat', auth.jwt() ->> 'email')
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
