# 完整有序数据库迁移精确参考

快照：2026-11-12，V2.1.0 本地候选工作树，未声明部署。由 build-documentation-reference.mjs 机械生成；每块保存原始字节和 SHA256。

先读[验收记录](../ACCEPTANCE-2026-10-01.md)、[重建规范](../REBUILD-SPEC.md)和[恢复流程](../DEPLOYMENT-ROLLBACK.md)。这是代码快照，不保证所有发布门禁已完成。SQL 含历史身份种子，新项目先安全替换。包中无云端历史数据、用户上传图片或服务私钥。

## supabase/migrations/20260714000000_initial_schema.sql

<!-- source: supabase/migrations/20260714000000_initial_schema.sql sha256: 4b6232050bd02f0cffcbfba14b6bc37e71f90a401711ea725f80862aed565c3a encoding: utf8 -->
````sql
-- Life Tracker initial schema
-- Run in the Supabase SQL editor or with `supabase db push`.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  base_currency text not null default 'USD' check (base_currency in ('USD','JPY','EUR','GBP','CNY','HKD','SGD','KRW','AUD','NZD','CHF','CAD','THB')),
  theme text not null default 'system' check (theme in ('system','dark','light')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  destination text not null default '',
  start_date date not null,
  end_date date not null,
  timezone text not null default 'UTC',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_date_order check (end_date >= start_date),
  constraint trips_owner_pair unique (id, user_id)
);

create table if not exists public.records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  record_type text not null check (record_type in ('expense','trip','note')),
  content text not null check (char_length(trim(content)) between 1 and 4000),
  notes text,
  amount numeric(18,4),
  currency text check (currency is null or currency in ('USD','JPY','EUR','GBP','CNY','HKD','SGD','KRW','AUD','NZD','CHF','CAD','THB')),
  expense_category text check (expense_category is null or expense_category in ('food','transport','shopping','stay','entertainment','other')),
  location text,
  event_at timestamptz not null default now(),
  trip_id uuid references public.trips(id) on delete restrict,
  plan_status text check (plan_status is null or plan_status in ('planned','completed','cancelled')),
  sort_order numeric(18,4),
  parent_plan_id uuid references public.records(id) on delete set null,
  image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint records_owner_pair unique (id, user_id),
  constraint records_not_own_parent check (parent_plan_id is null or parent_plan_id <> id),
  constraint records_expense_fields check (
    (record_type = 'expense' and amount is not null and amount >= 0 and currency is not null and expense_category is not null)
    or
    (record_type <> 'expense' and amount is null and currency is null and expense_category is null)
  ),
  constraint records_plan_fields check (
    record_type = 'trip'
    or (plan_status is null and sort_order is null)
  ),
  constraint records_plan_requires_status check (
    not (record_type = 'trip' and trip_id is not null) or plan_status is not null
  ),
  constraint records_parent_is_actual check (
    parent_plan_id is null or record_type in ('expense','note')
  ),
  constraint records_image_note_only check (
    image_path is null or record_type = 'note'
  )
);

