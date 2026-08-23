create or replace function public.prepare_delete_user_account(target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  owned_group record;
  next_owner record;
  deleted_groups integer := 0;
  transferred_groups integer := 0;
  removed_memberships integer := 0;
  removed_remaining_memberships integer := 0;
begin
  if target_user_id is null then
    raise exception 'target_user_id is required';
  end if;

  delete from public.group_presence
  where user_id = target_user_id;

  delete from public.locations
  where user_id = target_user_id;

  for owned_group in
    select g.id, g.name
    from public.groups g
    where g.owner_id = target_user_id
  loop
    select gm.user_id, gm.id
    into next_owner
    from public.group_members gm
    where gm.group_id = owned_group.id
      and gm.user_id <> target_user_id
      and gm.status = 'approved'
    order by
      case gm.role when 'admin' then 0 else 1 end,
      gm.approved_at nulls last,
      gm.created_at
    limit 1;

    if next_owner.user_id is null then
      delete from public.groups
      where id = owned_group.id;
      deleted_groups := deleted_groups + 1;
    else
      update public.group_members
      set role = 'owner',
          status = 'approved',
          approved_at = coalesce(approved_at, now())
      where id = next_owner.id;

      update public.groups
      set owner_id = next_owner.user_id
      where id = owned_group.id;

      delete from public.group_members
      where group_id = owned_group.id
        and user_id = target_user_id;

      transferred_groups := transferred_groups + 1;
      removed_memberships := removed_memberships + 1;
    end if;
  end loop;

  delete from public.group_members
  where user_id = target_user_id;
  get diagnostics removed_remaining_memberships = row_count;
  removed_memberships := removed_memberships + removed_remaining_memberships;

  update public.group_invites
  set status = 'revoked'
  where claimed_by_user_id = target_user_id
    and status = 'invited';

  return jsonb_build_object(
    'transferred_groups', transferred_groups,
    'deleted_groups', deleted_groups,
    'removed_memberships', removed_memberships
  );
end;
$$;

revoke all on function public.prepare_delete_user_account(uuid) from public;
revoke all on function public.prepare_delete_user_account(uuid) from anon;
revoke all on function public.prepare_delete_user_account(uuid) from authenticated;
grant execute on function public.prepare_delete_user_account(uuid) to service_role;
