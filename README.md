# Life Tracker PWA

一个适合长期使用的个人记录工具：在同一条时间线里快速记录消费、行程和随手记，并通过 Supabase 在不同设备间同步。

线上地址：<https://sherlockzang.github.io/life-tracker-pwa/>

## 已实现

- Supabase Magic Link 邮箱登录，首次使用自动注册
- 多用户数据隔离，所有用户数据表均启用 RLS
- 昵称、首字母头像与 2MB 内自定义头像上传
- 新用户首次引导，以及按账号记录已读状态的版本更新提示
- 设置页提供永久更新记录，可回看 1.0.0 起的所有版本说明
- 消费 / 行程 / 随记统一快速输入和时间线筛选
- 13 种币种、自动汇率缓存、分类占比和每日趋势图
- 多行程管理、按日期动态生成 Day、拖拽排序与跨天移动
- 计划状态打卡，以及“计划 → 实际消费/随记”的父子结构
- 深色优先、浅色和跟随系统模式
- PWA 安装、静态资源离线缓存、IndexedDB 数据快照和离线写入队列
- GitHub Actions 自动部署到 GitHub Pages

## 本地运行

需要 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

打开 <http://localhost:3000/life-tracker-pwa/>。

生产构建：

```bash
npm run build
npm run preview
```

## Supabase 配置

项目默认连接到本项目的 Supabase 实例。若需要更换项目，复制 `.env.example` 为 `.env.local`：

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
```

Publishable Key 会随静态前端发布，这是 Supabase 的预期用法；真正的数据安全由 RLS 保证。不要把 `service_role` key 放进前端或 GitHub 仓库。

数据库初始化步骤见 [`supabase/README.md`](supabase/README.md)。迁移文件按文件名顺序执行：

```text
supabase/migrations/20260714000000_initial_schema.sql
supabase/migrations/20260714010000_profiles_changelogs.sql
supabase/migrations/20260714020000_release_1_1_1.sql
```

### 数据表

- `user_settings`：主币种、主题偏好
- `trips`：行程名称、目的地、日期和时区
- `records`：消费、行程、随记统一记录；通过 `parent_plan_id` 关联实际执行记录
- `exchange_rates`：API 或手动汇率快照
- `profiles`：昵称、头像、首次引导和版本已读状态
- `changelogs`：面向用户展示的版本更新说明

`day_number` 不存入数据库，而是根据行程时区、`trips.start_date` 和 `records.event_at` 动态计算。

## Magic Link 重定向

在 Supabase Dashboard 的 Authentication → URL Configuration 中配置：

- Site URL：`https://sherlockzang.github.io/life-tracker-pwa/`
- Redirect URL：`https://sherlockzang.github.io/life-tracker-pwa/`
- 本地 Redirect URL：`http://localhost:3000/life-tracker-pwa/`

## 部署

推送到 `main` 分支后，`.github/workflows/deploy.yml` 会自动构建并发布 GitHub Pages。

如需手动重新部署，可在 GitHub 仓库的 Actions 页面运行 **Deploy to GitHub Pages** 工作流。

## 项目结构

```text
src/components/       界面组件
src/lib/              Supabase、离线缓存与数据访问
src/types.ts          共享类型和字段元数据
supabase/migrations/  数据库迁移与 RLS
public/                PWA 图标和分享预览图
```

每次发布新需求前先确认版本号，再将普通用户可读的更新摘要写入 `changelogs` 并部署。

汇率使用无密钥的 Frankfurter API；如果网络不可用，统计会继续使用 IndexedDB 和 Supabase 中最近一次缓存的汇率。
