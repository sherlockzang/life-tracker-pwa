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
