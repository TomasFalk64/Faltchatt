create or replace function public.leave_group(target_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  leaving_member public.group_members%rowtype;
  next_owner public.group_members%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select *
  into leaving_member
  from public.group_members
  where group_id = target_group_id
    and user_id = auth.uid();

  if leaving_member.id is null then
    raise exception 'membership not found';
  end if;

  if leaving_member.role = 'owner' then
    select *
    into next_owner
    from public.group_members
    where group_id = target_group_id
      and user_id <> auth.uid()
      and status = 'approved'
    order by
      case role when 'admin' then 0 else 1 end,
      approved_at nulls last,
      created_at
    limit 1;

    if next_owner.id is null then
      raise exception 'owner cannot leave without another approved member';
    end if;

    update public.group_members
    set role = 'owner',
        status = 'approved',
        approved_at = coalesce(approved_at, now())
    where id = next_owner.id;

    update public.groups
    set owner_id = next_owner.user_id
    where id = target_group_id;
  end if;

  delete from public.group_members
  where id = leaving_member.id;
end;
$$;

grant execute on function public.leave_group(uuid) to authenticated;
