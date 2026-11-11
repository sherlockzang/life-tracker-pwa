-- Additive reliability migration. No existing content or quota policy is deleted.
create table public.client_mutation_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  request_body jsonb not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);
alter table public.client_mutation_receipts enable row level security;
revoke all on public.client_mutation_receipts from public, anon, authenticated;

-- A version must change even when two writes occur inside one transaction.
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;

create or replace function public.save_user_mutation(
  p_table text, p_payload jsonb, p_expected_updated_at timestamptz, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor uuid := auth.uid();
  allowed text[];
  pk text;
  entity_id uuid;
  field text;
  columns_sql text := '';
  values_sql text := '';
  updates_sql text := '';
  previous jsonb;
  saved jsonb;
  receipt public.client_mutation_receipts%rowtype;
  request_body jsonb;
  response_body jsonb;
begin
  if actor is null or auth.role() is distinct from 'authenticated' or p_request_id is null
     or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Authenticated mutation required' using errcode = '42501';
  end if;
  case p_table
    when 'records' then allowed := array['id','user_id','record_type','content','notes','amount','currency','expense_category','location','event_at','trip_id','plan_status','sort_order','parent_plan_id','transport_type','transport_details','schedule_details','image_path'];
    when 'trips' then allowed := array['id','user_id','name','destination','start_date','end_date','timezone','archived_at'];
    when 'user_settings' then allowed := array['user_id','base_currency','theme'];
    when 'profiles' then allowed := array['user_id','display_name','avatar_url','avatar_color','has_seen_onboarding','last_seen_version'];
    when 'exchange_rates' then allowed := array['id','user_id','base_currency','quote_currency','rate','rate_date','source'];
    else raise exception 'Unsupported mutation table' using errcode = '42501';
  end case;
  if (p_payload->>'user_id')::uuid is distinct from actor then
    raise exception 'Mutation owner mismatch' using errcode = '42501';
  end if;
  pk := case when p_table in ('profiles','user_settings') then 'user_id' else 'id' end;
  entity_id := (p_payload->>pk)::uuid;
  if entity_id is null then raise exception 'Entity id required' using errcode = '22023'; end if;
  for field in select jsonb_object_keys(p_payload) loop
    if not (field = any(allowed)) then raise exception 'Non-editable mutation field' using errcode = '42501'; end if;
  end loop;
  request_body := jsonb_build_object('table',p_table,'payload',p_payload,'expected',p_expected_updated_at);
  perform pg_advisory_xact_lock(hashtextextended('client-request:' || actor || ':' || p_request_id, 0));
  select * into receipt from public.client_mutation_receipts where user_id = actor and request_id = p_request_id;
  if found then
    if receipt.request_body is distinct from request_body then raise exception 'Request id reused with different payload' using errcode = '22023'; end if;
    return receipt.response_body;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('client-entity:' || p_table || ':' || entity_id, 0));
  execute format('select to_jsonb(t) from public.%I t where %I = $1 for update',p_table,pk) into previous using entity_id;
  if previous is not null and (previous->>'user_id')::uuid is distinct from actor then
    raise exception 'Entity owner mismatch' using errcode = '42501';
  end if;
  if (previous is null and p_expected_updated_at is not null)
    or (previous is not null and (p_expected_updated_at is null or (previous->>'updated_at')::timestamptz is distinct from p_expected_updated_at)) then
    return jsonb_build_object('ok',false,'code','CONFLICT');
  end if;
  for field in select jsonb_object_keys(p_payload) loop
    columns_sql := concat_ws(',',nullif(columns_sql,''),format('%I',field));
    values_sql := concat_ws(',',nullif(values_sql,''),format('r.%I',field));
    if field not in ('id','user_id') then updates_sql := concat_ws(',',nullif(updates_sql,''),format('%I = r.%I',field,field)); end if;
  end loop;
  if previous is null then
    execute format('insert into public.%I as saved (%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(saved)',p_table,columns_sql,values_sql,p_table) into saved using p_payload;
  else
    if updates_sql = '' then raise exception 'No editable fields' using errcode = '22023'; end if;
    execute format('update public.%I as saved set %s from jsonb_populate_record(null::public.%I,$1) r where saved.%I = $2 and saved.user_id = $3 returning to_jsonb(saved)',p_table,updates_sql,p_table,pk) into saved using p_payload,entity_id,actor;
  end if;
  response_body := jsonb_build_object('ok',true,'row',saved);
  insert into public.client_mutation_receipts(user_id,request_id,request_body,response_body) values(actor,p_request_id,request_body,response_body);
  return response_body;
end;
$$;
revoke all on function public.save_user_mutation(text,jsonb,timestamptz,uuid) from public,anon;
grant execute on function public.save_user_mutation(text,jsonb,timestamptz,uuid) to authenticated;
