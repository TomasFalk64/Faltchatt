create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  alias text not null check (char_length(alias) between 1 and 80),
  symbol text not null default 'circle' check (symbol in ('circle', 'triangle', 'square', 'star', 'tree', 'binoculars')),
  symbol_color text not null default '#17324d' check (symbol_color ~ '^#[0-9A-Fa-f]{6}$'),
  show_alias boolean not null default true,
  email text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  join_code text unique not null,
  map_file_path text,
  created_at timestamptz not null default now()
);

create table public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  unique (group_id, user_id)
);

create table public.locations (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy double precision not null check (accuracy >= 0),
  heading double precision,
  speed double precision,
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null default 'text' check (type in ('text', 'location', 'question', 'system')),
  text text not null default '',
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default now(),
  check (
    type <> 'location'
    or (latitude is not null and longitude is not null)
  )
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references public.messages(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  question_text text not null check (char_length(question_text) > 0),
  created_at timestamptz not null default now()
);

create table public.question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  label text not null check (char_length(label) > 0),
  sort_order integer not null default 0
);

create table public.question_answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  option_id uuid not null references public.question_options(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (question_id, user_id)
);

create index group_members_group_user_idx on public.group_members(group_id, user_id);
create index group_members_user_status_idx on public.group_members(user_id, status);
create index locations_group_user_idx on public.locations(group_id, user_id);
create index messages_group_created_idx on public.messages(group_id, created_at);
create index questions_group_idx on public.questions(group_id);
create index question_answers_question_user_idx on public.question_answers(question_id, user_id);
create index question_answers_group_idx on public.question_answers(group_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

create or replace function public.random_join_code()
returns text
language sql
as $$
  select upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
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

  insert into public.profiles (id, alias, symbol, email)
  values (auth.uid(), coalesce(nullif(split_part(auth.jwt() ->> 'email', '@', 1), ''), 'Fältanvändare'), 'circle', auth.jwt() ->> 'email')
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

create or replace function public.request_group_membership(requested_join_code text)
returns uuid
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

  select id into target_group_id
  from public.groups
  where join_code = upper(requested_join_code);

  if target_group_id is null then
    raise exception 'invalid join code';
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

create or replace function public.create_question_message(target_group_id uuid, question_text text, option_labels text[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  message_id uuid;
  question_id uuid;
  label text;
  index integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if array_length(option_labels, 1) < 2 then
    raise exception 'question requires at least two options';
  end if;
  if not public.is_group_member(target_group_id, auth.uid()) then
    raise exception 'not a member';
  end if;

  insert into public.messages (group_id, user_id, type, text)
  values (target_group_id, auth.uid(), 'question', question_text)
  returning id into message_id;

  insert into public.questions (message_id, group_id, created_by, question_text)
  values (message_id, target_group_id, auth.uid(), question_text)
  returning id into question_id;

  foreach label in array option_labels loop
    index := index + 1;
    insert into public.question_options (question_id, label, sort_order)
    values (question_id, label, index);
  end loop;

  return message_id;
end;
$$;
