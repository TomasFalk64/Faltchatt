create policy "members can read own requested groups"
on public.groups for select
to authenticated
using (
  exists (
    select 1
    from public.group_members gm
    where gm.group_id = groups.id
      and gm.user_id = auth.uid()
  )
);

create policy "admins can read applicant profiles"
on public.profiles for select
to authenticated
using (
  exists (
    select 1
    from public.group_members applicant
    where applicant.user_id = profiles.id
      and public.is_group_admin(applicant.group_id)
  )
);
