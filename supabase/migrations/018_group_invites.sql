create table if not exists public.group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  email text not null,
  phone text,
  alias text,
  status text not null default 'invited' check (status in ('invited', 'claimed', 'revoked')),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  claimed_by_user_id uuid references public.profiles(id) on delete set null,
  claimed_at timestamptz,
  constraint group_invites_email_normalized_check check (email = lower(btrim(email))),
  constraint group_invites_email_shape_check check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint group_invites_group_email_unique unique (group_id, email)
);

create index if not exists group_invites_group_status_idx
on public.group_invites(group_id, status);

create index if not exists group_invites_email_status_idx
on public.group_invites(email, status);

alter table public.group_invites enable row level security;

drop policy if exists "admins can read group invites" on public.group_invites;
create policy "admins can read group invites"
on public.group_invites for select
to authenticated
using (public.is_group_admin(group_id));

drop policy if exists "invites are managed through rpc" on public.group_invites;
create policy "invites are managed through rpc"
on public.group_invites for all
to authenticated
using (false)
with check (false);

create or replace function public.import_group_invites(target_group_id uuid, import_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  normalized_email text;
  clean_phone text;
  clean_alias text;
  target_user_id uuid;
  existing_member public.group_members%rowtype;
  processed_count integer := 0;
  approved_count integer := 0;
  invited_count integer := 0;
  already_member_count integer := 0;
  already_invited_count integer := 0;
  updated_pending_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.is_group_admin(target_group_id, auth.uid()) then
    raise exception 'only group admins can import members';
  end if;

  if jsonb_typeof(import_rows) <> 'array' then
    raise exception 'import_rows must be an array';
  end if;

  for item in select * from jsonb_array_elements(import_rows)
  loop
    normalized_email := lower(btrim(item->>'email'));
    clean_phone := nullif(btrim(coalesce(item->>'phone', '')), '');
    clean_alias := nullif(btrim(coalesce(item->>'alias', '')), '');

    if normalized_email is null or normalized_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      continue;
    end if;

    processed_count := processed_count + 1;

    select p.id
    into target_user_id
    from public.profiles p
    where lower(p.email) = normalized_email
    order by p.created_at
    limit 1;

    if target_user_id is not null then
      select *
      into existing_member
      from public.group_members gm
      where gm.group_id = target_group_id
        and gm.user_id = target_user_id;

      if existing_member.id is null then
        insert into public.group_members (group_id, user_id, role, status, approved_at)
        values (target_group_id, target_user_id, 'member', 'approved', now());
        approved_count := approved_count + 1;
      elsif existing_member.status <> 'approved' then
        update public.group_members
        set status = 'approved',
            role = case when role = 'owner' then role else 'member' end,
            approved_at = now()
        where id = existing_member.id;
        approved_count := approved_count + 1;
        updated_pending_count := updated_pending_count + 1;
      else
        already_member_count := already_member_count + 1;
      end if;

      update public.group_invites
      set status = 'claimed',
          claimed_by_user_id = target_user_id,
          claimed_at = coalesce(claimed_at, now())
      where group_id = target_group_id
        and email = normalized_email
        and status = 'invited';
    else
      insert into public.group_invites (group_id, email, phone, alias, status, created_by)
      values (target_group_id, normalized_email, clean_phone, clean_alias, 'invited', auth.uid())
      on conflict (group_id, email) do update
      set phone = excluded.phone,
          alias = excluded.alias,
          status = 'invited',
          created_by = auth.uid(),
          claimed_by_user_id = null,
          claimed_at = null
      where public.group_invites.status <> 'invited'
         or public.group_invites.phone is distinct from excluded.phone
         or public.group_invites.alias is distinct from excluded.alias;

      if found then
        invited_count := invited_count + 1;
      else
        already_invited_count := already_invited_count + 1;
      end if;
    end if;

    target_user_id := null;
    existing_member := null;
  end loop;

  return jsonb_build_object(
    'processed', processed_count,
    'approved', approved_count,
    'invited', invited_count,
    'already_member', already_member_count,
    'already_invited', already_invited_count,
    'updated_pending', updated_pending_count
  );
end;
$$;

create or replace function public.claim_group_invites()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  verified_email text;
  invite_row public.group_invites%rowtype;
  claimed_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select lower(u.email)
  into verified_email
  from auth.users u
  where u.id = auth.uid()
    and u.email_confirmed_at is not null;

  if verified_email is null then
    return 0;
  end if;

  for invite_row in
    select *
    from public.group_invites
    where email = verified_email
      and status = 'invited'
  loop
    insert into public.group_members (group_id, user_id, role, status, approved_at)
    values (invite_row.group_id, auth.uid(), 'member', 'approved', now())
    on conflict (group_id, user_id) do update
    set status = 'approved',
        role = case when public.group_members.role = 'owner' then public.group_members.role else 'member' end,
        approved_at = coalesce(public.group_members.approved_at, now());

    update public.group_invites
    set status = 'claimed',
        claimed_by_user_id = auth.uid(),
        claimed_at = now()
    where id = invite_row.id;

    claimed_count := claimed_count + 1;
  end loop;

  return claimed_count;
end;
$$;

create or replace function public.revoke_group_invite(target_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_group_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select group_id
  into target_group_id
  from public.group_invites
  where id = target_invite_id
    and status = 'invited';

  if target_group_id is null then
    raise exception 'invite not found';
  end if;

  if not public.is_group_admin(target_group_id, auth.uid()) then
    raise exception 'only group admins can revoke invites';
  end if;

  update public.group_invites
  set status = 'revoked'
  where id = target_invite_id;
end;
$$;

grant execute on function public.import_group_invites(uuid, jsonb) to authenticated;
grant execute on function public.claim_group_invites() to authenticated;
grant execute on function public.revoke_group_invite(uuid) to authenticated;
