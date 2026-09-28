-- Guest admission is enforced on auth.users itself, including direct Auth API
-- calls. A finite set of locked slots avoids a concurrent count-then-insert race.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.guest_slots (
  slot integer primary key check (slot between 1 and 100),
  user_id uuid unique references auth.users(id) on delete set null,
  last_seen timestamptz not null default now()
);
insert into private.guest_slots(slot) select generate_series(1, 100);
do $$
begin
  if (select count(*) from auth.users where is_anonymous) > 100 then
    raise exception 'More than 100 existing guests. Review them before applying this migration.';
  end if;
end;
$$;
with guests as (
  select u.id, row_number() over (order by u.created_at, u.id) as slot,
    coalesce(a.last_seen, u.created_at, now()) as last_seen
  from auth.users u left join public.account_activity a on a.user_id = u.id
  where u.is_anonymous
)
update private.guest_slots s set user_id = g.id, last_seen = g.last_seen
from guests g where s.slot = g.slot;

create function private.track_guest_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare assigned_slot integer;
begin
  if new.is_anonymous then
    if exists (select 1 from private.guest_slots where user_id = new.id) then return new; end if;
    update private.guest_slots set user_id = new.id, last_seen = now()
    where slot = (
      select slot from private.guest_slots where user_id is null
      order by slot for update skip locked limit 1
    ) returning slot into assigned_slot;
    if assigned_slot is null then raise exception 'guest capacity reached'; end if;
  else
    update private.guest_slots set user_id = null where user_id = new.id;
  end if;
  return new;
end;
$$;
create trigger track_guest_user after insert or update of is_anonymous on auth.users
for each row execute function private.track_guest_user();

create function public.guest_capacity_available()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.guest_slots where user_id is null);
$$;
revoke all on function public.guest_capacity_available() from public;
grant execute on function public.guest_capacity_available() to anon, authenticated;

-- is_guest is display information only; clients cannot choose its value.
alter table public.profiles add column is_guest boolean not null default false;
update public.profiles p set is_guest = u.is_anonymous from auth.users u where p.id = u.id;
create function private.set_profile_guest_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select coalesce(u.is_anonymous, false) into new.is_guest from auth.users u where u.id = new.id;
  return new;
end;
$$;
create trigger set_profile_guest_status before insert or update on public.profiles
for each row execute function private.set_profile_guest_status();

create function private.require_permanent_group_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from auth.users where id = new.owner_id and is_anonymous) then
    raise exception 'Logga in med ett konto för att skapa eller äga en grupp.';
  end if;
  return new;
end;
$$;
create trigger require_permanent_group_owner before insert or update of owner_id on public.groups
for each row execute function private.require_permanent_group_owner();

create function private.require_permanent_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role in ('admin', 'owner') and exists (
    select 1 from auth.users where id = new.user_id and is_anonymous
  ) then
    raise exception 'Gäster kan inte vara admin eller ägare.';
  end if;
  return new;
end;
$$;
create trigger require_permanent_admin before insert or update on public.group_members
for each row execute function private.require_permanent_admin();

-- Do not enable guests on a database that already has anonymous owners/admins.
do $$
begin
  if exists (select 1 from public.group_members gm join auth.users u on u.id = gm.user_id
    where u.is_anonymous and gm.role in ('owner', 'admin'))
    or exists (select 1 from public.groups g join auth.users u on u.id = g.owner_id where u.is_anonymous) then
    raise exception 'Existing guests have admin/owner roles. Reassign those roles before enabling guest access.';
  end if;
end;
$$;

-- Database time is authoritative. No client can postpone expiry with a future date.
drop policy if exists "users can touch own account activity" on public.account_activity;
drop policy if exists "users can update own account activity" on public.account_activity;
revoke insert, update, delete on public.account_activity from anon, authenticated;
create or replace function public.touch_account_activity()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  update private.guest_slots set last_seen = now()
    where user_id = auth.uid() and last_seen < now() - interval '30 seconds';
  insert into public.account_activity (user_id, last_seen, updated_at)
  values (auth.uid(), now(), now())
  on conflict (user_id) do update set last_seen = now(), updated_at = now()
    where public.account_activity.last_seen < now() - interval '30 seconds';
end;
$$;
revoke all on function public.touch_account_activity() from public, anon;
grant execute on function public.touch_account_activity() to authenticated;

create function public.clear_own_live_data()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  delete from public.locations where user_id = auth.uid();
  delete from public.group_presence where user_id = auth.uid();
end;
$$;
revoke all on function public.clear_own_live_data() from public, anon;
grant execute on function public.clear_own_live_data() to authenticated;

