create table if not exists public.group_presence (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  selected_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  is_sharing_location boolean not null default false,
  primary key (group_id, user_id),
  constraint group_presence_membership_fk
    foreign key (group_id, user_id)
    references public.group_members(group_id, user_id)
    on delete cascade
);

create index if not exists group_presence_group_seen_idx
on public.group_presence(group_id, last_seen desc);

alter table public.group_presence enable row level security;

drop policy if exists "members read group presence" on public.group_presence;
create policy "members read group presence"
on public.group_presence for select
to authenticated
using (public.is_group_member(group_id));

drop policy if exists "members upsert own presence" on public.group_presence;
create policy "members upsert own presence"
on public.group_presence for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.is_group_member(group_id)
);

drop policy if exists "members update own presence" on public.group_presence;
create policy "members update own presence"
on public.group_presence for update
to authenticated
using (
  user_id = auth.uid()
  and public.is_group_member(group_id)
)
with check (
  user_id = auth.uid()
  and public.is_group_member(group_id)
);

drop policy if exists "members delete own presence" on public.group_presence;
create policy "members delete own presence"
on public.group_presence for delete
to authenticated
using (
  user_id = auth.uid()
  or public.is_group_admin(group_id)
);

alter publication supabase_realtime add table public.group_presence;
alter table public.group_presence replica identity full;
