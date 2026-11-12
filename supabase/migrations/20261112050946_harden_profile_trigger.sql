-- Limit direct client execution; the auth.users trigger remains in place.
revoke execute on function public.handle_new_user_profile() from public, anon, authenticated;
