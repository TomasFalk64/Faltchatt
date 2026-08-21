alter publication supabase_realtime add table public.group_members;
alter publication supabase_realtime add table public.locations;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.questions;
alter publication supabase_realtime add table public.question_answers;

alter table public.group_members replica identity full;
alter table public.locations replica identity full;
alter table public.messages replica identity full;
alter table public.questions replica identity full;
alter table public.question_answers replica identity full;
