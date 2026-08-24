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

-- Privacy simplification:
-- - remove app-table storage of email/mobile data
-- - remove email-based group invites/import
-- - add server-side account activity tracking for future inactive-account cleanup

drop function if exists public.import_group_invites(uuid, jsonb);
drop function if exists public.claim_group_invites();
drop function if exists public.revoke_group_invite(uuid);
drop table if exists public.group_invites cascade;

alter table public.profiles
  drop column if exists email,
  drop column if exists phone,
  drop column if exists show_phone;

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

create table if not exists public.account_activity (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_seen timestamptz not null default now(),
  deletion_warning_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.account_activity enable row level security;

drop policy if exists "users can read own account activity" on public.account_activity;
create policy "users can read own account activity"
on public.account_activity for select
using (user_id = auth.uid());

drop policy if exists "users can touch own account activity" on public.account_activity;
create policy "users can touch own account activity"
on public.account_activity for insert
with check (user_id = auth.uid());

drop policy if exists "users can update own account activity" on public.account_activity;
create policy "users can update own account activity"
on public.account_activity for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

create or replace function public.touch_account_activity()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.account_activity (user_id, last_seen, updated_at)
  values (auth.uid(), now(), now())
  on conflict (user_id) do update
  set last_seen = excluded.last_seen,
      updated_at = excluded.updated_at;
end;
$$;

grant execute on function public.touch_account_activity() to authenticated;

create or replace function public.inactive_account_candidates(
  delete_after interval default interval '12 months',
  warn_before interval default interval '30 days'
)
returns table (
  user_id uuid,
  last_seen timestamptz,
  deletion_warning_sent_at timestamptz,
  action text
)
language sql
security definer
set search_path = public
as $$
  select
    aa.user_id,
    aa.last_seen,
    aa.deletion_warning_sent_at,
    case
      when aa.last_seen <= now() - delete_after then 'delete'
      when aa.last_seen <= now() - (delete_after - warn_before)
        and aa.deletion_warning_sent_at is null then 'warn'
      else 'none'
    end as action
  from public.account_activity aa
  where aa.last_seen <= now() - (delete_after - warn_before);
$$;

revoke all on function public.inactive_account_candidates(interval, interval) from public;
revoke all on function public.inactive_account_candidates(interval, interval) from anon;
revoke all on function public.inactive_account_candidates(interval, interval) from authenticated;
grant execute on function public.inactive_account_candidates(interval, interval) to service_role;

create or replace function public.mark_inactive_account_warning_sent(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.account_activity
  set deletion_warning_sent_at = now(),
      updated_at = now()
  where user_id = target_user_id;
end;
$$;

revoke all on function public.mark_inactive_account_warning_sent(uuid) from public;
revoke all on function public.mark_inactive_account_warning_sent(uuid) from anon;
revoke all on function public.mark_inactive_account_warning_sent(uuid) from authenticated;
grant execute on function public.mark_inactive_account_warning_sent(uuid) to service_role;

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

  delete from public.account_activity
  where user_id = target_user_id;

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

