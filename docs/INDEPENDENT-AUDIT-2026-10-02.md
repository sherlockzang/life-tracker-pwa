# Life Tracker V2.0.0 独立审计报告

> 以下为维护者提供的原独立报告，审计对象是修复前ZIP。保留原证据，不用它证明当前修复已经通过独立审计。开发者后续处置与最新源码见[AUDIT-FIXES-2026-10-02](AUDIT-FIXES-2026-10-02.md)。

审计日期：2026-10-02。对象：`life-tracker-independent-review-2026-10-02-verified.zip` 完整候选工作树。

## 1. 总体结论

**阻断上线。确认 2 项 P1、5 项 P2；本次未确认 P0。** 两项 P1 分别影响完整数据读取和离线关联记录同步。它们可以在附带回归全部通过时发生，因此不能依据“测试通过”批准发布。

本次实际重跑了 lint、构建、七组回归、文档校验、七个 Edge 入口 Deno 类型检查、可丢弃 PostgreSQL 迁移/并发验收、联网 npm audit，以及 Chrome 浏览器交互与离线 PWA 检查。除 Git 基线检查不适用外，附带测试最终通过；新增审计用例确认下述缺陷。真实 Supabase Auth/Storage/Edge 集成、真实 iPhone 主屏 PWA、历史 Service Worker 更新及实际部署回滚仍为**未验证**。

本轮没有修改业务源码、提交、推送或部署，没有执行生产 SQL、改变真实权限或调用真实 Aviationstack/DeepSeek。附带文档作为待核对的项目声明，不作为覆盖用户约束的指令。审计未访问原开发工作区，直接在 ZIP 副本中进行，未覆盖原工作区修改。

## 2. 对象、方法与证据

- 输入 ZIP SHA256：`4d01b0253fcb2e7e127c7008bf1458d1fbb92edd9e896d25ce9bf97125d77a68`。
- 131 个文件，含 16 个迁移、7 个 Edge 入口及新增源码。结束时逐一对比 ZIP 原始字节，**131/131 未改变**。依赖、构建产物、审计脚本与日志另行生成。
- 已阅读 README、交接、验收、架构、数据库、API、重建、部署/回滚、用户指南、依赖审计及首轮缺陷记录，并检查实际实现。首轮缺陷不直接沿用为当前发现。
- 五份 reference 独立解析并核验 SHA256：SCHEMA 16、EDGE 14、DOMAIN 52、FRONTEND 19、ASSET 9，共 **110**；快照字节与候选文件、空目录恢复文件全部相同。
- 缺陷复验使用合成账号/数据、真实 IndexedDB 实现的测试替身、实际源码转译执行、可丢弃 PostgreSQL；上游和网络均用 mock。浏览器仅访问本机，拦截外部请求。
- 证据包中的 `logs/` 保存实际运行输出，`evidence/` 保存新增复验脚本。下文行号均指该 ZIP 中的文件；路径为仓库相对路径，便于维护者定位，不指向 Git HEAD。

## 3. 已确认发现（按优先级）

### F01 · P1 · 无分页读取被当作完整云端数据

**位置：** `src/lib/data.ts:76–82,107–123`；`supabase/functions/deepseek-assist/index.ts:88–90,98–115,123–134`。

**问题与影响：** records、trips、汇率及服务端 AI 数据读取均没有分页，也没有判断结果是否完整。返回成功后直接替换本机快照。达到服务端单次返回上限时，旧记录从界面、本机快照和统计中消失；AI 汇总也只使用部分记录。完成状态检查可能看不到上限之后的未完成计划。云端记录本身不会因此被删除。

