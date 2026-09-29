-- New maps consist of private PNG tiles and a JSON manifest. Legacy TIFFs remain readable.
update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/tiff', 'image/geotiff', 'application/octet-stream', 'image/png', 'application/json']
where id = 'group-maps';

-- Storage objects must be removed via the Storage API, after any kind of group deletion.
create table public.map_storage_cleanup (
  group_id uuid primary key,
  created_at timestamptz not null default now()
);
alter table public.map_storage_cleanup enable row level security;
revoke all on public.map_storage_cleanup from anon, authenticated;
grant all on public.map_storage_cleanup to service_role;

create function public.queue_group_map_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.map_storage_cleanup (group_id) values (old.id)
  on conflict (group_id) do nothing;
  return old;
end;
$$;
revoke all on function public.queue_group_map_cleanup() from public;
create trigger queue_group_map_cleanup
after delete on public.groups
for each row execute function public.queue_group_map_cleanup();
