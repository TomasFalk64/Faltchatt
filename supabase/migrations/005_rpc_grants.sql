grant usage on schema public to authenticated;

grant execute on function public.create_group_with_owner(text) to authenticated;
grant execute on function public.request_group_membership(text) to authenticated;
grant execute on function public.create_question_message(uuid, text, text[]) to authenticated;
grant execute on function public.random_join_code() to authenticated;

grant execute on function public.is_group_member(uuid, uuid) to authenticated;
grant execute on function public.is_group_admin(uuid, uuid) to authenticated;
grant execute on function public.is_group_owner(uuid, uuid) to authenticated;
