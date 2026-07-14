-- Assign the private owner entitlement to the existing Supabase Auth UUID.
-- Only a SHA-256 email digest is stored in source; the resulting entitlement
-- is permanently keyed by auth.users.id and cannot be obtained via invite.
do $$
declare
  owner_user_id uuid;
begin
  select id into owner_user_id
  from auth.users
  where encode(extensions.digest(lower(email), 'sha256'::text), 'hex') = '65a64dff94079533ab3aeecd6c5068f193532cf6f9c6c853bc76a0cdfef9df0c'
  order by created_at asc
  limit 1;

  if owner_user_id is null then
    raise exception 'Owner Auth account was not found; entitlement was not changed';
  end if;

  insert into public.api_entitlements (user_id, tier, source, revoked_at, updated_at)
  values (owner_user_id, 'owner', 'admin', null, now())
  on conflict (user_id) do update
  set tier = 'owner',
      source = 'admin',
      revoked_at = null,
      updated_at = now();

  raise notice 'Owner entitlement assigned to Auth UUID %', owner_user_id;
end;
$$;
