create or replace function public.clear_group_location_messages(target_group_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_group_owner(target_group_id, auth.uid()) then
    raise exception 'only group owner can clear location pins';
  end if;

  delete from public.messages
  where group_id = target_group_id
    and type = 'location';

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.clear_group_chat(target_group_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_group_owner(target_group_id, auth.uid()) then
    raise exception 'only group owner can clear chat';
  end if;

  delete from public.messages
  where group_id = target_group_id;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

grant execute on function public.clear_group_location_messages(uuid) to authenticated;
grant execute on function public.clear_group_chat(uuid) to authenticated;
