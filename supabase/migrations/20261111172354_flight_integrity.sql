-- Additive repair: a provider result belongs to an immutable segment version.
alter table public.records
  add column if not exists flight_plan_version bigint not null default 0,
  add column if not exists actual_match_plan_version bigint,
  add column if not exists actual_confirmed_request_id uuid;
alter table public.flight_match_previews add column if not exists plan_version bigint;

-- Offset proof for legacy provider ISO clocks. This pure parser exposes no data.
create or replace function public.flight_iso_offset_minutes(p_value text)
returns integer language sql immutable set search_path = public as $$
  with parsed as (select regexp_match(p_value, '([+-])([0-9]{2}):([0-9]{2})$') as parts)
  select case when p_value ~ '[Zz]$' then 0
    when parts is null or parts[2]::integer > 14 or parts[3]::integer > 59 then null
    else (case when parts[1] = '-' then -1 else 1 end) * (parts[2]::integer * 60 + parts[3]::integer) end from parsed;
$$;

-- Legacy Edge has no occurrence validator. Resolve candidate offsets locally
-- in PostgreSQL before trusting its unversioned preview. No table is accessed.
create or replace function public.flight_local_utc_offsets(p_date text, p_time text, p_timezone text)
returns integer[] language plpgsql stable set search_path = public as $$
declare wall timestamp; offsets integer[];
begin
  if p_date is null or p_time is null or p_timezone is null or p_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return '{}'::integer[]; end if;
  wall := (p_date || ' ' || p_time)::timestamp;
  with observed as (
    select distinct (extract(epoch from ((sample at time zone p_timezone) - (sample at time zone 'UTC'))) / 60)::integer as minutes
    from generate_series((wall at time zone 'UTC') - interval '36 hours', (wall at time zone 'UTC') + interval '36 hours', interval '1 hour') sample
  ), candidates as (
    select minutes, (wall at time zone 'UTC') - make_interval(mins => minutes) as instant from observed
  ) select coalesce(array_agg(minutes order by instant), '{}'::integer[]) into offsets from candidates where instant at time zone p_timezone = wall;
  return offsets;
exception when others then
  -- Malformed legacy dates/zones are unprovable, never a reason to abort an
  -- additive migration or silently assign an offset.
  return '{}'::integer[];
end;
$$;

create or replace function public.flight_stop_offset_proved(p_plan jsonb, p_actual jsonb)
returns boolean language sql stable set search_path = public as $$
  with resolved as (select public.flight_local_utc_offsets(p_plan->>'date', p_plan->>'time', p_plan->>'timezone') as offsets,
    coalesce(p_plan->'utc_offset_minutes', 'null'::jsonb) as selected)
  select coalesce(case when selected = 'null'::jsonb then cardinality(offsets) = 1
    when jsonb_typeof(selected) <> 'number' then false
    else selected in (select to_jsonb(value) from unnest(offsets) value)
      and selected = to_jsonb(public.flight_iso_offset_minutes(p_actual->'scheduled'->>'iso')) end, false) from resolved;
$$;

