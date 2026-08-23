create policy "members delete own location"
on public.locations for delete
to authenticated
using (
  user_id = auth.uid()
  and public.is_group_member(group_id)
);
