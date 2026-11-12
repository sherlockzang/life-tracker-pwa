# Life Tracker PWA

长期使用的个人生活记录工具：消费、行程、随记汇成时间线；旅行计划与实际记录关联；支持多币种统计、邮箱验证码登录、离线记录和受权限保护的 AI 服务。

维护者：Sherlock Zang。网站：[Life Tracker](https://sherlockzang.github.io/life-tracker-pwa/)，仓库：[sherlockzang/life-tracker-pwa](https://github.com/sherlockzang/life-tracker-pwa)。

## 版本与交付边界

文档初稿：2026-10-01；V2.1 候选于 2026-11-12 更新。版本文件为 **2.1.0**；实际线上版本和发布状态应以 GitHub Actions 与网站为准。V2.0 发布提交可作为 V2.1 的回滚基线。

历史审计文档保留当时的状态，不代表当前生产状态。[首轮审查](docs/CODE-REVIEW-2026-10-01.md)保留原始缺陷证据；使用真实 AI 或航班接口会消耗相应额度。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [架构说明](docs/ARCHITECTURE.md) | 组件边界、数据流、离线、认证、权限与安全 |
| [从零重建规范](docs/REBUILD-SPEC.md) | 原仓库丢失时按功能合同和验收用例重做网站 |
| [数据库说明](docs/DATABASE.md) | 表关系、JSON、RLS、RPC、迁移和角色初始化 |
| [API 合同](docs/API-CONTRACT.md) | 全部 Edge Functions 的请求、响应、鉴权和错误 |
| [部署、备份与回滚](docs/DEPLOYMENT-ROLLBACK.md) | 本地开发、SMTP、密钥、Pages、升级、恢复和回滚 |
| [完整用户指南](docs/USER-GUIDE.md) | 安装、登录、记录、行程、酒店、航班、AI 和设置 |
| [V2 UI 验收记录](docs/V2.0.0-UI-REVIEW.md) | 本轮界面调整及验证范围 |
| [修复验收记录](docs/ACCEPTANCE-2026-10-01.md) | R01–R10修复映射、测试与未完成的发布门禁 |
| [独立审查交接单](docs/INDEPENDENT-REVIEW-HANDOFF.md) | 下一个模型的审查重点及执行约束 |
| [独立审计原报告](docs/INDEPENDENT-AUDIT-2026-10-02.md) | 修复前候选包的F01–F07原始证据 |
| [审计问题修复与复验](docs/AUDIT-FIXES-2026-10-02.md) | 本轮七项处置、新增测试及仍需真实环境验证的边界 |
| [自审问题修复与复验](docs/SELF-AUDIT-FIXES-2026-10-02.md) | 后续SA-01–SA-05、三组新增回归、IndexedDB升级及复审边界 |
| [依赖安全审计](docs/DEPENDENCY-AUDIT-2026-10-01.md) | 历史依赖审计；当前状态应重新运行 npm audit |
| [独立参考：数据库](docs/reference/SCHEMA-REFERENCE.md) | 按执行顺序保存的完整 SQL，不只是源码路径 |
| [独立参考：服务端](docs/reference/EDGE-REFERENCE.md) | 后端实现与邮件模板 |
| [独立参考：领域与配置](docs/reference/DOMAIN-REFERENCE.md) | 类型、数据字典、关键算法、离线和构建配置 |
| [独立参考：完整界面](docs/reference/FRONTEND-REFERENCE.md) | 全部前端界面源码和样式 |
| [独立参考：正式图标](docs/reference/ASSET-REFERENCE.md) | PNG二进制的Base64及校验值，可恢复原图 |

未来维护者先读最新验收、重建规范和首轮审查，再读架构、数据库与 API。参考快照是修复后候选工作树；本地真SQL已通过，但实际Supabase集成与真机验证不可因有快照就省略。

## 核心功能

- 邮箱 **6 位验证码**登录，不跳到 Safari；恢复前台主动读取当前窗口会话。
- 消费 / 行程 / 随记快速输入、主页倒序时间线、类型筛选与消费图表。
- 13 种币种、Frankfurter 汇率快照；缺失汇率有提示，不把不同币种直接相加。
- 多旅程、目的地时区识别、动态 Day、按时间安排计划、编辑与可撤销完成状态、计划关联实际消费/随记。
- 飞机 / 铁路 / 市内交通模板；起降机场及各自 IANA 时区、航司双向补全、机型规范化、跨时区飞行时长；夏令时重复时间必须明确选择第一次/第二次及UTC偏移。
- 已结束航班主动匹配 Aviationstack；精确核对航班号、出发日期和航线，预览确认后保存，不在开页时反复查询。
- V2：跨日期入境航班不会因旅程晚一天开始而丢失；已完成交通保留可读标题，匹配信息优先展示；全天安排、多晚酒店、入住/续住/退房及换酒店提醒。
- DeepSeek 路线建议、消费解析、随记润色、旅行回顾、今日摘要；AI 不自动替用户保存记录。
- Standard / Friend / Owner、邀请码、Owner 权限后台、服务端额度池与使用日志。
- 本地演示与真实账号隔离；航班模拟；演示轻量 AI 每设备每日 2 次。
- 深/浅/系统主题、昵称/头像、首次引导、永久更新记录、隐私说明与致谢。
- Pages 静态部署、PWA 安装与资源缓存、IndexedDB 快照和离线写入队列。

V2.1 新增消费／随记编辑删除与记录单张图片：编辑可离线排队，删除要求联网且不能有待处理副本；图片仅真实账号联网可上传，先保存记录再添加。图片使用私有存储、短期签名访问；取消、替换、移除关联或删除记录不会清除已上传对象，需另行设计安全清理。消费与计划图片需要应用对应数据库迁移。尚未实现：Passkey、邮箱提醒、完整数据导出、演示图片上传及管理员查看他人记录。上线和真机验证状态以最新验收为准。

## 本地运行

需要 Node.js **22.13.0 或更高**；优先用 Node 22 和仓库锁文件。

```bash
npm ci
npm run dev
```

打开 [本地预览](http://localhost:3000/life-tracker-pwa/)。原代码保留生产 Supabase 的公开连接默认值；**本地预览不等于后端沙箱**。开发先创建测试项目，在 `.env.local` 中填写测试连接：

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
```

`VITE_` 配置会进入静态前端，只允许公开配置。绝不能放 service-role、数据库密码、Resend / Aviationstack / DeepSeek 密钥。

## 检查命令

```bash
npm run lint
npm run build
node scripts/test-airlines.mjs
node scripts/test-flight-duration.mjs
node scripts/test-flight-trip-placement.mjs
node scripts/test-schedules-and-flight-display.mjs
node scripts/test-calendar-and-sync.mjs
node scripts/test-flight-integrity.mjs
node scripts/test-ai-reliability.mjs
node scripts/test-audit-regressions.mjs
node scripts/test-self-audit-sync.mjs
node scripts/test-self-audit-calendar.mjs
node scripts/test-self-audit-ai.mjs
node scripts/verify-ui-contract.mjs
node scripts/verify-documentation.mjs
git diff --check
```

`verify-ui-contract`依赖Git中的`stable-before-v2.0.0`，用于本轮UI/可靠性合同；没有Git历史的重建包须注明不适用并手工复核，不伪造通过。真实SQL独立执行`node scripts/test-database-integrity.mjs`；已在受审查允许的沙箱外临时PG18通过。7个Edge入口另用Deno2.5.3实际类型检查通过；前端构建本身不检查Edge，也不替代Supabase完整平台/真机集成，详见部署文档。

## 技术栈与目录

React 19 + TypeScript + Vite 8；Supabase Auth / PostgreSQL / Storage / Edge Functions；idb / IndexedDB；dnd-kit；Recharts；Lucide；vite-plugin-pwa / Workbox。准确依赖以锁文件为准；重建参考保存包版本快照。

```text
src/App.tsx                 会话、页面状态、加载、保存确认/副本、演示与同步
src/components/             登录、时间线、规划、交通编辑、全天安排、设置、统计
src/lib/                    数据、离线、AI、字典、时间与显示派生逻辑
src/types.ts                跨组件领域类型
src/styles/tokens.css       统一深浅主题变量
src/styles.css              响应式布局与组件样式
supabase/migrations/        17 个有序 SQL 迁移（最后7个待发布）
supabase/functions/         7 个端点和共享安全模块
supabase/templates/         注册确认、已有用户登录的 OTP 邮件模板
public/                     正式 Logo 与安装图标
scripts/                    纯逻辑回归、UI 边界与文档检查
docs/                       设计、运行、使用、恢复和审查资料
.github/workflows/deploy.yml main 推送或手动触发的 Pages 发布
```

## 交付与灾备原则

2026-10-02独立审计指出的F01–F07已修复并新增回归：[修复与复验记录](docs/AUDIT-FIXES-2026-10-02.md)。完整集合使用唯一ID游标分批读取；离线父子实体先满足依赖再保存；关系反向更新、异常内层形状、配额读取及上海月末元数据补强。真实设备及恢复演练仍应单独验收。

后续自审发现的五项问题也已修复：[自审修复记录](docs/SELF-AUDIT-FIXES-2026-10-02.md)。已发送请求UUID保留、成功修正后的旧失败副本归档且可导出、主页编辑使用行程时区日期、非航班时间严格校验、自动摘要失败不再定时重试。

本套reference保存完整源码、配置、锁文件、测试及图标，可恢复候选工作树的应用部分；准确文件数由`verify-documentation`输出。不含Git历史、云端历史数据、用户身份数据或秘密。用`node scripts/build-documentation-reference.mjs --write`机械刷新快照后须重新校验和恢复演练。图标原件可从ASSET参考恢复，但用户头像/照片仍需Storage备份。文档包、源码镜像、数据库与Storage备份应分别存到仓库之外；浏览器缓存和GitHub单一副本都不是备份。

未来 AI 不得自动修改生产、绕过 RLS、凭邮箱或邀请码认定 Owner，或把已发现缺陷复制为需求。发布须经维护者确认，并通过审查报告中的门禁。

## 致谢

Built with the help of Codex, with special thanks to Claude for prompt design and development support.