create or replace function public.flight_plan_signature(p_type text, p_details jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select case when p_type = 'flight' then jsonb_build_array(
    upper(regexp_replace(coalesce(p_details->>'flight_number', ''), '\s', '', 'g')),
    upper(trim(coalesce(p_details->'departure'->>'iata', ''))),
    coalesce(p_details->'departure'->>'date', ''), coalesce(p_details->'departure'->>'time', ''), coalesce(p_details->'departure'->>'timezone', ''), coalesce(p_details->'departure'->'utc_offset_minutes', 'null'::jsonb),
    upper(trim(coalesce(p_details->'arrival'->>'iata', ''))),
    coalesce(p_details->'arrival'->>'date', ''), coalesce(p_details->'arrival'->>'time', ''), coalesce(p_details->'arrival'->>'timezone', ''), coalesce(p_details->'arrival'->'utc_offset_minutes', 'null'::jsonb)
  ) else 'null'::jsonb end;
$$;

update public.records set flight_plan_version = case when transport_type = 'flight' then 1 else 0 end;
-- Only provably identical legacy schedules are adopted. Retain all historical
-- payloads, but never display an unprovable legacy result as the current segment.
update public.records set actual_match_plan_version = flight_plan_version
where transport_type = 'flight' and actual_info_matched and actual_info is not null and actual_match_request_id is not null
  and upper(regexp_replace(coalesce(actual_info->>'flight_number', ''), '\s', '', 'g')) = upper(regexp_replace(coalesce(transport_details->>'flight_number', ''), '\s', '', 'g'))
  and actual_info->'departure'->>'iata' = transport_details->'departure'->>'iata'
  and actual_info->'arrival'->>'iata' = transport_details->'arrival'->>'iata'
  and actual_info->'departure'->'scheduled'->>'date' = transport_details->'departure'->>'date'
  and actual_info->'departure'->'scheduled'->>'time' = transport_details->'departure'->>'time'
  and actual_info->'departure'->>'timezone' = transport_details->'departure'->>'timezone'
  and actual_info->'arrival'->'scheduled'->>'date' = transport_details->'arrival'->>'date'
  and actual_info->'arrival'->'scheduled'->>'time' = transport_details->'arrival'->>'time'
  and actual_info->'arrival'->>'timezone' = transport_details->'arrival'->>'timezone'
  and public.flight_stop_offset_proved(transport_details->'departure', actual_info->'departure')
  and public.flight_stop_offset_proved(transport_details->'arrival', actual_info->'arrival');
update public.records set actual_confirmed_request_id = actual_match_request_id
where actual_info_matched and actual_match_plan_version = flight_plan_version;
update public.records set actual_info_matched = false, actual_match_status = 'never',
  actual_match_request_id = null, actual_confirmed_request_id = null, actual_matched_at = null, actual_match_provider = null
where actual_info_matched and actual_match_plan_version is distinct from flight_plan_version;
-- Existing previews have no trustworthy plan snapshot; invalidate rather than
-- attach them retroactively to whatever the record happens to contain now.
delete from public.flight_match_previews where plan_version is null;

-- Compatibility bridge for the still-live legacy Edge during SQL-first rollout.
-- An old caller omits plan_version. Infer it only from the same locked owner /
-- record / claim UUID and a payload that proves the exact current schedule.
-- The extra signature comparison closes the old read-before-claim race: old
-- Edge ignores the claim's returned record and may query an obsolete snapshot.
create or replace function public.bind_legacy_flight_preview_version()
returns trigger language plpgsql security definer set search_path = public as $$
declare r public.records%rowtype; actual_plan jsonb;
begin
  if new.plan_version is not null then return new; end if;
  select * into r from public.records where id = new.record_id and user_id = new.user_id for update;
  if r.id is null or r.transport_type <> 'flight' or r.plan_status = 'cancelled' or r.actual_match_request_id is distinct from new.request_id then
    raise exception 'legacy flight preview has no current claim' using errcode = '23514';
  end if;
  if not coalesce(public.flight_stop_offset_proved(r.transport_details->'departure', new.actual_info->'departure'), false)
    or not coalesce(public.flight_stop_offset_proved(r.transport_details->'arrival', new.actual_info->'arrival'), false) then
    raise exception 'legacy flight preview does not prove local UTC occurrence' using errcode = '23514';
  end if;
  actual_plan := jsonb_build_object('flight_number', new.actual_info->>'flight_number',
    'departure', jsonb_build_object('iata', new.actual_info->'departure'->>'iata',
      'date', new.actual_info->'departure'->'scheduled'->>'date', 'time', new.actual_info->'departure'->'scheduled'->>'time', 'timezone', new.actual_info->'departure'->>'timezone',
      'utc_offset_minutes', case when coalesce(r.transport_details->'departure'->'utc_offset_minutes', 'null'::jsonb) <> 'null'::jsonb then public.flight_iso_offset_minutes(new.actual_info->'departure'->'scheduled'->>'iso') else null end),
    'arrival', jsonb_build_object('iata', new.actual_info->'arrival'->>'iata',
      'date', new.actual_info->'arrival'->'scheduled'->>'date', 'time', new.actual_info->'arrival'->'scheduled'->>'time', 'timezone', new.actual_info->'arrival'->>'timezone',
      'utc_offset_minutes', case when coalesce(r.transport_details->'arrival'->'utc_offset_minutes', 'null'::jsonb) <> 'null'::jsonb then public.flight_iso_offset_minutes(new.actual_info->'arrival'->'scheduled'->>'iso') else null end));
  if public.flight_plan_signature('flight', actual_plan) is distinct from public.flight_plan_signature(r.transport_type, r.transport_details) then
    raise exception 'legacy flight preview does not prove current segment' using errcode = '23514';
  end if;
  new.plan_version := r.flight_plan_version;
  return new;
end;
$$;
drop trigger if exists flight_previews_legacy_version on public.flight_match_previews;
create trigger flight_previews_legacy_version before insert on public.flight_match_previews
  for each row execute function public.bind_legacy_flight_preview_version();
alter table public.flight_match_previews alter column plan_version set not null;

create or replace function public.enforce_flight_plan_integrity()
returns trigger language plpgsql set search_path = public as $$
declare changed boolean;
begin
  if tg_op = 'INSERT' then
    new.flight_plan_version := case when new.transport_type = 'flight' then 1 else 0 end;
    if coalesce(auth.role(), '') = 'authenticated' then
      new.actual_info := null; new.actual_info_matched := false; new.actual_match_status := 'never';
      new.actual_matched_at := null; new.actual_match_provider := null; new.actual_match_request_id := null; new.actual_match_plan_version := null; new.actual_confirmed_request_id := null;
    end if;
    return new;
  end if;
  changed := public.flight_plan_signature(old.transport_type, old.transport_details)
    is distinct from public.flight_plan_signature(new.transport_type, new.transport_details);
  new.flight_plan_version := old.flight_plan_version + case when changed then 1 else 0 end;
  -- Authenticated table writes/CAS writes cannot forge service-only match state.
  if coalesce(auth.role(), '') = 'authenticated' then
    new.actual_info := old.actual_info; new.actual_info_matched := old.actual_info_matched; new.actual_match_status := old.actual_match_status;
    new.actual_matched_at := old.actual_matched_at; new.actual_match_provider := old.actual_match_provider;
    new.actual_match_request_id := old.actual_match_request_id; new.actual_match_plan_version := old.actual_match_plan_version; new.actual_confirmed_request_id := old.actual_confirmed_request_id;
  end if;
  if changed then
    new.actual_info_matched := false; new.actual_match_status := 'never';
    new.actual_matched_at := null; new.actual_match_provider := null; new.actual_match_request_id := null; new.actual_match_plan_version := null; new.actual_confirmed_request_id := null;
  end if;
  return new;
end;
$$;
drop trigger if exists records_flight_integrity on public.records;
create trigger records_flight_integrity before insert or update on public.records
  for each row execute function public.enforce_flight_plan_integrity();

create or replace function public.claim_flight_match_v2(p_user_id uuid, p_record_id uuid, p_request_id uuid, p_plan_version bigint, p_rematch boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.records%rowtype;
begin
  select * into r from public.records where id = p_record_id and user_id = p_user_id for update;
  if r.id is null or r.transport_type <> 'flight' then return jsonb_build_object('ok', false, 'code', 'RECORD_NOT_FOUND'); end if;
  if r.plan_status = 'cancelled' then return jsonb_build_object('ok', false, 'code', 'FLIGHT_CANCELLED'); end if;
  if r.flight_plan_version is distinct from p_plan_version then return jsonb_build_object('ok', false, 'code', 'PLAN_CHANGED'); end if;
  if r.actual_info_matched and r.actual_match_plan_version = r.flight_plan_version and r.actual_confirmed_request_id is not null and not p_rematch then
    return jsonb_build_object('ok', true, 'cached', true, 'record', to_jsonb(r));
  end if;
  if r.actual_match_status = 'matching' and r.updated_at > now() - interval '2 minutes' then return jsonb_build_object('ok', false, 'code', 'MATCH_IN_PROGRESS'); end if;
  update public.records set actual_match_status = 'matching', actual_match_request_id = p_request_id where id = p_record_id returning * into r;
  return jsonb_build_object('ok', true, 'cached', false, 'record', to_jsonb(r));
end;
$$;

-- During SQL-first rollout, reject unselected repeated clocks before old Edge
-- can spend upstream quota. Preserve the legacy cached response shape.
create or replace function public.claim_flight_match(p_user_id uuid, p_record_id uuid, p_request_id uuid, p_rematch boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.records%rowtype; stop_plan jsonb; offsets integer[]; selected jsonb; result jsonb;
begin
  select * into r from public.records where id = p_record_id and user_id = p_user_id for update;
  if r.id is null or r.transport_type <> 'flight' then return jsonb_build_object('ok', false, 'code', 'RECORD_NOT_FOUND'); end if;
  if r.plan_status = 'cancelled' then return jsonb_build_object('ok', false, 'code', 'FLIGHT_CANCELLED'); end if;
  foreach stop_plan in array array[r.transport_details->'departure', r.transport_details->'arrival'] loop
    offsets := public.flight_local_utc_offsets(stop_plan->>'date', stop_plan->>'time', stop_plan->>'timezone');
    selected := coalesce(stop_plan->'utc_offset_minutes', 'null'::jsonb);
    if cardinality(offsets) = 0 then return jsonb_build_object('ok', false, 'code', 'INVALID_FLIGHT_TIME'); end if;
    if selected = 'null'::jsonb and cardinality(offsets) <> 1 then return jsonb_build_object('ok', false, 'code', 'AMBIGUOUS_FLIGHT_TIME'); end if;
    if selected <> 'null'::jsonb and (jsonb_typeof(selected) <> 'number' or selected not in (select to_jsonb(value) from unnest(offsets) value)) then
      return jsonb_build_object('ok', false, 'code', 'INVALID_FLIGHT_OFFSET');
    end if;
  end loop;
  result := public.claim_flight_match_v2(p_user_id, p_record_id, p_request_id, r.flight_plan_version, p_rematch);
  if result->>'cached' = 'true' then return result || jsonb_build_object('actual_info', result->'record'->'actual_info', 'matched_at', result->'record'->'actual_matched_at'); end if;
  return result;
end;
$$;

create or replace function public.stage_flight_match_v2(p_user_id uuid, p_record_id uuid, p_request_id uuid, p_plan_version bigint, p_actual_info jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.records%rowtype;
begin
  select * into r from public.records where id = p_record_id and user_id = p_user_id for update;
  if r.id is null then return jsonb_build_object('ok', false, 'code', 'RECORD_NOT_FOUND'); end if;
  if r.plan_status = 'cancelled' then return jsonb_build_object('ok', false, 'code', 'FLIGHT_CANCELLED'); end if;
  if r.flight_plan_version is distinct from p_plan_version or r.actual_match_request_id is distinct from p_request_id then return jsonb_build_object('ok', false, 'code', 'PLAN_CHANGED'); end if;
  if jsonb_typeof(p_actual_info) is distinct from 'object' then raise exception 'invalid actual info'; end if;
  insert into public.flight_match_previews(request_id, record_id, user_id, plan_version, actual_info, expires_at)
    values(p_request_id, p_record_id, p_user_id, p_plan_version, p_actual_info, now() + interval '30 minutes')
    on conflict(request_id) do update set actual_info = excluded.actual_info, expires_at = excluded.expires_at
      where flight_match_previews.record_id = excluded.record_id and flight_match_previews.user_id = excluded.user_id and flight_match_previews.plan_version = excluded.plan_version;
  update public.records set actual_match_status = 'eligible' where id = p_record_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.confirm_flight_match_v2(p_user_id uuid, p_record_id uuid, p_request_id uuid, p_plan_version bigint, p_actual_info jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.records%rowtype; info jsonb;
begin
  select * into r from public.records where id = p_record_id and user_id = p_user_id for update;
  if r.id is null then return jsonb_build_object('ok', false, 'code', 'RECORD_NOT_FOUND'); end if;
  if r.plan_status = 'cancelled' then return jsonb_build_object('ok', false, 'code', 'FLIGHT_CANCELLED'); end if;
  if r.flight_plan_version is distinct from p_plan_version then return jsonb_build_object('ok', false, 'code', 'PLAN_CHANGED'); end if;
  -- A confirmed request remains idempotent while another rematch is pending.
  -- The pending claim UUID must never substitute for the result's UUID.
  if r.actual_info_matched and r.actual_match_plan_version = p_plan_version and r.actual_confirmed_request_id = p_request_id then return jsonb_build_object('ok', true, 'record', to_jsonb(r)); end if;
  if r.actual_match_request_id is distinct from p_request_id then return jsonb_build_object('ok', false, 'code', 'PLAN_CHANGED'); end if;
  if p_actual_info is not null then info := p_actual_info;
  else
    select actual_info into info from public.flight_match_previews where request_id = p_request_id and record_id = p_record_id and user_id = p_user_id and plan_version = p_plan_version and expires_at > now();
  end if;
  if info is null or jsonb_typeof(info) <> 'object' then return jsonb_build_object('ok', false, 'code', 'PREVIEW_EXPIRED'); end if;
  update public.records set actual_info = info, actual_info_matched = true, actual_match_status = 'matched',
    actual_matched_at = now(), actual_match_provider = 'aviationstack', actual_match_plan_version = p_plan_version, actual_confirmed_request_id = p_request_id
    where id = p_record_id returning * into r;
  delete from public.flight_match_previews where request_id = p_request_id and user_id = p_user_id;
  return jsonb_build_object('ok', true, 'record', to_jsonb(r));
end;
$$;

-- Old Edge can finish only a trustworthy version-bound stored preview (or
-- idempotently recover an already-confirmed current result). Never trust the
-- unversioned p_actual_info supplied by a legacy caller.
create or replace function public.finish_flight_match(p_user_id uuid, p_record_id uuid, p_request_id uuid, p_status text, p_actual_info jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.records%rowtype; preview_version bigint;
begin
  if p_status = 'matched' then
    select * into r from public.records where id = p_record_id and user_id = p_user_id for update;
    if r.id is null then return jsonb_build_object('ok', false, 'code', 'RECORD_NOT_FOUND'); end if;
    if r.plan_status = 'cancelled' then return jsonb_build_object('ok', false, 'code', 'FLIGHT_CANCELLED'); end if;
    if r.actual_info_matched and r.actual_match_plan_version = r.flight_plan_version and r.actual_confirmed_request_id = p_request_id then
      return public.confirm_flight_match_v2(p_user_id, p_record_id, p_request_id, r.flight_plan_version, null);
    end if;
    if r.actual_match_request_id is distinct from p_request_id then return jsonb_build_object('ok', false, 'code', 'PLAN_CHANGED'); end if;
    select plan_version into preview_version from public.flight_match_previews
      where request_id = p_request_id and record_id = p_record_id and user_id = p_user_id and expires_at > now();
    if preview_version is null then return jsonb_build_object('ok', false, 'code', 'PLAN_VERSION_REQUIRED'); end if;
    return public.confirm_flight_match_v2(p_user_id, p_record_id, p_request_id, preview_version, null);
  end if;
  if p_status not in ('not_found', 'failed') then raise exception 'invalid flight match status'; end if;
  update public.records set actual_match_status = p_status where id = p_record_id and user_id = p_user_id and actual_match_request_id = p_request_id returning * into r;
  return case when r.id is null then jsonb_build_object('ok', false, 'code', 'PLAN_CHANGED') else jsonb_build_object('ok', true, 'record', to_jsonb(r)) end;
end;
$$;

revoke all on function public.claim_flight_match_v2(uuid, uuid, uuid, bigint, boolean), public.stage_flight_match_v2(uuid, uuid, uuid, bigint, jsonb), public.confirm_flight_match_v2(uuid, uuid, uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.claim_flight_match_v2(uuid, uuid, uuid, bigint, boolean), public.stage_flight_match_v2(uuid, uuid, uuid, bigint, jsonb), public.confirm_flight_match_v2(uuid, uuid, uuid, bigint, jsonb) to service_role;
revoke all on function public.bind_legacy_flight_preview_version() from public, anon, authenticated;
