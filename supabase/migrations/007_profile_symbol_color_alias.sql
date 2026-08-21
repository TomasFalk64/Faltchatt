alter table public.profiles
add column if not exists symbol_color text not null default '#17324d'
  check (symbol_color ~ '^#[0-9A-Fa-f]{6}$');

alter table public.profiles
add column if not exists show_alias boolean not null default true;