-- A per-user, per-action minute window; concurrent requests serialize
-- on the same row. Clients cannot call or reset this counter themselves.
create table private.request_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  started_at timestamptz not null,
  requests integer not null,
  primary key(user_id, action)
);
create function private.take_request(target_user uuid, target_action text, max_requests integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare request_count integer;
begin
  if target_user is null then raise exception 'not authenticated'; end if;
  insert into private.request_limits as limits(user_id, action, started_at, requests)
  values (target_user, target_action, clock_timestamp(), 1)
  on conflict(user_id, action) do update set
    requests = case when limits.started_at <= clock_timestamp() - interval '1 minute' then 1
      else least(limits.requests + 1, max_requests + 1) end,
    started_at = case when limits.started_at <= clock_timestamp() - interval '1 minute'
      then clock_timestamp() else limits.started_at end
  returning requests into request_count;
  return request_count <= max_requests;
end;
$$;

-- Failed code attempts must COMMIT their counter. Returning a JSON error,
-- rather than raising, avoids rolling back the rate limit on a wrong code.
drop function public.request_group_membership(text);
create function public.request_group_membership(requested_join_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target_group_id uuid; existing_status text; member_count integer;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not private.take_request(auth.uid(), 'join', 5) then
    return jsonb_build_object('error', 'För många gruppkodsförsök. Vänta en minut och försök igen.');
  end if;
  select id into target_group_id from public.groups
  where lower(join_code) = lower(btrim(requested_join_code)) and expires_at > now()
  for update;
  if target_group_id is null then
    return jsonb_build_object('error', 'Gruppkoden är felaktig eller gruppen har gått ut.');
  end if;
  select status into existing_status from public.group_members
    where group_id = target_group_id and user_id = auth.uid();
  if existing_status is null or existing_status = 'rejected' then
    select count(*) into member_count from public.group_members
      where group_id = target_group_id and status in ('approved', 'pending');
    if member_count >= 30 then
      return jsonb_build_object('error', 'Gruppen har redan 30 medlemmar eller väntande ansökningar.');
    end if;
  end if;
  insert into public.group_members(group_id, user_id, role, status)
    values (target_group_id, auth.uid(), 'member', 'pending')
  on conflict(group_id, user_id) do update set status = case
    when public.group_members.status = 'rejected' then 'pending' else public.group_members.status end;
  return jsonb_build_object('group_id', target_group_id);
end;
$$;
revoke all on function public.request_group_membership(text) from public, anon;
grant execute on function public.request_group_membership(text) to authenticated;

create function private.limit_member_writes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  -- Trusted cleanup has no user JWT. User requests, including SECURITY DEFINER
  -- question RPCs, retain auth.uid() and must pass the same limits.
  if caller is null then return new; end if;
  if not private.take_request(caller, tg_table_name, tg_argv[0]::integer) then
    raise exception 'För många uppdateringar. Vänta en minut och försök igen.';
  end if;
  if tg_table_name = 'messages' then
    if char_length(new.text) > 4000 then raise exception 'Meddelandet får vara högst 4000 tecken.'; end if;
    if new.type = 'location' and not private.take_request(caller, 'map_pins', 10) then
      raise exception 'För många platsnålar. Vänta en minut och försök igen.';
    end if;
  end if;
  update private.guest_slots set last_seen = now()
    where user_id = caller and last_seen < now() - interval '30 seconds';
  return new;
end;
$$;
-- AFTER fires once for an upsert (BEFORE INSERT + UPDATE would count twice).
create trigger limit_messages after insert on public.messages
for each row execute function private.limit_member_writes('20');
create trigger limit_locations after insert or update on public.locations
for each row execute function private.limit_member_writes('30');
create trigger limit_presence after insert or update on public.group_presence
for each row execute function private.limit_member_writes('30');
create trigger limit_answers after insert or update on public.question_answers
for each row execute function private.limit_member_writes('30');
create trigger limit_profiles after insert or update on public.profiles
for each row execute function private.limit_member_writes('20');
create trigger limit_questions after insert on public.questions
for each row execute function private.limit_member_writes('20');
create trigger limit_question_options after insert on public.question_options
for each row execute function private.limit_member_writes('100');

-- Preserve a guest's contributions, including polls and votes, when the guest
-- expires. The existing CASCADE behavior for deletion of permanent accounts
-- stays intact: only guest cleanup detaches the author before deleting auth.
alter table public.messages alter column user_id drop not null;
alter table public.questions alter column created_by drop not null;
alter table public.question_answers alter column user_id drop not null;
create function private.cleanup_guests()
returns integer language plpgsql security definer set search_path = '' as $$
declare guest record; removed integer := 0;
begin
  for guest in
    select s.user_id from private.guest_slots s join auth.users u on u.id = s.user_id
    where s.last_seen <= now() - interval '24 hours' and u.is_anonymous
    for update of s skip locked
  loop
    update public.messages set user_id = null where user_id = guest.user_id;
    update public.questions set created_by = null where created_by = guest.user_id;
    update public.question_answers set user_id = null where user_id = guest.user_id;
    delete from auth.users where id = guest.user_id and is_anonymous;
    removed := removed + 1;
  end loop;
  return removed;
end;
$$;

-- Defense in depth: private routines/tables are never Data API entry points.
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

-- Automatic ownership transfer and permanent-account cleanup exclude guests.
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
    select gm.*
    into next_owner
    from public.group_members gm
    where gm.group_id = target_group_id
      and gm.user_id <> auth.uid()
      and not exists (select 1 from auth.users u where u.id = gm.user_id and u.is_anonymous)
      and gm.status = 'approved'
    order by
      case role when 'admin' then 0 else 1 end,
      approved_at nulls last,
      created_at
    limit 1;

    if next_owner.id is null then
      raise exception 'Ägaren kan inte lämna utan en annan godkänd medlem med konto';
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
      and not exists (select 1 from auth.users u where u.id = gm.user_id and u.is_anonymous)
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
  where not exists (select 1 from auth.users u where u.id = aa.user_id and u.is_anonymous)
    and aa.last_seen <= now() - (delete_after - warn_before);
$$;

revoke all on function public.inactive_account_candidates(interval, interval) from public;
revoke all on function public.inactive_account_candidates(interval, interval) from anon;
revoke all on function public.inactive_account_candidates(interval, interval) from authenticated;
grant execute on function public.inactive_account_candidates(interval, interval) to service_role;