create table if not exists public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  base_currency text not null check (base_currency in ('USD','JPY','EUR','GBP','CNY','HKD','SGD','KRW','AUD','NZD','CHF','CAD','THB')),
  quote_currency text not null check (quote_currency in ('USD','JPY','EUR','GBP','CNY','HKD','SGD','KRW','AUD','NZD','CHF','CAD','THB')),
  rate numeric(20,10) not null check (rate > 0),
  rate_date date not null,
  source text not null default 'api' check (source in ('api','manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exchange_rates_pair check (base_currency <> quote_currency)
);

create index if not exists trips_owner_dates_idx on public.trips(user_id, start_date, end_date);
create index if not exists records_owner_timeline_idx on public.records(user_id, event_at desc);
create index if not exists records_owner_type_timeline_idx on public.records(user_id, record_type, event_at desc);
create index if not exists records_trip_day_order_idx on public.records(user_id, trip_id, event_at, sort_order) where trip_id is not null;
create index if not exists records_parent_idx on public.records(user_id, parent_plan_id, event_at) where parent_plan_id is not null;
create index if not exists exchange_rates_lookup_idx on public.exchange_rates(user_id, base_currency, quote_currency, rate_date desc);

create or replace function public.validate_record_relations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_row public.records%rowtype;
begin
  if new.trip_id is not null and not exists (
    select 1 from public.trips t where t.id = new.trip_id and t.user_id = new.user_id
  ) then
    raise exception 'trip must belong to the same user';
  end if;

  if new.parent_plan_id is not null then
    select * into parent_row from public.records r where r.id = new.parent_plan_id;
    if parent_row.id is null or parent_row.user_id <> new.user_id or parent_row.record_type <> 'trip' then
      raise exception 'parent plan must be a trip record owned by the same user';
    end if;
    if new.trip_id is distinct from parent_row.trip_id then
      raise exception 'actual record and parent plan must belong to the same trip';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists records_validate_relations on public.records;
create trigger records_validate_relations before insert or update of user_id, trip_id, parent_plan_id on public.records
for each row execute function public.validate_record_relations();

drop trigger if exists user_settings_updated_at on public.user_settings;
create trigger user_settings_updated_at before update on public.user_settings for each row execute function public.set_updated_at();
drop trigger if exists trips_updated_at on public.trips;
create trigger trips_updated_at before update on public.trips for each row execute function public.set_updated_at();
drop trigger if exists records_updated_at on public.records;
create trigger records_updated_at before update on public.records for each row execute function public.set_updated_at();
drop trigger if exists exchange_rates_updated_at on public.exchange_rates;
create trigger exchange_rates_updated_at before update on public.exchange_rates for each row execute function public.set_updated_at();

alter table public.user_settings enable row level security;
alter table public.trips enable row level security;
alter table public.records enable row level security;
alter table public.exchange_rates enable row level security;

drop policy if exists "settings_select_own" on public.user_settings;
create policy "settings_select_own" on public.user_settings for select using (auth.uid() = user_id);
drop policy if exists "settings_insert_own" on public.user_settings;
create policy "settings_insert_own" on public.user_settings for insert with check (auth.uid() = user_id);
drop policy if exists "settings_update_own" on public.user_settings;
create policy "settings_update_own" on public.user_settings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "settings_delete_own" on public.user_settings;
create policy "settings_delete_own" on public.user_settings for delete using (auth.uid() = user_id);

drop policy if exists "trips_select_own" on public.trips;
create policy "trips_select_own" on public.trips for select using (auth.uid() = user_id);
drop policy if exists "trips_insert_own" on public.trips;
create policy "trips_insert_own" on public.trips for insert with check (auth.uid() = user_id);
drop policy if exists "trips_update_own" on public.trips;
create policy "trips_update_own" on public.trips for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "trips_delete_own" on public.trips;
create policy "trips_delete_own" on public.trips for delete using (auth.uid() = user_id);

drop policy if exists "records_select_own" on public.records;
create policy "records_select_own" on public.records for select using (auth.uid() = user_id);
drop policy if exists "records_insert_own" on public.records;
create policy "records_insert_own" on public.records for insert with check (auth.uid() = user_id);
drop policy if exists "records_update_own" on public.records;
create policy "records_update_own" on public.records for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "records_delete_own" on public.records;
create policy "records_delete_own" on public.records for delete using (auth.uid() = user_id);

drop policy if exists "rates_select_own" on public.exchange_rates;
create policy "rates_select_own" on public.exchange_rates for select using (auth.uid() = user_id);
drop policy if exists "rates_insert_own" on public.exchange_rates;
create policy "rates_insert_own" on public.exchange_rates for insert with check (auth.uid() = user_id);
drop policy if exists "rates_update_own" on public.exchange_rates;
create policy "rates_update_own" on public.exchange_rates for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "rates_delete_own" on public.exchange_rates;
create policy "rates_delete_own" on public.exchange_rates for delete using (auth.uid() = user_id);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.user_settings, public.trips, public.records, public.exchange_rates to authenticated;
revoke all on public.user_settings, public.trips, public.records, public.exchange_rates from anon;

-- Phase 2 private image bucket. The app stores only object paths in records.image_path.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('record-images', 'record-images', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "record_images_select_own" on storage.objects;
create policy "record_images_select_own" on storage.objects for select to authenticated
using (bucket_id = 'record-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "record_images_insert_own" on storage.objects;
create policy "record_images_insert_own" on storage.objects for insert to authenticated
with check (bucket_id = 'record-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "record_images_update_own" on storage.objects;
create policy "record_images_update_own" on storage.objects for update to authenticated
using (bucket_id = 'record-images' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'record-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "record_images_delete_own" on storage.objects;
create policy "record_images_delete_own" on storage.objects for delete to authenticated
using (bucket_id = 'record-images' and (storage.foldername(name))[1] = auth.uid()::text);

````

## supabase/migrations/20260714010000_profiles_changelogs.sql

<!-- source: supabase/migrations/20260714010000_profiles_changelogs.sql sha256: e549cfb85cd281f4dd9b971fbdf6362784ed938b30c21e84d671a84f39d74e59 encoding: utf8 -->
````sql
-- Life Tracker profile, onboarding, changelog, and avatar support.
-- This migration only adds new objects and does not alter existing records.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 40),
  avatar_url text,
  avatar_color text not null default '#0A84FF' check (avatar_color ~ '^#[0-9A-Fa-f]{6}$'),
  has_seen_onboarding boolean not null default false,
  last_seen_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.changelogs (
  id uuid primary key default gen_random_uuid(),
  version text not null unique check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  summary text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists changelogs_created_at_idx on public.changelogs(created_at desc);

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.changelogs enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select
using (auth.uid() = user_id);
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles for insert
with check (auth.uid() = user_id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update
using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "profiles_delete_own" on public.profiles;
create policy "profiles_delete_own" on public.profiles for delete
using (auth.uid() = user_id);

drop policy if exists "changelogs_read_authenticated" on public.changelogs;
create policy "changelogs_read_authenticated" on public.changelogs for select to authenticated
using (true);

grant select, insert, update, delete on public.profiles to authenticated;
grant select on public.changelogs to authenticated;
revoke all on public.profiles, public.changelogs from anon;
revoke insert, update, delete on public.changelogs from authenticated;

-- Existing accounts should not receive the new-account tour, but should be
-- eligible for release notes after this migration is deployed.
insert into public.profiles (
  user_id,
  display_name,
  avatar_color,
  has_seen_onboarding,
  last_seen_version
)
select
  id,
  left(coalesce(
    nullif(trim(raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(raw_user_meta_data ->> 'full_name'), ''),
    nullif(split_part(email, '@', 1), ''),
    'Life Tracker 用户'
  ), 40),
  '#0A84FF',
  true,
  '1.0.0'
from auth.users
on conflict (user_id) do nothing;

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
    '1.1.0'
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_create_profile on auth.users;
create trigger on_auth_user_created_create_profile
after insert on auth.users
for each row execute function public.handle_new_user_profile();

insert into public.changelogs (version, summary, created_at)
values (
  '1.0.0',
  array[
    '支持消费、行程和随记三类生活记录',
    '新增行程规划、打卡与实际记录关联',
    '提供消费统计和多币种换算',
    '支持离线记录与自动同步'
  ],
  '2026-07-14T00:00:00Z'::timestamptz
)
on conflict (version) do nothing;

insert into public.changelogs (version, summary, created_at)
values (
  '1.1.0',
  array[
    '全面升级为更简洁的蓝色界面，并重新设计浅色和深色模式',
    '更换安全边距充足的新 App 图标',
    '新增昵称、首字母头像和图片头像上传',
    '新增首次登录引导和版本更新提示',
    '强化账号数据隔离说明，并补充版本与版权信息'
  ],
  now()
)
on conflict (version) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own" on storage.objects for insert to authenticated
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own" on storage.objects for update to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own" on storage.objects for delete to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

````

## supabase/migrations/20260714020000_release_1_1_1.sql

<!-- source: supabase/migrations/20260714020000_release_1_1_1.sql sha256: 7291d2615cbfdafd2b0525aee814dace7240f2095c26ea8ce295275975558a29 encoding: utf8 -->
````sql
-- Life Tracker 1.1.1 release history.
-- This migration updates public release notes only and does not alter user data.

insert into public.changelogs (version, summary, created_at)
values (
  '1.0.0',
  array[
    '推出 Supabase Magic Link 邮箱登录，并通过 RLS 为每个账号提供独立数据空间',
    '支持消费、行程和随记三类内容的快速记录、统一时间线与分类筛选',
    '新增多行程规划、动态 Day 计算、拖拽排序、跨天移动与计划打卡',
    '支持计划关联实际消费和随记，完整保留从计划到发生的过程',
    '提供 13 种币种、自动汇率缓存、分类占比与每日消费趋势',
    '支持 PWA 安装、离线缓存、离线写入队列和恢复网络后的自动同步',
    '提供浅色、深色和跟随系统三种外观模式'
  ],
  '2026-07-14T00:00:00Z'::timestamptz
)
on conflict (version) do update set
  summary = excluded.summary,
  created_at = excluded.created_at;

insert into public.changelogs (version, summary, created_at)
values (
  '1.1.1',
  array[
    '在设置中新增永久更新记录，可以随时回看所有历史版本',
    '补全 1.0.0 首发版本的完整功能说明',
    '将网站分享预览更新为新版蓝色 Logo，并加入版本化缓存刷新'
  ],
  now()
)
on conflict (version) do update set
  summary = excluded.summary,
  created_at = excluded.created_at;

````

## supabase/migrations/20260714030000_release_1_1_2.sql

<!-- source: supabase/migrations/20260714030000_release_1_1_2.sql sha256: 04cd197c44a6d2e1606cd96ebdd1462ea5c4ae31aaf10c3912cc8cd76a691cee encoding: utf8 -->
````sql
-- Life Tracker 1.1.2 brand icon release.
-- This migration adds release notes only and does not alter user data.

insert into public.changelogs (version, summary, created_at)
values (
  '1.1.2',
  array[
    '统一网站品牌 Logo、Safari 桌面图标和 PWA 图标为新版正方形图案',
    '网站页头、登录页和加载状态改用正式品牌 Logo',
    '分享预览改为正方形 Logo，避免 Safari 将横图裁成不完整的小图',
    '为所有安装图标启用全新文件名，减少 iOS 旧缓存干扰'
  ],
  now()
)
on conflict (version) do update set
  summary = excluded.summary,
  created_at = excluded.created_at;

````

## supabase/migrations/20260714040000_release_1_2_0_transport.sql

<!-- source: supabase/migrations/20260714040000_release_1_2_0_transport.sql sha256: d4112330e86486cf855d9bd076318520276e2e9f5d1ae820d6db62e455f1d7b1 encoding: utf8 -->
````sql
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

````

## supabase/migrations/20260714050000_release_1_2_1_flight_lookup.sql

<!-- source: supabase/migrations/20260714050000_release_1_2_1_flight_lookup.sql sha256: 895f6cfa19cb39f81700943a10550942950d13ebc9681e23776e77172a6d4da3 encoding: utf8 -->
````sql
-- Life Tracker 1.2.1 flight lookup, local flight time zones, and release notes.

insert into public.changelogs (version, summary, created_at)
values (
  '1.2.1',
  array[
    '飞机模板新增 Aviationstack 实时航班查询：输入 IATA 航班号并主动点击查询，可核对候选航班的日期、机场、航站楼、登机口、机型和状态，再确认填入；每次点击只消耗 1 次接口额度。',
    '航班的起飞与降落信息分别保存当地时区，卡片始终显示机场当地日期与时间。',
    '创建行程时会根据目的地自动匹配行程时区，并提供标准 IANA 时区列表供手动调整。',
    '所有非必填输入项现已明确标注“选填”，减少填写时的疑惑。'
  ],
  now()
)
on conflict (version) do update set
  summary = excluded.summary,
  created_at = excluded.created_at;

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
    '1.2.1'
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

````

## supabase/migrations/20260714060000_release_1_3_0_security_and_ai.sql

<!-- source: supabase/migrations/20260714060000_release_1_3_0_security_and_ai.sql sha256: 487fcec605c9c36948642754f0e782ac0e38ca7aa258c9bf8d3f39edf5f3eff4 encoding: utf8 -->
````sql
-- Life Tracker 1.3.0 protected entitlements, atomic quotas, flight matching,
-- demo sessions, invite redemption and cached AI content.

create extension if not exists pgcrypto;

alter table public.records
  add column if not exists actual_match_status text not null default 'never',
  add column if not exists actual_info jsonb,
  add column if not exists actual_info_matched boolean not null default false,
  add column if not exists actual_matched_at timestamptz,
  add column if not exists actual_match_provider text,
  add column if not exists actual_match_request_id uuid;

alter table public.records drop constraint if exists records_actual_match_status_check;
alter table public.records add constraint records_actual_match_status_check
  check (actual_match_status in ('never', 'eligible', 'matching', 'matched', 'not_found', 'failed'));

alter table public.records drop constraint if exists records_actual_info_object_check;
alter table public.records add constraint records_actual_info_object_check
  check (actual_info is null or jsonb_typeof(actual_info) = 'object');

create unique index if not exists records_actual_match_request_idx
  on public.records(actual_match_request_id) where actual_match_request_id is not null;

create table if not exists public.api_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier text not null default 'standard' check (tier in ('standard', 'friend', 'owner')),
  source text not null default 'default' check (source in ('default', 'invite', 'owner_bootstrap', 'admin')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (char_length(code_hash) = 64),
  label text not null default 'friends',
  active boolean not null default true,
  max_redemptions integer,
  redeemed_count integer not null default 0 check (redeemed_count >= 0),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invite_redemptions (
  id uuid primary key default gen_random_uuid(),
  invite_code_id uuid not null references public.invite_codes(id) on delete restrict,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  redeemed_at timestamptz not null default now()
);

create table if not exists public.invite_attempts (
  id bigint generated by default as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  succeeded boolean not null default false,
  attempted_at timestamptz not null default now()
);

create index if not exists invite_attempts_user_time_idx on public.invite_attempts(user_id, attempted_at desc);

create table if not exists public.demo_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (char_length(token_hash) = 64),
  device_hash text not null check (char_length(device_hash) between 32 and 128),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists demo_sessions_device_idx on public.demo_sessions(device_hash, expires_at desc);

create table if not exists public.api_quota_policies (
  policy_key text primary key,
  service text not null check (service in ('aviation', 'deepseek')),
  quota_group text not null,
  tier text not null check (tier in ('demo', 'standard', 'friend', 'owner', 'shared')),
  period_type text not null check (period_type in ('day', 'month', 'rolling')),
  limit_value integer not null check (limit_value > 0),
  soft_limit boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.api_quota_buckets (
  bucket_key text primary key,
  service text not null check (service in ('aviation', 'deepseek')),
  quota_group text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  limit_value integer not null check (limit_value > 0),
  used_value integer not null default 0 check (used_value >= 0),
  updated_at timestamptz not null default now()
);

create index if not exists api_quota_buckets_period_idx on public.api_quota_buckets(service, period_end);

create table if not exists public.api_usage_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  user_id uuid references auth.users(id) on delete cascade,
  demo_session_id uuid references public.demo_sessions(id) on delete cascade,
  service text not null check (service in ('aviation', 'deepseek')),
  feature text not null,
  quota_group text not null,
  tier text not null check (tier in ('demo', 'standard', 'friend', 'owner')),
  status text not null default 'reserved' check (status in ('reserved', 'completed', 'upstream_error', 'not_found', 'failed')),
  counted boolean not null default true,
  response_meta jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint api_usage_principal_check check ((user_id is null) <> (demo_session_id is null))
);

create index if not exists api_usage_user_time_idx on public.api_usage_events(user_id, created_at desc) where user_id is not null;
create index if not exists api_usage_demo_time_idx on public.api_usage_events(demo_session_id, created_at desc) where demo_session_id is not null;
create index if not exists api_usage_service_month_idx on public.api_usage_events(service, created_at desc) where counted;

create table if not exists public.api_cooldowns (
  principal_key text primary key,
  reason text not null,
  until_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.flight_match_previews (
  request_id uuid primary key,
  record_id uuid not null references public.records(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  actual_info jsonb not null check (jsonb_typeof(actual_info) = 'object'),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  unique (record_id, request_id)
);

create table if not exists public.trip_recaps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trip_id uuid not null references public.trips(id) on delete cascade,
  content text not null,
  source_snapshot_hash text not null,
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, trip_id)
);

create table if not exists public.daily_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  summary_date date not null,
  content text not null,
  generated_at timestamptz not null default now(),
  unique (user_id, summary_date)
);

insert into public.api_quota_policies (policy_key, service, quota_group, tier, period_type, limit_value, soft_limit)
values
  ('aviation_standard_daily', 'aviation', 'flight', 'standard', 'day', 2, false),
  ('aviation_shared_monthly', 'aviation', 'flight', 'shared', 'month', 80, false),
  ('aviation_owner_monthly', 'aviation', 'flight', 'owner', 'month', 20, false),
  ('ai_light_demo_daily', 'deepseek', 'light', 'demo', 'day', 2, false),
  ('ai_light_standard_daily', 'deepseek', 'light', 'standard', 'day', 15, false),
  ('ai_light_owner_daily', 'deepseek', 'light', 'owner', 'day', 200, true),
  ('ai_light_shared_monthly', 'deepseek', 'light', 'shared', 'month', 10000, false),
  ('ai_recap_standard_monthly', 'deepseek', 'recap', 'standard', 'month', 3, false),
  ('ai_recap_friend_monthly', 'deepseek', 'recap', 'friend', 'month', 10, false),
  ('ai_recap_owner_monthly', 'deepseek', 'recap', 'owner', 'month', 50, true),
  ('ai_summary_standard_daily', 'deepseek', 'summary', 'standard', 'day', 1, false)
on conflict (policy_key) do update set
  service = excluded.service,
  quota_group = excluded.quota_group,
  tier = excluded.tier,
  period_type = excluded.period_type,
  limit_value = excluded.limit_value,
  soft_limit = excluded.soft_limit,
  updated_at = now();

-- Store only the hash. The clear invite code is distributed privately and can
-- be replaced by inserting a new hash and deactivating this row.
insert into public.invite_codes (code_hash, label)
values ('7b62cfc9ba55cccef3f00dcfa325abb68340a943b34e74089e1d795f68a2da83', 'v1.3 friends')
on conflict (code_hash) do nothing;

-- Resolve the existing owner account once, then persist the Auth UUID. No owner
-- email or invite rule is exposed to the client application.
insert into public.api_entitlements (user_id, tier, source)
select id, 'owner', 'owner_bootstrap'
from auth.users
where encode(extensions.digest(lower(email), 'sha256'::text), 'hex') = '65a64dff94079533ab3aeecd6c5068f193532cf6f9c6c853bc76a0cdfef9df0c'
on conflict (user_id) do update set tier = 'owner', source = 'owner_bootstrap', revoked_at = null, updated_at = now();

create or replace function public.redeem_friend_invite(p_user_id uuid, p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  code_row public.invite_codes%rowtype;
  current_tier text;
begin
  if p_user_id is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INVITE');
  end if;

  if (select count(*) from public.invite_attempts where user_id = p_user_id and attempted_at > now() - interval '1 hour' and not succeeded) >= 5 then
    return jsonb_build_object('ok', false, 'code', 'TOO_MANY_ATTEMPTS');
  end if;

  select tier into current_tier from public.api_entitlements where user_id = p_user_id and revoked_at is null;
  if current_tier = 'owner' then
    return jsonb_build_object('ok', true, 'tier', 'owner');
  end if;
  if current_tier = 'friend' then
    return jsonb_build_object('ok', true, 'tier', 'friend');
  end if;

  select * into code_row from public.invite_codes
  where code_hash = p_code_hash and active and (expires_at is null or expires_at > now())
    and (max_redemptions is null or redeemed_count < max_redemptions)
  for update;

  if code_row.id is null then
    insert into public.invite_attempts(user_id, succeeded) values (p_user_id, false);
    return jsonb_build_object('ok', false, 'code', 'INVALID_INVITE');
  end if;

  insert into public.invite_redemptions(invite_code_id, user_id)
  values (code_row.id, p_user_id)
  on conflict (user_id) do nothing;
  update public.invite_codes set redeemed_count = redeemed_count + 1, updated_at = now() where id = code_row.id;
  insert into public.api_entitlements(user_id, tier, source)
  values (p_user_id, 'friend', 'invite')
  on conflict (user_id) do update set tier = case when api_entitlements.tier = 'owner' then 'owner' else 'friend' end,
    source = case when api_entitlements.tier = 'owner' then api_entitlements.source else 'invite' end,
    revoked_at = null,
    updated_at = now();
  insert into public.invite_attempts(user_id, succeeded) values (p_user_id, true);
  return jsonb_build_object('ok', true, 'tier', 'friend');
end;
$$;

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
    elsif v_tier = 'owner' then
      v_keys := array['aviation:owner:' || to_char(v_month_start at time zone 'Asia/Shanghai', 'YYYY-MM')];
      v_limits := array[20]; v_groups := array['flight']; v_starts := array[v_month_start]; v_ends := array[v_month_end];
    else
      v_keys := array['aviation:shared:' || to_char(v_month_start at time zone 'Asia/Shanghai', 'YYYY-MM')];
      v_limits := array[80]; v_groups := array['flight']; v_starts := array[v_month_start]; v_ends := array[v_month_end];
      if v_tier = 'standard' then
        v_keys := array_append(v_keys, 'aviation:standard:' || p_user_id::text || ':' || to_char(v_day_start at time zone 'Asia/Shanghai', 'YYYY-MM-DD'));
        v_limits := array_append(v_limits, 2); v_groups := array_append(v_groups, 'flight'); v_starts := array_append(v_starts, v_day_start); v_ends := array_append(v_ends, v_day_end);
      end if;
    end if;
  elsif v_group = 'light' then
    if v_tier = 'owner' then
      v_keys := array['deepseek:light:owner:' || p_user_id::text || ':' || to_char(v_day_start at time zone 'Asia/Shanghai', 'YYYY-MM-DD')];
      v_limits := array[200]; v_groups := array['light']; v_starts := array[v_day_start]; v_ends := array[v_day_end];
    else
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
    v_limit := case v_tier when 'owner' then 50 when 'friend' then 10 else 3 end;
    v_keys := array['deepseek:recap:' || v_tier || ':' || p_user_id::text || ':' || to_char(v_month_start at time zone 'Asia/Shanghai', 'YYYY-MM')];
    v_limits := array[v_limit]; v_groups := array['recap']; v_starts := array[v_month_start]; v_ends := array[v_month_end];
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

create or replace function public.complete_api_usage(p_request_id uuid, p_status text, p_response_meta jsonb default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.api_usage_events
  set status = case when p_status in ('completed', 'upstream_error', 'not_found', 'failed') then p_status else 'failed' end,
      response_meta = p_response_meta,
      completed_at = now()
  where request_id = p_request_id;
$$;

create or replace function public.claim_flight_match(p_user_id uuid, p_record_id uuid, p_request_id uuid, p_rematch boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_record public.records%rowtype;
begin
  select * into row_record from public.records where id = p_record_id and user_id = p_user_id for update;
  if row_record.id is null or row_record.transport_type <> 'flight' then
    return jsonb_build_object('ok', false, 'code', 'RECORD_NOT_FOUND');
  end if;
  if row_record.actual_match_status = 'matched' and not p_rematch then
    return jsonb_build_object('ok', true, 'cached', true, 'actual_info', row_record.actual_info, 'matched_at', row_record.actual_matched_at);
  end if;
  if row_record.actual_match_status = 'matching' and row_record.updated_at > now() - interval '2 minutes' then
    return jsonb_build_object('ok', false, 'code', 'MATCH_IN_PROGRESS');
  end if;
  update public.records set actual_match_status = 'matching', actual_match_request_id = p_request_id, updated_at = now() where id = p_record_id;
  return jsonb_build_object('ok', true, 'cached', false, 'record', to_jsonb(row_record));
end;
$$;

create or replace function public.finish_flight_match(
  p_user_id uuid,
  p_record_id uuid,
  p_request_id uuid,
  p_status text,
  p_actual_info jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_row public.records%rowtype;
begin
  if p_status not in ('matched', 'not_found', 'failed') then raise exception 'invalid flight match status'; end if;
  update public.records
  set actual_match_status = p_status,
      actual_info = case when p_status = 'matched' then p_actual_info else actual_info end,
      actual_info_matched = (p_status = 'matched'),
      actual_matched_at = case when p_status = 'matched' then now() else actual_matched_at end,
      actual_match_provider = case when p_status = 'matched' then 'aviationstack' else actual_match_provider end,
      updated_at = now()
  where id = p_record_id and user_id = p_user_id and actual_match_request_id = p_request_id
  returning * into updated_row;
  return case when updated_row.id is null then jsonb_build_object('ok', false) else jsonb_build_object('ok', true, 'record', to_jsonb(updated_row)) end;
end;
$$;

alter table public.api_entitlements enable row level security;
alter table public.invite_codes enable row level security;
alter table public.invite_redemptions enable row level security;
alter table public.invite_attempts enable row level security;
alter table public.demo_sessions enable row level security;
alter table public.api_quota_policies enable row level security;
alter table public.api_quota_buckets enable row level security;
alter table public.api_usage_events enable row level security;
alter table public.api_cooldowns enable row level security;
alter table public.flight_match_previews enable row level security;
alter table public.trip_recaps enable row level security;
alter table public.daily_summaries enable row level security;

drop policy if exists trip_recaps_select_own on public.trip_recaps;
create policy trip_recaps_select_own on public.trip_recaps for select to authenticated using (auth.uid() = user_id);
drop policy if exists daily_summaries_select_own on public.daily_summaries;
create policy daily_summaries_select_own on public.daily_summaries for select to authenticated using (auth.uid() = user_id);

revoke all on public.api_entitlements, public.invite_codes, public.invite_redemptions, public.invite_attempts,
  public.demo_sessions, public.api_quota_policies, public.api_quota_buckets, public.api_usage_events,
  public.api_cooldowns, public.flight_match_previews, public.trip_recaps, public.daily_summaries from anon, authenticated;
grant select on public.trip_recaps, public.daily_summaries to authenticated;

revoke all on function public.redeem_friend_invite(uuid, text) from public, anon, authenticated;
revoke all on function public.consume_api_quota(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.complete_api_usage(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_flight_match(uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.finish_flight_match(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.redeem_friend_invite(uuid, text) to service_role;
grant execute on function public.consume_api_quota(uuid, uuid, text, uuid) to service_role;
grant execute on function public.complete_api_usage(uuid, text, jsonb) to service_role;
grant execute on function public.claim_flight_match(uuid, uuid, uuid, boolean) to service_role;
grant execute on function public.finish_flight_match(uuid, uuid, uuid, text, jsonb) to service_role;

insert into public.changelogs (version, summary, created_at)
values (
  '1.3.0',
  array[
    '新增 Standard、Friend、Owner 与本地演示四种使用模式。邮箱账号可以在设置中兑换朋友邀请码；Owner 由服务端 Auth UUID 独立识别。设置页会展示智能服务权限、当日与当月额度以及冷却状态。',
    '航班规划改为手动填写计划信息；只有在计划到达时间结束约 60 分钟后至 48 小时内，才会出现“匹配实际飞行信息”。系统按到达机场 IANA 时区换算 UTC，严格核对航班号、出发日期和起降机场，先预览计划与实际差异，确认后再保存；匹配结果会缓存且不会在打开页面时自动查询。',
    '新增常用机场离线智能补全，可使用中文、英文、城市、IATA 代码、拼音或常见别名搜索，并自动填充标准机场名、代码和当地时区。',
    '新增 AI 轻量助手：公共交通路线查询、自然语言记账解析与随记润色共用每日额度。所有结果均需预览确认，不会自动写入记录。',
    '新增旅行回顾与消费洞察、今日计划摘要。旅行回顾先在服务端聚合统计并抽样少量随记，避免把全部原始记录发送给模型；生成结果与每日摘要都会缓存，重新生成时会明确提示再次消耗额度。',
    '新增可重置的演示模式：记录、编辑和规划数据只保存在当前设备；航班使用模拟数据完整展示匹配流程，AI 每台设备每天可真实体验 2 次。演示模式不会接触真实用户数据，也不支持图片上传。',
    '行程计划统一按时间先后排列，拖动跨日会更新日期；同一日始终以时间为主排序。行程列表按进行中、未来、过去分组排序，行程与已有日程均可再次编辑，缩短日期时会明确提示超出范围的计划。',
    '智能服务新增服务端原子配额、共享额度池、频率保护、邀请码防暴力尝试、请求幂等和航班并发锁；普通记录、编辑和规划不受智能额度影响。',
    '优化移动端安全区域、表单选填标识与使用说明。建议优先使用简洁文字保存日常内容，以便后续搜索、统计与回顾。'
  ],
  now()
)
on conflict (version) do update set summary = excluded.summary, created_at = excluded.created_at;

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name, avatar_color, has_seen_onboarding, last_seen_version)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), nullif(split_part(new.email, '@', 1), ''), 'Life Tracker 用户'), 40),
    '#0A84FF', false, '1.3.0'
  ) on conflict (user_id) do nothing;
  insert into public.api_entitlements(user_id, tier, source)
  values (new.id, 'standard', 'default') on conflict (user_id) do nothing;
  return new;
end;
$$;

````

## supabase/migrations/20260714061000_release_1_3_0_demo_device_session.sql

<!-- source: supabase/migrations/20260714061000_release_1_3_0_demo_device_session.sql sha256: 4a4c9e2c50d80684f7c5f4519f395fbfbbc406111fa610b11bc90ced15407276 encoding: utf8 -->
````sql
-- Keep one stable server-side demo session id per device. Rotating the raw
-- token on re-entry must not reset that device's daily AI allowance.
delete from public.demo_sessions older
using public.demo_sessions newer
where older.device_hash = newer.device_hash and older.created_at < newer.created_at;

create unique index if not exists demo_sessions_device_unique_idx on public.demo_sessions(device_hash);


````

## supabase/migrations/20260714062000_owner_entitlement_repair.sql

<!-- source: supabase/migrations/20260714062000_owner_entitlement_repair.sql sha256: b84b6c7024367601ab1355eac5c46a2700744b7212e15e28587ca7b17e4b9362 encoding: utf8 -->
````sql
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

````

## supabase/migrations/20260715000000_release_1_4_1_owner_admin_and_quota.sql

<!-- source: supabase/migrations/20260715000000_release_1_4_1_owner_admin_and_quota.sql sha256: 1a114c5192270a50531efe79b887e96f114e70729e14fbd0d7d887cc8d733223 encoding: utf8 -->
````sql
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

````

## supabase/migrations/20261111172324_release_2_0_0_ui.sql

<!-- source: supabase/migrations/20261111172324_release_2_0_0_ui.sql sha256: 710786ebda43040792d43f4cb70bebe83c786eb4481fdf6f7462477b9521f2b0 encoding: utf8 -->
````sql
-- Prepared only. Run after explicit release approval; no schema/RLS/quota changes.
insert into public.changelogs(version, summary, created_at)
values ('2.0.0', array[
  '全站界面焕新，统一字体、间距与按钮样式，让记录和行程信息更清晰。',
  '深色模式采用纯黑背景，浅色模式保留简洁白色卡片，减少装饰与干扰。',
  '飞机模板新增自动计算飞行时长，按起降两地时区处理跨日与时差，不消耗 API 额度。前一天出发、首日抵达的航班会按与旅行日期的重叠归入计划，仍保留真实当地日期。实际匹配成功后优先展示匹配时间、机型、登机口与状态；缺失项明确标注计划值，原计划可展开查看。航班、铁路等交通记录完成后不再划掉标题，保留可读详情和完成标识。',
  '新增全天事项与跨日酒店住宿模板，可填写日期范围、酒店地址、入住/退房时间及预订号。每天的“全天与住宿”区会展示连住情况，换酒店当天分别展示旧酒店退房与新酒店入住；退房日不重复计算住宿夜晚，日期重叠会提醒核对。跨日只保存一条记录，编辑或撤回完成会同步到各天。优化手机表单、导航和消费图表，原有数据与账号权限保持不变。',
  '时间线新增“撤回完成”“恢复计划”和直接编辑入口，演示及日期范围外的计划也可编辑。航司补全扩充至 114 家，支持中文、英文、简称和 IATA 代码搜索；选定航司后自动补全代码，只需填写航班号数字部分，也可粘贴完整航班号。',
  '完善账号隔离、云端保存确认与冲突保护，支持查看和导出本机待处理副本；AI 或航班结果保存失败可只重试保存，不重复查询。优化跨时区摘要、多币种回顾、时间线排序及并发频率保护，既有额度规则不变。'
], now())
on conflict (version) do update set summary = excluded.summary;

````

## supabase/migrations/20261111172339_all_day_schedules.sql

<!-- source: supabase/migrations/20261111172339_all_day_schedules.sql sha256: 9d1f005fb633dd75ceaf4f9622a84c6cb74d8db454980187550a7b4a18cd8370 encoding: utf8 -->
````sql
-- Prepared only: apply before releasing the V2 frontend. Existing records remain NULL.
-- Uses the existing records RLS policies; no account, quota or API changes.
alter table public.records add column if not exists schedule_details jsonb;

alter table public.records drop constraint if exists records_schedule_details_check;
alter table public.records add constraint records_schedule_details_check check (
  schedule_details is null or (
    record_type = 'trip'
    and trip_id is not null
    and parent_plan_id is null
    and transport_type is null
    and jsonb_typeof(schedule_details) = 'object'
    and coalesce(schedule_details ->> 'kind', '') in ('all_day', 'hotel')
    and coalesce(schedule_details ->> 'start_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
    and coalesce(schedule_details ->> 'end_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
    and case when schedule_details ->> 'kind' = 'hotel'
      then (schedule_details ->> 'end_date')::date > (schedule_details ->> 'start_date')::date
      else (schedule_details ->> 'end_date')::date >= (schedule_details ->> 'start_date')::date
    end
  )
);

comment on column public.records.schedule_details is
  'Optional all-day or hotel date range in the parent trip timezone. Hotel end_date is checkout; overnight interval excludes end_date. One record is projected across days by the frontend.';

````

## supabase/migrations/20261111172344_safe_client_mutations.sql

<!-- source: supabase/migrations/20261111172344_safe_client_mutations.sql sha256: 6c477ea7d6c4a3ba7ef6feea4b5a33b0ef9c50013666c936a928502695912a92 encoding: utf8 -->
````sql
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

````

## supabase/migrations/20261111172354_flight_integrity.sql

<!-- source: supabase/migrations/20261111172354_flight_integrity.sql sha256: 11a697fc3ad8004b1d5d1d9b5a604be5c15874f02126c92dcd04f01ec4eea9c1 encoding: utf8 -->
````sql
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

````

## supabase/migrations/20261111172402_ai_cache_context.sql

<!-- source: supabase/migrations/20261111172402_ai_cache_context.sql sha256: 2ac79103f8cfb4f44d7dfdabc8c0dff99e319bfcd408b41e8327f51a15115989 encoding: utf8 -->
````sql
-- A quota day remains Asia/Shanghai; a summary's business day belongs to each
-- active trip. Legacy Shanghai-only summaries must not masquerade as new ones.
alter table public.daily_summaries add column if not exists context_key text not null default 'legacy-shanghai';
alter table public.daily_summaries drop constraint if exists daily_summaries_user_id_summary_date_key;
-- Retain old content without treating Shanghai-only rows as a trip-local cache.
update public.daily_summaries set context_key = 'legacy-shanghai:' || summary_date::text where context_key = 'legacy-shanghai';
-- If an earlier local candidate stored the same business context on two quota
-- dates, retain older content under an archival key, rather than deleting it.
with ranked as (
  select id, row_number() over(partition by user_id, context_key order by generated_at desc, id desc) as position
  from public.daily_summaries
) update public.daily_summaries s set context_key = 'legacy-duplicate:' || s.id::text
from ranked r where s.id = r.id and r.position > 1;
drop index if exists public.daily_summaries_user_date_context_key;
create unique index if not exists daily_summaries_user_context_key on public.daily_summaries(user_id, context_key);

-- This RPC is reached only after JWT authentication plus HMAC token validation
-- in the Edge function. It cannot be executed using a publishable/user key.
-- Cache storage and successful usage completion commit in one transaction.
create or replace function public.store_ai_result(
  p_user_id uuid,
  p_request_id uuid,
  p_feature text,
  p_content text,
  p_generated_at timestamptz,
  p_trip_id uuid default null,
  p_summary_date date default null,
  p_context_key text default null,
  p_snapshot_hash text default null,
  p_response_meta jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage public.api_usage_events;
  v_saved_at timestamptz;
begin
  if p_user_id is null or p_request_id is null or p_content is null or char_length(p_content) > 16000
    or p_generated_at is null or p_generated_at > now() + interval '1 minute'
    or p_feature not in ('route', 'expense_parse', 'note_polish', 'trip_recap', 'daily_summary') then
    raise exception 'invalid AI result' using errcode = '22023';
  end if;
  select * into v_usage from public.api_usage_events where request_id = p_request_id for update;
  if not found or v_usage.user_id is distinct from p_user_id or v_usage.service <> 'deepseek' or v_usage.feature <> p_feature then
    raise exception 'AI request does not belong to this user or feature' using errcode = '42501';
  end if;

  if p_feature = 'trip_recap' then
    if p_trip_id is null or p_snapshot_hash is null or char_length(p_snapshot_hash) <> 64
      or not exists (select 1 from public.trips where id = p_trip_id and user_id = p_user_id) then
      raise exception 'invalid recap target' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('ai-recap:' || p_user_id::text || ':' || p_trip_id::text, 0));
    insert into public.trip_recaps(user_id, trip_id, content, source_snapshot_hash, generated_at, updated_at)
    values (p_user_id, p_trip_id, p_content, p_snapshot_hash, p_generated_at, now())
    on conflict(user_id, trip_id) do update set content = excluded.content,
      source_snapshot_hash = excluded.source_snapshot_hash, generated_at = excluded.generated_at, updated_at = now()
    where public.trip_recaps.generated_at <= excluded.generated_at;
    select generated_at into v_saved_at from public.trip_recaps where user_id = p_user_id and trip_id = p_trip_id;
  elsif p_feature = 'daily_summary' then
    if p_summary_date is null or p_context_key is null or p_context_key !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid summary context' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('ai-summary:' || p_user_id::text || ':' || p_context_key, 0));
    insert into public.daily_summaries(user_id, summary_date, context_key, content, generated_at)
    values (p_user_id, p_summary_date, p_context_key, p_content, p_generated_at)
    on conflict(user_id, context_key) do update set content = excluded.content, generated_at = excluded.generated_at, summary_date = excluded.summary_date
    where public.daily_summaries.generated_at <= excluded.generated_at;
    select generated_at into v_saved_at from public.daily_summaries
      where user_id = p_user_id and context_key = p_context_key;
  else
    v_saved_at := p_generated_at;
  end if;

  perform public.complete_api_usage(p_request_id, 'completed', p_response_meta);
  return jsonb_build_object('saved', true, 'generatedAt', v_saved_at, 'newerPreserved', v_saved_at > p_generated_at);
end;
$$;
revoke all on function public.store_ai_result(uuid, uuid, text, text, timestamptz, uuid, date, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.store_ai_result(uuid, uuid, text, text, timestamptz, uuid, date, text, text, jsonb) to service_role;

````

## supabase/migrations/20261111172411_atomic_quota_admission.sql

<!-- source: supabase/migrations/20261111172411_atomic_quota_admission.sql sha256: e4a7d1a9562d4b18e24ef65fcd7df883c61be93fd0cd58850e5699d46f5d6190 encoding: utf8 -->
````sql
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

````

## supabase/migrations/20261111172418_audit_relations_and_periods.sql

<!-- source: supabase/migrations/20261111172418_audit_relations_and_periods.sql sha256: 0f9608507b3b1e7dc0068022ea8e07cbbf3b289d2ef5e4d0395e7f47fc6aeac5 encoding: utf8 -->
````sql
-- Preserve children and CAS versions: reject incompatible parent changes
-- rather than silently moving actual records to a different trip.
create or replace function public.validate_record_relations()
returns trigger language plpgsql security definer set search_path = public
as $$
declare parent_row public.records%rowtype;
begin
  if new.trip_id is not null and not exists (
    select 1 from public.trips t where t.id = new.trip_id and t.user_id = new.user_id
  ) then raise exception 'trip must belong to the same user'; end if;

  if new.parent_plan_id is not null then
    -- SHARE, not KEY SHARE: serialize a child insert with changes to the
    -- parent's non-key trip/type fields. Recheck the row after a lock wait.
    select * into parent_row from public.records r where r.id = new.parent_plan_id for share;
    if parent_row.id is null or parent_row.user_id <> new.user_id or parent_row.record_type <> 'trip' then
      raise exception 'parent plan must be a trip record owned by the same user';
    end if;
    if new.trip_id is distinct from parent_row.trip_id then
      raise exception 'actual record and parent plan must belong to the same trip';
    end if;
  end if;

  if tg_op = 'UPDATE' and (
    new.trip_id is distinct from old.trip_id or new.record_type is distinct from old.record_type or new.user_id is distinct from old.user_id
  ) and exists (
    select 1 from public.records child where child.parent_plan_id = new.id and (
      new.record_type <> 'trip' or child.user_id <> new.user_id or child.trip_id is distinct from new.trip_id
    )
  ) then raise exception 'parent change would invalidate existing actual records'; end if;
  return new;
end;
$$;
drop trigger if exists records_validate_relations on public.records;
create trigger records_validate_relations before insert or update of user_id, trip_id, parent_plan_id, record_type on public.records
for each row execute function public.validate_record_relations();
revoke all on function public.validate_record_relations() from public, anon, authenticated;

-- Correct previously stored reset metadata from its Shanghai local start.
-- Bucket keys, limits, counters and usage events are deliberately untouched.
update public.api_quota_buckets
set period_end = (date_trunc('month', period_start at time zone 'Asia/Shanghai') + interval '1 month') at time zone 'Asia/Shanghai'
where bucket_key ~ ':[0-9]{4}-[0-9]{2}$';
update public.api_quota_buckets
set period_end = (date_trunc('day', period_start at time zone 'Asia/Shanghai') + interval '1 day') at time zone 'Asia/Shanghai'
where bucket_key ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$';

````

## supabase/migrations/20261112050946_harden_profile_trigger.sql

<!-- source: supabase/migrations/20261112050946_harden_profile_trigger.sql sha256: eeba60e89ecac5c7bf0662b3e2eb5702b0397e777a863f2ac021407c65b7cd3e encoding: utf8 -->
````sql
-- Limit direct client execution; the auth.users trigger remains in place.
revoke execute on function public.handle_new_user_profile() from public, anon, authenticated;

````

## supabase/migrations/20261112050955_record_image_ownership.sql

<!-- source: supabase/migrations/20261112050955_record_image_ownership.sql sha256: e0e9474380973e365b4d5ce51fdb279bf6b9c87155aaca3f4f532eb05787fe0c encoding: utf8 -->
````sql
-- The private bucket's per-user RLS policies remain unchanged.
alter table public.records drop constraint if exists records_image_note_only;

````
