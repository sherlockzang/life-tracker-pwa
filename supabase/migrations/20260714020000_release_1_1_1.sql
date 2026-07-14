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
