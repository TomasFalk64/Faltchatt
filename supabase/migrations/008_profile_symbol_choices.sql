alter table public.profiles
drop constraint if exists profiles_symbol_check;

update public.profiles
set symbol = 'hat'
where symbol not in ('hat', 'shoe', 'train', 'car', 'iron', 'mushroom', 'tree', 'leaf', 'tent', 'star');

alter table public.profiles
alter column symbol set default 'hat';

alter table public.profiles
add constraint profiles_symbol_check
check (symbol in ('hat', 'shoe', 'train', 'car', 'iron', 'mushroom', 'tree', 'leaf', 'tent', 'star'));
