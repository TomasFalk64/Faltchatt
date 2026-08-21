alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.locations enable row level security;
alter table public.messages enable row level security;
alter table public.questions enable row level security;
alter table public.question_options enable row level security;
alter table public.question_answers enable row level security;

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
    where gm.group_id = target_group_id
      and gm.user_id = target_user_id
      and gm.status = 'approved'
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
    where gm.group_id = target_group_id
      and gm.user_id = target_user_id
      and gm.status = 'approved'
      and gm.role in ('owner', 'admin')
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
    where gm.group_id = target_group_id
      and gm.user_id = target_user_id
      and gm.status = 'approved'
      and gm.role = 'owner'
  );
$$;

create policy "profiles can read self and approved group peers"
on public.profiles for select
to authenticated
using (
  id = auth.uid()
  or exists (
    select 1
    from public.group_members mine
    join public.group_members peer on peer.group_id = mine.group_id
    where mine.user_id = auth.uid()
      and mine.status = 'approved'
      and peer.user_id = profiles.id
      and peer.status = 'approved'
  )
);

create policy "profiles can insert self"
on public.profiles for insert
to authenticated
with check (id = auth.uid());

create policy "profiles can update self"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy "approved members can read groups"
on public.groups for select
to authenticated
using (public.is_group_member(id));

create policy "admins can update groups"
on public.groups for update
to authenticated
using (public.is_group_admin(id))
with check (public.is_group_admin(id));

create policy "members can read visible memberships"
on public.group_members for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_group_member(group_id)
);

create policy "memberships are created through join code rpc"
on public.group_members for insert
to authenticated
with check (false);

create policy "admins can update memberships"
on public.group_members for update
to authenticated
using (
  public.is_group_admin(group_id)
  and (
    role = 'member'
    or public.is_group_owner(group_id)
  )
)
with check (
  public.is_group_admin(group_id)
  and (
    role = 'member'
    or public.is_group_owner(group_id)
  )
);

create policy "admins can delete memberships"
on public.group_members for delete
to authenticated
using (
  public.is_group_admin(group_id)
  and role <> 'owner'
);

create policy "members read group locations"
on public.locations for select
to authenticated
using (public.is_group_member(group_id));

create policy "members insert own location"
on public.locations for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.is_group_member(group_id)
);

create policy "members update own location"
on public.locations for update
to authenticated
using (
  user_id = auth.uid()
  and public.is_group_member(group_id)
)
with check (
  user_id = auth.uid()
  and public.is_group_member(group_id)
);

create policy "members read messages"
on public.messages for select
to authenticated
using (public.is_group_member(group_id));

create policy "members create messages as self"
on public.messages for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.is_group_member(group_id)
);

create policy "members read questions"
on public.questions for select
to authenticated
using (public.is_group_member(group_id));

create policy "members create questions as self"
on public.questions for insert
to authenticated
with check (
  created_by = auth.uid()
  and public.is_group_member(group_id)
);

create policy "members read question options"
on public.question_options for select
to authenticated
using (
  exists (
    select 1
    from public.questions q
    where q.id = question_options.question_id
      and public.is_group_member(q.group_id)
  )
);

create policy "members create question options"
on public.question_options for insert
to authenticated
with check (
  exists (
    select 1
    from public.questions q
    where q.id = question_options.question_id
      and q.created_by = auth.uid()
      and public.is_group_member(q.group_id)
  )
);

create policy "members read question answers"
on public.question_answers for select
to authenticated
using (public.is_group_member(group_id));

create policy "members answer as self"
on public.question_answers for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.is_group_member(group_id)
  and exists (
    select 1
    from public.question_options qo
    where qo.id = question_answers.option_id
      and qo.question_id = question_answers.question_id
  )
);

create policy "members update own answer"
on public.question_answers for update
to authenticated
using (
  user_id = auth.uid()
  and public.is_group_member(group_id)
)
with check (
  user_id = auth.uid()
  and public.is_group_member(group_id)
  and exists (
    select 1
    from public.question_options qo
    where qo.id = question_answers.option_id
      and qo.question_id = question_answers.question_id
  )
);
