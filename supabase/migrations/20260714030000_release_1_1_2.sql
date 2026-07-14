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
