-- Only the trusted Edge Function may call this RPC. It supplies the ID from
-- Auth.getUser(token), never an ID supplied in the request body.
-- Detaching contributions and deleting Auth are a single transaction.
create function public.delete_guest_account(target_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare guest boolean;
begin
  -- Use the same lock order as scheduled cleanup. Concurrent cleanup/deletion
  -- must not partly detach data or race an account conversion.
  perform 1 from private.guest_slots where user_id = target_user_id for update;
  select is_anonymous into guest from auth.users where id = target_user_id for update;
  if guest is distinct from true then
    raise exception 'Guest account not found';
  end if;

  update public.messages set user_id = null where user_id = target_user_id;
  update public.questions set created_by = null where created_by = target_user_id;
  update public.question_answers set user_id = null where user_id = target_user_id;
  -- Existing foreign keys cascade to profile, memberships, live data and
  -- activity/rate counters, and release the guest slot.
  delete from auth.users where id = target_user_id and is_anonymous;
end;
$$;
revoke all on function public.delete_guest_account(uuid) from public, anon, authenticated;
grant execute on function public.delete_guest_account(uuid) to service_role;
