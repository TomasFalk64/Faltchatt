alter table public.groups
add column if not exists expires_at timestamptz;

update public.groups
set expires_at = coalesce(expires_at, now() + interval '7 days');

alter table public.groups
alter column expires_at set not null,
alter column expires_at set default (now() + interval '7 days');

create index if not exists groups_expires_at_idx
on public.groups(expires_at);

create or replace function public.is_group_current(target_group_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.groups g
    where g.id = target_group_id
      and g.expires_at > now()
  );
$$;

create or replace function public.is_group_member(target_group_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.group_members gm
    join public.groups g on g.id = gm.group_id
    where gm.group_id = target_group_id
      and gm.user_id = target_user_id
      and gm.status = 'approved'
      and g.expires_at > now()
  );
$$;

create or replace function public.is_group_admin(target_group_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.group_members gm
    join public.groups g on g.id = gm.group_id
    where gm.group_id = target_group_id
      and gm.user_id = target_user_id
      and gm.status = 'approved'
      and gm.role in ('owner', 'admin')
      and g.expires_at > now()
  );
$$;

create or replace function public.is_group_owner(target_group_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.group_members gm
    join public.groups g on g.id = gm.group_id
    where gm.group_id = target_group_id
      and gm.user_id = target_user_id
      and gm.status = 'approved'
      and gm.role = 'owner'
      and g.expires_at > now()
  );
$$;

drop policy if exists "members can read own requested groups" on public.groups;
drop policy if exists "members can read own requested current groups" on public.groups;
create policy "members can read own requested current groups"
on public.groups for select
to authenticated
using (
  expires_at > now()
  and exists (
    select 1
    from public.group_members gm
    where gm.group_id = groups.id
      and gm.user_id = auth.uid()
  )
);

drop policy if exists "profiles can read self and approved group peers" on public.profiles;
drop policy if exists "profiles can read self and approved current group peers" on public.profiles;
create policy "profiles can read self and approved current group peers"
on public.profiles for select
to authenticated
using (
  id = auth.uid()
  or exists (
    select 1
    from public.group_members mine
    join public.group_members peer on peer.group_id = mine.group_id
    join public.groups g on g.id = mine.group_id
    where mine.user_id = auth.uid()
      and mine.status = 'approved'
      and peer.user_id = profiles.id
      and peer.status = 'approved'
      and g.expires_at > now()
  )
);

create or replace function public.create_group_with_owner(group_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_group_id uuid;
  code text;
  active_group_count integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select count(*)
  into active_group_count
  from public.groups
  where expires_at > now();

  if active_group_count >= 30 then
    raise exception 'max active groups reached';
  end if;

  insert into public.profiles (id, alias, symbol, symbol_color)
  values (auth.uid(), 'Fältanvändare', public.random_profile_symbol(), public.random_profile_symbol_color())
  on conflict (id) do nothing;

  loop
    code := public.random_join_code();
    exit when not exists (select 1 from public.groups where join_code = code);
  end loop;

  insert into public.groups (name, owner_id, join_code, expires_at)
  values (group_name, auth.uid(), code, now() + interval '7 days')
  returning id into new_group_id;

  insert into public.group_members (group_id, user_id, role, status, approved_at)
  values (new_group_id, auth.uid(), 'owner', 'approved', now());

  return new_group_id;
end;
$$;

grant execute on function public.create_group_with_owner(text) to authenticated;

create or replace function public.request_group_membership(requested_join_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_group_id uuid;
  existing_status text;
  member_count integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select id into target_group_id
  from public.groups
  where lower(join_code) = lower(btrim(requested_join_code))
    and expires_at > now();

  if target_group_id is null then
    raise exception 'invalid or expired join code';
  end if;

  select status
  into existing_status
  from public.group_members
  where group_id = target_group_id
    and user_id = auth.uid();

  if existing_status is null or existing_status = 'rejected' then
    select count(*)
    into member_count
    from public.group_members
    where group_id = target_group_id
      and status in ('approved', 'pending');

    if member_count >= 30 then
      raise exception 'group member limit reached';
    end if;
  end if;

  insert into public.group_members (group_id, user_id, role, status)
  values (target_group_id, auth.uid(), 'member', 'pending')
  on conflict (group_id, user_id) do update
    set status = case
      when public.group_members.status = 'rejected' then 'pending'
      else public.group_members.status
    end;

  return target_group_id;
end;
$$;

grant execute on function public.request_group_membership(text) to authenticated;

grant execute on function public.is_group_current(uuid) to authenticated;
