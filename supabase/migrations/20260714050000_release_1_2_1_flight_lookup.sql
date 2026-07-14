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
