create or replace function public.random_join_code()
returns text
language plpgsql
as $$
declare
  adjective_1 text[] := array['gul', 'snabb', 'glad', 'stor', 'vild', 'mjuk', 'hemlig', 'blå', 'lugn', 'varm'];
  adjective_2 text[] := array['oväntad', 'prickig', 'lycklig', 'tung', 'randig', 'klok', 'tyst', 'snäll', 'ivrig'];
  mushrooms text[] := array[
    'kantarell', 'sopp', 'skivling', 'riska', 'kremla',
    'flugsvamp', 'ticka', 'tryffel', 'murkla', 'champinjon',
    'mussling', 'fingersvamp', 'röksvamp', 'taggsvamp'
  ];
begin
  return adjective_1[1 + floor(random() * array_length(adjective_1, 1))::int]
    || '-'
    || adjective_2[1 + floor(random() * array_length(adjective_2, 1))::int]
    || '-'
    || mushrooms[1 + floor(random() * array_length(mushrooms, 1))::int];
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
  where lower(join_code) = lower(btrim(requested_join_code));

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

grant execute on function public.random_join_code() to authenticated;
grant execute on function public.request_group_membership(text) to authenticated;
