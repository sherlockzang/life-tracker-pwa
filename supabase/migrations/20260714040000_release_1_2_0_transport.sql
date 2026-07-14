-- Life Tracker 1.2.0 structured transport plans and release notes.
-- Existing records remain general plans because both new columns are nullable.

alter table public.records
  add column if not exists transport_type text,
  add column if not exists transport_details jsonb;

alter table public.records drop constraint if exists records_transport_type_check;
alter table public.records add constraint records_transport_type_check
  check (transport_type is null or transport_type in ('flight', 'rail', 'metro'));

alter table public.records drop constraint if exists records_transport_pair_check;
alter table public.records add constraint records_transport_pair_check
  check ((transport_type is null and transport_details is null) or (transport_type is not null and transport_details is not null));

alter table public.records drop constraint if exists records_transport_details_object_check;
alter table public.records add constraint records_transport_details_object_check
  check (transport_details is null or jsonb_typeof(transport_details) = 'object');

alter table public.records drop constraint if exists records_transport_plan_only_check;
alter table public.records add constraint records_transport_plan_only_check
  check (transport_type is null or (record_type = 'trip' and trip_id is not null and parent_plan_id is null));

insert into public.changelogs (version, summary, created_at)
values (
  '1.2.0',
  array[
    '行程规划新增飞机、高铁和地铁三类结构化交通模板',
    '时间线自动显示航班号、车次和起终点等关键信息',
    '支持随时更新登机口，并为地铁计划补记实际路线',
    '新增由 Supabase Edge Function 安全代理的 DeepSeek 路线查询与确认填入',
    '优化 iPhone 17 Pro 灵动岛安全区域和桌面 PWA 显示',
    '设置页新增长期保留的致谢栏目'
  ],
  now()
)
on conflict (version) do update set
  summary = excluded.summary,
  created_at = excluded.created_at;

-- Future accounts start on this version; existing profiles are deliberately
-- untouched so current users can still receive the 1.2.0 release note.
create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    user_id,
    display_name,
    avatar_color,
    has_seen_onboarding,
    last_seen_version
  ) values (
    new.id,
    left(coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(split_part(new.email, '@', 1), ''),
      'Life Tracker 用户'
    ), 40),
    '#0A84FF',
    false,
    '1.2.0'
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;
