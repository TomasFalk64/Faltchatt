alter table public.profiles
add column if not exists show_phone boolean not null default true;
