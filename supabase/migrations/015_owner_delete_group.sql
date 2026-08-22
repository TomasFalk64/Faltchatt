create or replace function public.delete_group(target_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_group_owner(target_group_id, auth.uid()) then
    raise exception 'only group owner can delete group';
  end if;

  delete from public.groups
  where id = target_group_id;

  if not found then
    raise exception 'group not found';
  end if;
end;
$$;

grant execute on function public.delete_group(uuid) to authenticated;
