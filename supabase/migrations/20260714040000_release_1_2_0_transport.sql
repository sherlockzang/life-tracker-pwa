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
    '行程规划新增飞机、铁路和市内交通三类结构化模板。飞机可记录航司、航班号、出发与到达日期时间、机场、航站楼、登机口、座位和机型；铁路可记录铁路系统、车次、车站与座席；市内交通可记录起终点、预计时间和路线说明。',
    '交通计划拥有更清晰的智能摘要：时间线会自动提炼航班号、车次、站点与时间；保存后仍可快速更新登机口，也可以在抵达后补记实际乘车路线。',
    'DeepSeek API 配置完成后，可在“行程规划 → 市内交通”中填写起点、终点和预计时间，再点击“AI 查询路线”。检查并编辑返回的线路、换乘、预计用时与票价参考后，点击“填入路线”并保存；AI 结果不会自动写入记录，查询不可用时仍可手动填写。',
    '设置页新增永久“使用说明”，并新增长期保留的致谢栏目。',
    '优化 iPhone 17 Pro 灵动岛安全区域、桌面 PWA 显示与部分移动端交互。'
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