Supabase 官方说明默认单次最多返回 1000 行，并建议用 range 分页；实际项目可配置不同上限。本次未读取生产设置，但任何有限上限都会触发同类问题。[Supabase select 文档](https://supabase.com/docs/reference/javascript/v1/select)

**复现与证据：** 用 1001 条同账号 USD 1 消费记录，让 mock 按默认上限返回 1000 条，执行实际 `fetchAppData`。`custom-pagination.log` 输出 `cloudRows=1001, loadedRows=1000, cachedRows=1000, loadedUsdTotal=1000, trueUsdTotal=1001, recordQueries=1`。前端完整快照误判已实测；AI 完成判断误判是同一读取模式的源码推导，未单独在真实 PostgREST 运行。

**最小修复：** 所有需要完整集合的读取使用稳定顺序（含唯一 ID）的分页，并在全部成功后替换完整快照；失败不得将部分结果当完整。AI 聚合和“是否存在未完成计划”优先采用数据库聚合/exists，避免单页判断。补充上限前后、分页中途失败及分页期间更新测试。

**是否阻断上线：是。** 普通长期使用会进入该边界，静默少算和覆盖完整本机副本不满足数据可靠性要求。

### F02 · P1 · 离线合并会破坏跨实体依赖顺序

**位置：** `src/lib/offline.ts:73–101,104–108`；`src/lib/data.ts:115–118,161–166`；`src/lib/syncEngine.ts:4–6,37–40`。

**问题与影响：** 队列依赖只追踪同表同实体，没有为 `trip_id`、`parent_plan_id` 建立父记录依赖。合并 pending 写入时删除旧项并生成更晚 `createdAt`；重放按时间排序，子记录可能早于新旅程/父计划提交。关联校验拒绝后进入永久 failed，父记录稍后成功也不会自动恢复子项。再次读取云端只叠加 pending/inflight，failed 草稿从主列表消失；副本仍在失败队列，可导出和手动重试，不能描述为不可恢复删除。

**复现与证据：** 离线创建旅程 T → 添加属于 T 的计划 R → 编辑 T → 恢复网络。执行实际 `queueMutation/listMutations/replayMutation`，模拟数据库缺失父记录拒绝。`custom-sync.log` 显示顺序 `[records:new-plan, trips:new-trip]`，两项 `dependsOn=null`；结果 R failed、T confirmed，队列剩 R。模拟返回 FK 错误 23503；实际 `validate_record_relations` 在旅程不存在时抛 P0001，二者在当前分类中均永久失败。正常关联所有权 SQL 测试另已实际通过。

**最小修复：** 对新旅程与关联计划、父计划与实际消费/随记建立跨实体依赖，拓扑重放；pending 合并不得丢失父节点及依赖。依赖未提交时应等待，不能永久失败。不能直接复用当前 `finishMutation` 的“把父 updated_at 赋给子 expectedUpdatedAt”逻辑处理跨实体，子记录需要自己的 CAS 版本。

**是否阻断上线：是。** 合理的离线创建/编辑顺序即可稳定触发，影响核心保存承诺。复验应包括刷新、租约过期及同毫秒入队。

### F03 · P2 · 父计划更新没有维护已有子记录关系

**位置：** `supabase/migrations/20260714000000_initial_schema.sql:100–130`。

**问题与影响：** 触发器验证正在写入的记录及其父记录，但不验证该记录已有的子项；更新触发列还漏了 `record_type`。父计划从本人 T1 移到本人 T2 时，原实际消费/随记仍属于 T1，产生“子记录与父计划属于同旅程”的不变量破坏。当前没有通用转移 UI，但认证用户可以调用已有 CAS RPC；不是跨账号读取或 Owner 提权漏洞。

**复现与证据：** 可丢弃 PostgreSQL 中，同账号建立两旅程、T1 父计划及其子随记；以 authenticated 身份调用 `save_user_mutation` 将父计划 `trip_id` 改为 T2。`custom-database-utc.log` 输出 `AUDIT_PARENT_MOVE {saveOk:true,mismatchCount:1}`。这项为实际 SQL 复验，不是 mock。

**最小修复：** 有子项时拒绝破坏关系的父 `trip_id/record_type` 更新，或事务内迁移子项并正确更新 CAS 版本；处理并发创建子项/移动父项所需锁顺序。增加反向更新与类型变更测试。

**是否阻断上线：单项否。** 应在发布前修复数据约束；若暂不修复，需要明确禁用该变更路径并验证服务端限制，不能只隐藏按钮。

### F04 · P2 · 上游内层异常形状没有完整验证

**位置：** `supabase/functions/deepseek-assist/index.ts:168–181`；`supabase/functions/lookup-flight/index.ts:121–129,243–250`。

**问题与影响：** 外层 JSON 包络已校验，但消费解析把模型内容 `JSON.parse` 后直接断言对象；`null` 进入 TypeError 和通用 503，数组/布尔/数字/字符串返回 200、全字段 null 并标记 persisted。航班只验证 data 是数组，数组里的 null 会使 exactMatch 抛错，排在它后面的有效匹配无法使用。异常被外层捕获，不会导致整个进程或浏览器未捕获崩溃；当前错误语义和成功判定仍不正确。

**复现与证据：** `custom-ai.log`：模型内层 content=`null` → 503 INTERNAL_ERROR，日志为读取 amount 的 TypeError；`[]/true/42/"text"` → 200，全部空字段，persisted=true。`custom-flight.log`：data=`[null, validFlight]` → 通用异常，而不是使用有效航班或明确拒绝形状。每项上游请求计数/配额均为一次，没有证明重复扣费或泄漏密钥。

**最小修复：** 消费模型结果必须为非 null、非数组对象，否则返回明确 AI_INVALID_OUTPUT；航班遍历前验证每项和必要嵌套字段，按明确策略跳过坏项或返回 API_UNAVAILABLE，并保留清理/usage 完成路径。补内层 null、数组、原始值与混合航班数组断言。已发送的供应商请求保持一次计费，不以格式错误假装撤销或退款。

**是否阻断上线：单项否。** 属于故障降级缺陷，建议与核心修复一起完成；文档“二次验证”表述需随之准确。

### F05 · P2 · 配额读取失败仍响应“完整剩余额度”

**位置：** `supabase/functions/get-api-quota/index.ts:41–50,55–70`。

**问题与影响：** entitlement、桶、冷却和月用量查询均忽略 error。数据库故障被当成无授权、零用量、无冷却，HTTP 200 展示 standard 航空剩余 100/100。用户得到错误身份/余额反馈。实际 admission 仍走事务 SQL，本次未发现借此绕过服务端配额。

**复现与证据：** 所有查询 mock 返回 `{data:null,count:null,error:...}`，执行实际入口。`custom-quota.log` 输出 status=200、tier=standard、globalRemaining=100、cooldownUntil=null、deepseekMonthTotal=0。

**最小修复：** 检查每个查询错误，读取不完整时返回 DATA_UNAVAILABLE/503 或明确 unknown；只在查询成功、确实无行时补零。分别注入身份、桶、冷却和计数失败测试。

**是否阻断上线：单项否。** 未证明超额调用，但配额界面不能把故障显示为可用余额。

### F06 · P2 · 上海月额度结束时间使用了错误的日历运算

**位置：** `supabase/functions/get-api-quota/index.ts:11`；`supabase/migrations/20261001030000_atomic_quota_admission.sql:18–21,33–34`。

**问题与影响：** 上海 10 月 1 日零时对应 UTC 9 月 30 日。Edge 在这个 UTC 日期上 setUTCMonth(+1)，得到 UTC 10 月 30 日 16 时，即上海 10 月 31 日零时；正确应为上海 11 月 1 日。SQL 对 timestamptz 加 interval month 受会话时区影响，在 UTC 会话有相同问题。桶 key 仍按上海 YYYY-MM，因此本次未证明提前清零/超额；错误影响 period_end/reset_at 和用户重试预期。

**复现与证据：** Edge 固定时钟 2026-10-02，`custom-quota.log` 月桶 period_end=`2026-10-30T16:00:00.000Z`。真实 PostgreSQL 设置 UTC 会话后，`custom-database-utc.log` 输出 `actual_end=2026-10-30T16:00:00.000Z`、`correct_end=2026-10-31T16:00:00.000Z`。原脚本默认 Asia/Shanghai 因而漏掉 SQL 分支。

**最小修复：** 在上海本地无时区 timestamp 上先计算下月第一日，再转为 timestamptz；Edge 用明确本地年/月构造下月 1 日 +08:00。覆盖二月、闰年、长短月及 UTC/上海数据库会话，核对已有桶的修正策略。

**是否阻断上线：单项否。** 显示/重试元数据错误已确认，实际额度池越界未确认。

### F07 · P2 · 路线 API 合同示例与输入规则不兼容

**位置：** `docs/API-CONTRACT.md:35–42`；`supabase/functions/deepseek-assist/index.ts:68–73`；`src/components/HomeRouteSearch.tsx:72,112`。

**问题与影响：** 合同写 query 或 origin/destination 二选一，示例只有 query；实现对三项都调用必填 stringField。依合同重建的客户端会收到 INVALID_INPUT。当前前端同时发送三项，所以正常表单不触发该错；前端实际是出发地/目的地双输入，也不等同于部分文案中的“一句话路线查询”。

**复现与证据：** 以有效 mock 身份和 UUID 发送合同示例中的 query-only 请求。`custom-ai.log` 输出 `AUDIT_QUERY_ONLY_ROUTE status=400, code=INVALID_INPUT`；未调用上游。origin/destination-only 的不兼容由同一必填 query 源码直接可见，未另跑真实入口网络测试。

**最小修复：** 明确产品接受哪种输入，统一合同、例子、前端与后端；若保留二选一，服务端为两条合法路径构建 prompt 并测试缺项/长度。更新 reference 快照并重新恢复验收，不由本次审计擅改需求。

**是否阻断上线：单项否。** 会阻碍按文档恢复相同行为，必须修正灾备合同。

没有为凑数量列出 P3 缺陷。构建主包约 652.26 kB、超过 Vite 默认 500 kB 提醒，属于可选性能优化；目前没有测得因此造成不可用。

## 4. 实际执行记录与环境

环境：macOS 27.2（26B5091g）、Apple Silicon；Node 26.3.1、npm 11.16.0、Deno 2.5.3、可丢弃 PostgreSQL 18.4、Chrome 154.0.8037.93。依赖使用包内 lockfile；Vite 8.3.1、PWA 插件 1.3.0。浏览器运行时使用 bundled Playwright 和本机 Chrome；不等于 iOS Safari。

| 实际命令/检查 | 结果与证据 | 能证明的范围 |
| --- | --- | --- |
| `npm ci --ignore-scripts --offline --cache=/private/tmp/life-tracker-doc-npm-cache --no-audit` | 成功，532 packages；原副本和恢复副本均执行 | 锁定依赖可安装；使用既有缓存，未验证完全无缓存联网安装 |
| `npm run lint` | exit 0；check-0.log、restored-check-0.log | 当前 ESLint 范围 |
| `npm run build` | exit 0；check-1.log、restored-check-1.log | TypeScript/Vite/PWA 产物；有包大小提醒 |
| `node scripts/test-airlines.mjs` | exit 0；check-2.log，恢复同通过 | 114 航司、名称/代码、号码规范 |
| `node scripts/test-flight-duration.mjs` | exit 0；check-3.log，恢复同通过 | 跨日/日期线、LA/纽约、DST 双重时刻、Lord Howe 半小时、不存在时刻 |
| `node scripts/test-flight-trip-placement.mjs` | exit 0；check-4.log，恢复同通过 | 首日入境与旅程投影边界 |
| `node scripts/test-schedules-and-flight-display.mjs` | exit 0；check-5.log，恢复同通过 | 全天含结束日、酒店续住/退房/换店/冲突及状态显示 |
| `node scripts/test-calendar-and-sync.mjs` | exit 0；check-6.log，恢复同通过 | 隔离、隔离旧队列、同实体合并/依赖/租约、保存失败保留草稿、CAS mock；遗漏 F02 |
| `node scripts/test-flight-integrity.mjs` | exit 0；check-7.log，恢复同通过 | 航段语义版本、旧请求桥接、恢复签名、14 秒头/body 超时、usage 失败；遗漏 F04 混合数组 |
| `node scripts/test-ai-reliability.mjs` | exit 0；check-8.log，恢复同通过 | 分币种、当地午夜、恢复签名/仅保存重试、24 秒头/body 超时及账号切换；遗漏 F04 模型内层形状 |
| `node scripts/verify-documentation.mjs` | exit 0；check-9.log、restored-check-9.log | 18 Markdown、98 本地链接、110 快照；不能证明合同语义一致 |
| `node scripts/verify-ui-contract.mjs` | 实际尝试 exit 1，git status 128；check-10.log；**不适用** | ZIP 无 Git 历史、无 stable-before-v2.0.0。未造基线；手工检查当前 UI，未证明历史差异全部不变 |
| `deno check --no-config --no-lock` 加七个入口文件 | 两副本 exit 0；deno-check.log、restored-deno-check.log | 真实 Deno 类型检查；不是仅 TS 转译；不等于 Supabase Edge 网关集成 |
| `node scripts/test-database-integrity.mjs` | 沙箱首次 shmget 拒绝；获准仅本机非沙箱重跑 exit 0；database-escalated.log | 本次实际 PG16迁移/升级、RLS/CAS、并发、旧 SQL/Edge 协议路径和 AI 原子存储，不采用历史通过记录 |
| `npm audit --json`；`npm audit --omit=dev --json` | 联网各 exit 0，已知漏洞均 0；两份 npm-audit JSON | 当时 registry 对锁定树的已知公告；不证明自有代码或供应链无风险 |
| 新增 pagination/sync/AI/flight/quota 用例 | 各执行完成，输出 F01/F02/F04/F05/F06/F07 反例 | 实际函数 + 指定 mock，非真实供应商 |
| 新增 PostgreSQL 反例与配额边界竞争 | custom-database-utc.log | F03/F06 实际 SQL；AI 9999、非Owner航空79、全局99各20并发，均仅1 admitted，最终10000/80/100 |
| Chrome 浏览器与控制台 | browser-audit.log、browser-interactions.log | 402×874、1440×1000；浅/深色、主色 #0A84FF、隐私开关、完整航班编辑、完成撤回、不划掉、无横向溢出/未捕获 pageerror |
| 跨日酒店/全天实际交互 | browser-schedules.log：3条源记录投影出入住/连住/退房/换店；取消、恢复、完成、撤回；深色桌面无溢出 | 本地demo实际控件，非真实云保存 |
| 恢复构建的 Service Worker/manifest/断网刷新 | pwa-offline.log：offlineReload=true | 新安装 Chrome SW、图标/作用域、standalone、离线 demo shell；未证明旧版本更新和真实离线账号同步 |

Deno 的完整入口集合：start-demo-session、deepseek-assist、lookup-flight、query-transit-route、redeem-invite、get-api-quota、owner-admin，路径均为 `supabase/functions/<name>/index.ts`。使用本机现有 Deno 缓存（Supabase jsr @2 当时解析 2.117.2），未声称仓库锁定了 Deno 远端依赖。

环境准备中出现过联网安装停滞、依赖尚未完整安装时命令缺失及一次不支持的 Deno 参数；随后按顺序安装并更正参数，以上表记录最终有效执行结果。这些不列为产品缺陷。首次数据库 shmget 拒绝属于环境限制；后续获准的可丢弃本机重跑已经解除这一验证边界。

## 5. 正确性与安全性的实际覆盖

本次 SQL 验收验证两合成账号的 RLS、禁止伪造 user_id/跨账号关联、CAS 旧版本冲突、请求 UUID 幂等、service-only RPC、头像路径权限。检查 SECURITY DEFINER/search_path/GRANT/REVOKE 及有效 Owner entitlement 路径，当前范围未确认前端邮箱/参数或普通邀请码可直接授 Owner；Owner 管理经过服务端角色检查，产品 Owner 不具有数据库超级管理员能力。F03 是同账号关联不变量缺陷，不能扩大成跨账号越权结论。

航空池真实事务验收满足全局 100/月、非Owner合计 80/月；Owner 可以借用总池剩余，并非固定20，也没有额外加20。追加总量边界20并发仍无超额。AI 非Owner轻量共享10000/月、限频10次/60秒后冷却、重复 UUID、Owner 豁免等路径通过已执行 SQL 断言；缓存命中和仅保存重试在 mock 中验证无新上游/预留。

航段修改、旧预览/UUID/语义版本拒绝、旧接口桥接、不能用不可靠实际偏移冒充事实、计划取消前拒绝和完成撤回已有测试支持。浏览器实际操作 LA 重复时刻：未选择时阻止保存；第一/第二次分别显示3/2小时，选择第二次保存 UTC 09:30/-480。其他 DST 边界为函数/SQL 测试，未全部逐一操作浏览器。

混币种统计、旅程当地日与上海额度日区分、酒店/全天/入境投影、午夜缓存身份、签名范围/账号绑定、新结果优先及原子 cache/usage 在其断言范围通过。上游头和 body 超时使用真实源码及可控计时/传输 mock；没有真实测量供应商响应。已发送请求失败保留计数，未看到“假撤销退款”断言被破坏。

这些结论不覆盖真实平台默认 grants、JWT 网关、Auth 邮件、Storage 服务自身或供应商协议实际返回。前端认证流程已静态检查和切换 race mock；没有真实邮箱 OTP 成功证据。

## 6. 文档、需求与灾备差异

1. F07 的 route 二选一合同已确认不一致；F04 的“二次验证”没有覆盖模型内层非对象；F01 的完整数据/统计承诺在大集合下不成立；F02 的依赖链只涵盖同实体，不能支持全部关联离线操作。
2. Standard 轻量 AI 当前是 **15次/人/日**，合同、SQL、前端展示一致；与历史 **10次/日** 需求不同。维护者应明确接受15或另立变更，本审计不擅改。
3. 10000共享池当前只计 route/expense_parse/note_polish，不含 recap/summary，Owner不占该池。当前合同明确这个边界；若历史需求指全部AI，须产品决策，不能把它表述为已实现所有AI总池。Demo日2/设备及全体100、Standard航空日2/回顾月3/摘要日1、Friend回顾月10、Owner无产品AI限额与当前 SQL 一致；客户端设备 seed 可以重置，合同已披露，不能把每设备限额称硬身份防线。
4. 五份 reference、图标、配置模板、邮件模板、测试、全部迁移和锁文件均可恢复；恢复工具只恢复110应用文件，另拷贝 README/docs/supabase README 才可跑文档校验，部署文档已准确说明。本次执行了该流程和恢复回归。
5. 源码恢复不能恢复云端数据、Auth 身份、Storage 对象、Secrets、DNS/SMTP、Git历史与部署登记。备份/恢复层次、SQL-first→Edge→前端顺序、无自动 down migration、整库恢复丢新增写入的边界已有说明。没有据此认定生产备份已经完成或可恢复。
6. Passkey、邮箱提醒、完整数据导出等未实现项已明确列出，不作为当前功能。完整本机副本导出与“完整云端历史导出”不同，受 F01 数据完整性影响。

灾备评价：**源码与资源级恢复可行；业务语义文档需修正；云端灾备和跨版本实际恢复尚未验收。** 能机械恢复同一候选，不等于已恢复正确、可上线系统。

## 7. 未验证项目及测试盲区

| 项目 | 未验证原因与风险边界 |
| --- | --- |
| 真实 Supabase OTP、会话恢复、后台/前台、两账号端到端隔离 | 没有获授权测试项目/测试邮箱；不得使用生产权限。mock 不覆盖邮件模板生效、网关JWT或平台角色配置 |
| 真实头像上传/替换/越权下载及 Storage 服务规则 | PostgreSQL模拟 Auth/Storage 表，仅证明相关 SQL 策略断言，不能证明真实 Storage 集成 |
| 原字节全部迁移在完全无历史身份的真实新 Supabase 项目执行 | 本地16迁移脚本将历史Owner哈希在内存中替换为合成用户；且注入 V1.4.1 数据再升级。不是未配置历史身份种子的原字节空项目测试；新项目必须按文档安全处理身份种子 |
| 真正 V1.4.1 备份升级及旧 Edge 二进制并存 | 本地历史 fixture/兼容RPC路径已测；无真实旧部署、全量历史数据、平台配置。不能声称生产升级已通过 |
| 回滚前端/Edge、备份恢复演练 | 没有Git基线/旧dist/旧Edge部署或云备份。文档说明清楚，但实际向下兼容、安全写入与恢复对账仍需演练 |
| 真实 iPhone 主屏PWA、安全区、软键盘、邮箱OTP及升级 | 无真机；Chrome手机视口不能代替；新SW离线通过不覆盖已有安装更新和排队写入保护 |
| Aviationstack/DeepSeek真实模型可用性/返回模式/额度 | 用户禁止真实调用；只测mock。必须在授权隔离环境完成供应商配置确认，不能消耗生产额度 |
| Owner后台/邀请码全部真实交互、并发邀请兑换/多窗口demo会话 | 静态与部分SQL路径覆盖；未完成端到端和专门竞争验收 |
| 完整可访问性与所有弹层控件/屏幕阅读器 | 已检查实际选中页面和控件、溢出/异常；未跑完整辅助技术审计，不能写成全部可访问性通过 |
| 默认Row上限之外所有AI场景、生产规模与压力 | F01前端反例已测；AI截断影响主要来自源码推导；配额竞争为20事务边界测试，不是生产负载测试 |

测试质量：七组测试并非纯空断言，执行实际模块并对 timeout、保留草稿、幂等/计数等有有效断言；但 Supabase 客户端/RPC、Auth、上游被 mock。mock 没有强制真实分页语义和跨实体父依赖，外层异常包络用例也没有覆盖内层结果。SQL脚本增加真实并发价值较高，但默认机器时区和模拟平台结构使其漏掉 F06 及真实集成风险。文档校验验证字节/链接而非需求一致性。浏览器 demo 写入 localStorage，不证明真实云保存成功。

## 8. 发布前门禁

- [ ] 修复 F01/F02，并加入能够先失败、修复后通过的回归；保持账号隔离、完整快照及CAS语义，不能用提高row上限或永久错误无限重试代替修复。
- [ ] 处置 F03–F07；建议全部修复。若某P2延期，需记录具体影响、服务端限制和复验，不能继续宣称相关合同完整满足。
- [ ] 重跑原七组、新增边界用例、lint/build、真实Deno、文档校验、联网全量/生产audit；刷新五份reference后空目录恢复复验。
- [ ] 在维护者明确授权的 Supabase 测试项目执行原字节/安全配置化迁移、新项目与真实V1.4.1备份升级、JWT网关/两账号/Storage/Owner/邀请验收；始终保留RLS。
- [ ] 演练 SQL-first 与旧Edge共存、新Edge/旧PWA、前端/Edge回滚，验证离线队列和酒店新字段不丢失；保留可用旧dist/Edge/_shared版本与数据备份。
- [ ] 真iPhone主屏PWA验收安全区、键盘、OTP、后台恢复、旧SW更新、断网/刷新/切号，以及桌面Chrome真实账号路径。
- [ ] 确认真实模型/供应商配置和超时协议；仅在授权隔离环境，遵守本轮不消耗生产额度的约束。
- [ ] 核对Standard15与历史10、轻量10000池范围的产品决策，统一文档和界面；完成云数据/Auth/Storage/Secrets分层备份及恢复对账。

## 9. 给维护者的修复与复验清单

1. 优先分页完整性和跨实体离线依赖：1001条读取；离线建旅程→建计划→改旅程；离线建计划→关联消费→改计划，刷新/重连后全部确认。
2. 加反向关系约束和异常形状校验；以真实SQL验证父计划移旅程/改类型，以mock验证内层null/数组/原始值及混合航班数组。
3. 配额查询错误显式失败；上海下月第一日统一计算，在UTC和上海会话及闰月验证；继续保留100/80/10000边界并发计数。
4. 修订route合同与输入文案，确认15次产品决策；刷新reference后在新目录跑全部回归。
5. 最后完成真实测试项目和iPhone门禁，保存部署/回滚版本和分层备份，再重新评估上线资格。本报告不授权部署。
