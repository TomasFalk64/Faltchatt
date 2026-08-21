insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('group-maps', 'group-maps', false, 5242880, array['image/tiff', 'image/geotiff', 'application/octet-stream'])
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/tiff', 'image/geotiff', 'application/octet-stream'];

create policy "approved members can read group maps"
on storage.objects for select
to authenticated
using (
  bucket_id = 'group-maps'
  and public.is_group_member((storage.foldername(name))[1]::uuid)
);

create policy "admins can upload group maps"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'group-maps'
  and public.is_group_admin((storage.foldername(name))[1]::uuid)
);

create policy "admins can update group maps"
on storage.objects for update
to authenticated
using (
  bucket_id = 'group-maps'
  and public.is_group_admin((storage.foldername(name))[1]::uuid)
)
with check (
  bucket_id = 'group-maps'
  and public.is_group_admin((storage.foldername(name))[1]::uuid)
);

create policy "admins can delete group maps"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'group-maps'
  and public.is_group_admin((storage.foldername(name))[1]::uuid)
);
