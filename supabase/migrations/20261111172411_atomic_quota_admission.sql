-- Preserve existing quotas; fix only concurrent admission ordering.
create or replace function public.consume_api_quota(
  p_user_id uuid,
  p_demo_session_id uuid,
  p_feature text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text := 'standard';
  v_service text;
  v_group text;
  v_principal text;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
  v_day_end timestamptz;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
  v_month_end timestamptz;
  v_keys text[] := array[]::text[];
  v_limits integer[] := array[]::integer[];
  v_groups text[] := array[]::text[];
  v_starts timestamptz[] := array[]::timestamptz[];
  v_ends timestamptz[] := array[]::timestamptz[];
  v_key text;
  v_used integer;
  v_limit integer;
  v_index integer;
  v_cooldown timestamptz;
begin
  v_day_end := (date_trunc('day', now() at time zone 'Asia/Shanghai') + interval '1 day') at time zone 'Asia/Shanghai';
  v_month_end := (date_trunc('month', now() at time zone 'Asia/Shanghai') + interval '1 month') at time zone 'Asia/Shanghai';

  if p_request_id is null or p_feature not in ('flight_actual_match', 'route', 'expense_parse', 'note_polish', 'trip_recap', 'daily_summary') then
    return jsonb_build_object('allowed', false, 'code', 'INVALID_REQUEST');
  end if;
  if (p_user_id is null) = (p_demo_session_id is null) then
    return jsonb_build_object('allowed', false, 'code', 'INVALID_PRINCIPAL');
  end if;
  -- Frequency admission and bucket reservation share the same atomic lock.
  perform pg_advisory_xact_lock(hashtextextended('life-tracker-api-quota', 0));
  if exists (select 1 from public.api_usage_events where request_id = p_request_id) then
    return jsonb_build_object('allowed', false, 'code', 'DUPLICATE_REQUEST', 'duplicate', true);
  end if;

  if p_demo_session_id is not null then
    if not exists (select 1 from public.demo_sessions where id = p_demo_session_id and expires_at > now()) then
      return jsonb_build_object('allowed', false, 'code', 'DEMO_SESSION_EXPIRED');
    end if;
    v_tier := 'demo';
    v_principal := 'demo:' || p_demo_session_id::text;
  else
    select tier into v_tier from public.api_entitlements where user_id = p_user_id and revoked_at is null;
    v_tier := coalesce(v_tier, 'standard');
    v_principal := 'user:' || p_user_id::text;
  end if;

  v_service := case when p_feature = 'flight_actual_match' then 'aviation' else 'deepseek' end;
  v_group := case when p_feature = 'flight_actual_match' then 'flight'
                  when p_feature in ('route', 'expense_parse', 'note_polish') then 'light'
                  when p_feature = 'trip_recap' then 'recap' else 'summary' end;

  if v_tier = 'demo' and p_feature in ('flight_actual_match', 'trip_recap', 'daily_summary') then
    return jsonb_build_object('allowed', false, 'code', 'DEMO_MOCK_ONLY', 'tier', v_tier);
  end if;

  if v_service = 'deepseek' and v_tier <> 'owner' then
    select until_at into v_cooldown from public.api_cooldowns where principal_key = v_principal and until_at > now();
    if v_cooldown is not null then
      return jsonb_build_object('allowed', false, 'code', 'COOLDOWN', 'tier', v_tier, 'retry_at', v_cooldown);
    end if;
    if (select count(*) from public.api_usage_events where
        ((p_user_id is not null and user_id = p_user_id) or (p_demo_session_id is not null and demo_session_id = p_demo_session_id))
        and service = 'deepseek' and counted and created_at > now() - interval '60 seconds') >= 10 then
      insert into public.api_cooldowns(principal_key, reason, until_at)
      values (v_principal, 'burst_limit', now() + interval '5 minutes')
      on conflict (principal_key) do update set until_at = excluded.until_at, reason = excluded.reason, updated_at = now();
      return jsonb_build_object('allowed', false, 'code', 'COOLDOWN', 'tier', v_tier, 'retry_at', now() + interval '5 minutes');
    end if;
  end if;

  if p_feature = 'flight_actual_match' then
    if v_tier = 'demo' then
      return jsonb_build_object('allowed', false, 'code', 'DEMO_MOCK_ONLY', 'tier', v_tier);
    end if;

    -- Every real request consumes the provider-wide pool.
    v_keys := array['aviation:global:' || to_char(v_month_start at time zone 'Asia/Shanghai', 'YYYY-MM')];
    v_limits := array[100];
    v_groups := array['flight'];
    v_starts := array[v_month_start];
    v_ends := array[v_month_end];

    if v_tier <> 'owner' then
      v_keys := array_append(v_keys, 'aviation:shared:' || to_char(v_month_start at time zone 'Asia/Shanghai', 'YYYY-MM'));
      v_limits := array_append(v_limits, 80);
      v_groups := array_append(v_groups, 'flight');
      v_starts := array_append(v_starts, v_month_start);
      v_ends := array_append(v_ends, v_month_end);
      if v_tier = 'standard' then
        v_keys := array_append(v_keys, 'aviation:standard:' || p_user_id::text || ':' || to_char(v_day_start at time zone 'Asia/Shanghai', 'YYYY-MM-DD'));
        v_limits := array_append(v_limits, 2);
        v_groups := array_append(v_groups, 'flight');
        v_starts := array_append(v_starts, v_day_start);
        v_ends := array_append(v_ends, v_day_end);
      end if;
    end if;
  elsif v_group = 'light' then
    -- Owner AI has no product quota. Requests are still logged for diagnostics.
    if v_tier <> 'owner' then
      v_keys := array['deepseek:light:shared:' || to_char(v_month_start at time zone 'Asia/Shanghai', 'YYYY-MM')];
      v_limits := array[10000]; v_groups := array['light']; v_starts := array[v_month_start]; v_ends := array[v_month_end];
      if v_tier = 'standard' then
        v_keys := array_append(v_keys, 'deepseek:light:standard:' || p_user_id::text || ':' || to_char(v_day_start at time zone 'Asia/Shanghai', 'YYYY-MM-DD'));
        v_limits := array_append(v_limits, 15); v_groups := array_append(v_groups, 'light'); v_starts := array_append(v_starts, v_day_start); v_ends := array_append(v_ends, v_day_end);
      elsif v_tier = 'demo' then
        v_keys := array_append(v_keys, 'deepseek:light:demo:' || p_demo_session_id::text || ':' || to_char(v_day_start at time zone 'Asia/Shanghai', 'YYYY-MM-DD'));
        v_limits := array_append(v_limits, 2); v_groups := array_append(v_groups, 'light'); v_starts := array_append(v_starts, v_day_start); v_ends := array_append(v_ends, v_day_end);
        v_keys := array_append(v_keys, 'deepseek:light:demo-global:' || to_char(v_day_start at time zone 'Asia/Shanghai', 'YYYY-MM-DD'));
        v_limits := array_append(v_limits, 100); v_groups := array_append(v_groups, 'light'); v_starts := array_append(v_starts, v_day_start); v_ends := array_append(v_ends, v_day_end);
      end if;
    end if;
  elsif p_feature = 'trip_recap' then
    if v_tier = 'demo' then return jsonb_build_object('allowed', false, 'code', 'DEMO_MOCK_ONLY', 'tier', v_tier); end if;
    if v_tier <> 'owner' then
      v_limit := case v_tier when 'friend' then 10 else 3 end;
      v_keys := array['deepseek:recap:' || v_tier || ':' || p_user_id::text || ':' || to_char(v_month_start at time zone 'Asia/Shanghai', 'YYYY-MM')];
      v_limits := array[v_limit]; v_groups := array['recap']; v_starts := array[v_month_start]; v_ends := array[v_month_end];
    end if;
  elsif p_feature = 'daily_summary' and v_tier = 'standard' then
    v_keys := array['deepseek:summary:standard:' || p_user_id::text || ':' || to_char(v_day_start at time zone 'Asia/Shanghai', 'YYYY-MM-DD')];
    v_limits := array[1]; v_groups := array['summary']; v_starts := array[v_day_start]; v_ends := array[v_day_end];
  end if;

  if coalesce(array_length(v_keys, 1), 0) > 0 then
    for v_index in 1..array_length(v_keys, 1) loop
      v_key := v_keys[v_index];
      insert into public.api_quota_buckets(bucket_key, service, quota_group, period_start, period_end, limit_value)
      values (v_key, v_service, v_groups[v_index], v_starts[v_index], v_ends[v_index], v_limits[v_index])
      on conflict (bucket_key) do update set limit_value = excluded.limit_value, period_end = excluded.period_end, updated_at = now();
      select used_value, limit_value into v_used, v_limit from public.api_quota_buckets where bucket_key = v_key for update;
      if v_used >= v_limit then
        return jsonb_build_object('allowed', false,
          'code', case when v_service = 'aviation' then 'AVIATION_QUOTA_EXCEEDED'
                       when v_group = 'light' and v_key like '%:shared:%' then 'AI_MONTHLY_QUOTA_EXCEEDED'
                       else 'AI_QUOTA_EXCEEDED' end,
          'tier', v_tier, 'reset_at', v_ends[v_index]);
      end if;
    end loop;
    for v_index in 1..array_length(v_keys, 1) loop
      update public.api_quota_buckets set used_value = used_value + 1, updated_at = now() where bucket_key = v_keys[v_index];
    end loop;
  end if;

  insert into public.api_usage_events(request_id, user_id, demo_session_id, service, feature, quota_group, tier)
  values (p_request_id, p_user_id, p_demo_session_id, v_service, p_feature, v_group, v_tier);
  return jsonb_build_object('allowed', true, 'tier', v_tier, 'service', v_service, 'quota_group', v_group);
exception when unique_violation then
  return jsonb_build_object('allowed', false, 'code', 'DUPLICATE_REQUEST', 'duplicate', true);
end;
$$;
