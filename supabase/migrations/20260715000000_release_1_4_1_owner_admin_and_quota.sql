-- Life Tracker 1.4.1: owner administration, quota correction, privacy fixes.

-- Replacing an existing object with Storage upsert performs an ownership read
-- before update. Without this SELECT policy the second avatar upload is denied.
drop policy if exists "avatars_select_own" on storage.objects;
create policy "avatars_select_own" on storage.objects for select to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create table if not exists public.owner_entitlement_audit (
  id bigint generated always as identity primary key,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  old_tier text not null check (old_tier in ('standard', 'friend', 'owner')),
  new_tier text not null check (new_tier in ('standard', 'friend')),
  created_at timestamptz not null default now()
);

create index if not exists owner_entitlement_audit_created_idx
  on public.owner_entitlement_audit(created_at desc);
create index if not exists owner_entitlement_audit_target_idx
  on public.owner_entitlement_audit(target_user_id, created_at desc);

alter table public.owner_entitlement_audit enable row level security;
revoke all on public.owner_entitlement_audit from anon, authenticated;

create or replace function public.owner_set_user_tier(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_new_tier text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_tier text;
  v_old_tier text;
begin
  select tier into v_actor_tier
  from public.api_entitlements
  where user_id = p_actor_user_id and revoked_at is null;

  if v_actor_tier is distinct from 'owner' then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  if p_new_tier not in ('standard', 'friend') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TIER');
  end if;
  if not exists (select 1 from auth.users where id = p_target_user_id) then
    return jsonb_build_object('ok', false, 'code', 'USER_NOT_FOUND');
  end if;

  select tier into v_old_tier
  from public.api_entitlements
  where user_id = p_target_user_id and revoked_at is null
  for update;
  v_old_tier := coalesce(v_old_tier, 'standard');

  -- Owner identities are immutable from the product admin panel.
  if v_old_tier = 'owner' then
    return jsonb_build_object('ok', false, 'code', 'OWNER_LOCKED');
  end if;

  insert into public.api_entitlements(user_id, tier, source, granted_at, revoked_at, updated_at)
  values (p_target_user_id, p_new_tier, 'admin', now(), null, now())
  on conflict (user_id) do update set
    tier = excluded.tier,
    source = 'admin',
    granted_at = case when api_entitlements.tier is distinct from excluded.tier then now() else api_entitlements.granted_at end,
    revoked_at = null,
    updated_at = now();

  if v_old_tier is distinct from p_new_tier then
    insert into public.owner_entitlement_audit(actor_user_id, target_user_id, old_tier, new_tier)
    values (p_actor_user_id, p_target_user_id, v_old_tier, p_new_tier);
  end if;

  return jsonb_build_object('ok', true, 'old_tier', v_old_tier, 'new_tier', p_new_tier);
end;
$$;

revoke all on function public.owner_set_user_tier(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.owner_set_user_tier(uuid, uuid, text) to service_role;

-- The provider account has one hard monthly allowance of 100 calls. Other
-- users still share at most 80, leaving at least 20 available to Owner. Owner
-- may also use any capacity that the shared pool has not consumed.
insert into public.api_quota_policies(policy_key, service, quota_group, tier, period_type, limit_value, soft_limit)
values
  ('aviation_global_monthly', 'aviation', 'flight', 'shared', 'month', 100, false),
  ('aviation_shared_monthly', 'aviation', 'flight', 'shared', 'month', 80, false)
on conflict (policy_key) do update set
  service = excluded.service,
  quota_group = excluded.quota_group,
  tier = excluded.tier,
  period_type = excluded.period_type,
  limit_value = excluded.limit_value,
  soft_limit = excluded.soft_limit,
  updated_at = now();

delete from public.api_quota_policies where policy_key = 'aviation_owner_monthly';

-- Preserve usage already counted earlier in the current month when moving from
-- separate owner/shared buckets into the provider-wide bucket.
with period as (
  select
    date_trunc('month', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai' as starts_at,
    (date_trunc('month', now() at time zone 'Asia/Shanghai') + interval '1 month') at time zone 'Asia/Shanghai' as ends_at,
    to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM') as label
), existing as (
  select coalesce(sum(b.used_value), 0)::integer as used_value
  from public.api_quota_buckets b, period p
  where b.bucket_key in ('aviation:owner:' || p.label, 'aviation:shared:' || p.label)
)
insert into public.api_quota_buckets(bucket_key, service, quota_group, period_start, period_end, limit_value, used_value)
select 'aviation:global:' || p.label, 'aviation', 'flight', p.starts_at, p.ends_at, 100, e.used_value
from period p cross join existing e
on conflict (bucket_key) do nothing;

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
  v_day_end := v_day_start + interval '1 day';
  v_month_end := v_month_start + interval '1 month';

  if p_request_id is null or p_feature not in ('flight_actual_match', 'route', 'expense_parse', 'note_polish', 'trip_recap', 'daily_summary') then
    return jsonb_build_object('allowed', false, 'code', 'INVALID_REQUEST');
  end if;
  if (p_user_id is null) = (p_demo_session_id is null) then
    return jsonb_build_object('allowed', false, 'code', 'INVALID_PRINCIPAL');
  end if;
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

  -- One transaction-level advisory lock protects all bucket checks and updates.
  perform pg_advisory_xact_lock(hashtextextended('life-tracker-api-quota', 0));
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

insert into public.changelogs(version, summary, created_at)
values (
  '1.4.1',
  array[
    '新增仅 Owner 可见的账号管理后台，可按邮箱查找用户、查看账号与智能服务用量，并在 Standard 与 Friend 权限之间调整；Owner 身份不可修改，所有权限变更都会写入审计日志',
    '重构航班月度额度：所有账号共用服务商 100 次总额度，非 Owner 账号继续共享最多 80 次；Owner 可使用总池中全部剩余额度，其他用户未使用的部分不再闲置',
    '修正 Owner 智能服务额度：AI 不再被 200 次轻量请求或 50 次旅行回顾误拦截，设置页也不再把防故障参考值显示成硬限额',
    '隐私与数据说明现可打开查看，明确介绍账号级数据隔离、服务端密钥保护、Owner 后台边界与验证码会话安全',
    '修复更换头像时可能出现的行级安全策略错误，并优化智能服务额度展示'
  ],
  now()
)
on conflict (version) do update set summary = excluded.summary, created_at = excluded.created_at;
