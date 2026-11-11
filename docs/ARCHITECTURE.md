# 架构说明

文档初稿：2026-10-01；修复候选校核：2026-10-02。覆盖稳定 V1.4.1 与本地 V2.0.0 功能增量。实际部署状态需要核对 GitHub Actions、Supabase 迁移历史及函数版本，不能从源码推断。

## 1. 系统边界

```text
iPhone PWA / 桌面浏览器
  ├─ React 界面 → 纯领域算法（时区、显示、补全、统计）
  ├─ Supabase JS → Auth（邮箱验证码、刷新令牌）
  ├─ Supabase JS → PostgREST（用户 JWT + RLS）
  ├─ IndexedDB（用户快照 + 待同步操作）/ localStorage（演示）
  ├─ Frankfurter（公开汇率，直接请求 + Workbox 缓存）
  └─ Edge Functions
       ├─ 校验真实 JWT / 演示令牌 / Owner
       ├─ PostgreSQL RPC（邀请码、配额、航班匹配锁）
       ├─ Aviationstack（仅实际航班匹配）
       └─ DeepSeek（五类受控任务）
GitHub Actions → 静态 dist → GitHub Pages → PWA Service Worker
Resend SMTP ← Supabase Auth ← 用户申请验证码
```

没有自建常驻 Node 服务器；GitHub Pages 不处理秘密、业务鉴权或数据库访问。Supabase Edge 使用 Deno 风格运行时，不能把 Node 前端构建成功视为后端验证。

## 2. 前端组织与职责

| 模块 | 职责 / 禁止事项 |
| --- | --- |
| App | 会话、加载缓存和云端、演示、页面切换、保存确认/本地副本与同步；不拥有角色授权权力 |
| LoginScreen | 邮箱发送与 6 位码验证；不使用登录邮件外部链接 |
| QuickComposer | 三类快速记录、AI 预览；只有用户保存才创建记录 |
| Timeline | 顶层记录、筛选、日期分组、状态撤回、计划编辑；实际子记录由计划详情承载 |
| Planner | 旅程列表、旅程编辑、日期列、时间排序、跨天移动、实际子记录、回顾 |
| TransportPlanEditor | 通用/飞机/铁路/市内交通/全天/酒店六类表单、选填提示、验证 |
| FlightDetailsView / FlightDurationSummary | 派生展示，不改原计划、不请求 API |
| ScheduleDaySection | 一条跨日记录按日投影、入住/续住/退房、换店/重叠提醒 |
| HomeRouteSearch | 出发地/目的地双输入路线查询，结果可转为市内交通计划；后端API另接受一句话query |
| ExpenseStats | 分类/趋势/汇率缺失提示；按主币种换算 |
| SettingsPanel | 主币种、主题、资料、引导、更新记录、隐私、邀请码、额度、Owner 后台 |
| lib/data / offline | 云端 CRUD、默认资料、快照与离线 outbox |
| lib/account / ai / flightLookup | 端点适配、错误文案；不在浏览器存上游秘密 |
| lib/airlines / airports / aircraftTypes / timezones | 离线字典，和 API 查询分离 |
| lib/tripDates / flightTripPlacement / flightDuration / schedules / flightDisplay | 可测试的纯日期、范围、显示逻辑 |
| styles/tokens.css | 颜色、间距、圆角、阴影与主题唯一来源 |

不要在组件中复制机场/航司数据或时区换算。不要把计划字段与 API 实际字段混写。新表单字段必须同时修改类型、规范化、SQL 约束、兼容行为和验收用例。

## 3. 数据模型的关键决策

`trips` 是一段旅程的容器；`records` 是统一生活记录，`record_type` 为 expense / trip / note。旅程内的计划也是 trip 记录，实际消费/随记通过 `parent_plan_id` 关联计划，仍是独立记录而非嵌入数组。

交通结构存 `transport_type + transport_details`；全天/酒店存可选的 `schedule_details`。后者不是第四种 record_type，也不是每天复制一条记录。航班 API 输出存 `actual_info` 和匹配元数据，保留用户输入的原计划。

不持久化 `day_number`：展示日期减旅程开始日期再加一。改旅程开始日期后自然重算。日期差使用纯日历/UTC 日期计算，避免夏令时出现 23/25 小时。

航班当地时间另由`supabase/functions/_shared/flightTime.ts`纯模块供浏览器和Edge共享：枚举并往返校验真实UTC候选，拒绝不存在clock，重复clock要求显式numeric偏移。选择存于FlightStop JSON并参与版本签名，不复用通用事项的隐式时区换算来猜航班发生时刻。SQL有独立候选校验，保护SQL-first升级时的旧Edge入口；两层都不依赖浏览器替后端鉴权。

用户隔离不仅是 RLS：数据库触发器也检查 trip_id、parent_plan_id 的 owner 一致，不能通过关联他人 UUID 绕过隔离。

## 4. 日期与时区的三个层次

1. `event_at` 是绝对时间，PostgreSQL timestamptz；统一传 ISO UTC。
2. 旅程开始/结束是旅程时区的日历日期。全天和酒店范围也采用该日历。
3. 航班 departure / arrival 各自有日期、时间、IANA 时区。不能用旅程时区解释洛杉矶起飞时间；不能用固定 UTC 偏移替代 America/Los_Angeles。

航班时长 = 到达 UTC − 起飞 UTC。跨时区归属 = 起降 UTC 转旅程时区后的日期区间，与旅程区间有交集才纳入；已在旅程前起飞但期间落地者钳制到首日显示并标明原起飞日期。

航班实际匹配资格以计划到达的**绝对时刻**为准：到达 + 1 小时至 + 48 小时，前后端双校验，不是“今天日期大于出发日期”。这只是应用查询策略，不保证供应商一定保留相应数据。

已匹配显示每一端按 actual > estimated > scheduled > 原计划逐层降级，标注来源；原计划可展开。没有实际起飞时间时不可把混合来源的时长称作实际空中飞行时间。

时间线按航班出发当地日期、全天起始日期、其他记录设备日期分组；日期组显式倒序、组内event_at绝对时间倒序，避免异地航班导致30→28→29。摘要按旅程当地日，额度按上海日；航段语义编辑使旧匹配版本失效，历史actual保留但不冒充新计划。

## 5. 登录与会话

发送：`signInWithOtp({email, options:{shouldCreateUser:true}})`。首次邮箱自动建 Auth 用户并触发 profile 初始化。邮件模板用 `{{ .Token }}`，不是 ConfirmationURL。

验证：`verifyOtp({email, token, type:"email"})`。同一 PWA 内建立会话，客户端 persistSession / autoRefreshToken 开启；onAuthStateChange 驱动 UI。visibilitychange(visible) 和 pageshow 调 getSession，防止界面保留陈旧状态。

重新检查只能读取当前存储环境的会话；不会同步 Safari 与独立 PWA 的隔离存储。OTP 在各自窗口内登录才是解决方式。恢复旧外链兼容的 detectSessionInUrl/PKCE 不是主要登录入口。

注册邮件 Confirmation 和已有账号 Magic Link 邮件模板都必须换成数字码，否则新旧用户体验不一致。OTP 位数必须与 UI 的 6 位约束一致。

## 6. 读写与离线流程

首次加载：按 userId 读快照 → 仅同步该账号 outbox → 按user_id显式过滤且由RLS隔离的云端读取 → 合并未确认的本地操作 → 更新快照。请求前后比较账号及access token，变化则放弃该批读取；默认资料只插入缺失行，不覆盖另一设备新内容。无缓存时读取失败明确显示错误。

所有完整集合使用共享readAllPages：按不可变唯一id升序、gt游标、limit500读取到空页，不把短页视为结束（服务端cap可能更低）；用于records/trips/rates/changelogs、AI计划完成状态/聚合/摘要。任一页失败不发布部分集合、不替换完整快照或调用AI。显示排序在完整集合取得后单独处理。分页不是单一数据库事务快照：期间新插入、删除或修改会在后续刷新收敛，不承诺某一绝对时刻全表一致，但不会因日期变更或删除已读行造成offset位移漏读。

记录保存：组件验证 → makeRecord → 先持久写入当前账号outbox → save_user_mutation → confirmed/pending/failed/conflict → 仅confirmed/pending更新页面。永久失败保留草稿和可导出副本。RPC只接收可编辑字段、比较旧服务器updated_at，以请求UUID/完整请求体收据做幂等，不是整行盲目upsert。

快照库 `life-tracker` version 3：snapshots主键userId；outbox主键id，by-created/by-owner索引；automaticSummaries保存用户/上下文自动摘要尝试标记。操作含ownerId/entityId、table、payload、expectedUpdatedAt、dependsOn、relationDependencies、state、attempted、replacesFailed、supersededBy、租约和错误。dependsOn只用于同实体CAS链；跨实体依赖只等待，绝不混用父updated_at。拓扑重放，领取时重推关系兼容旧v2队列；父成功清等待，只重基同实体后继。仅attempted=false且无人依赖的未发送项可合并；已尝试/旧v2未知发送历史保留UUID，先重放收据再保存后继。同毫秒顺序递增。修正失败项沿用原云端CAS基线，成功后以supersededBy归档旧失败副本：可导出但不叠加、领取或计入待处理。失败修正及真正跨设备冲突不自动归档。旧v1副本仍隔离，账号队列及演示独立。

主页编辑日期按旅程时区，不使用设备分组日期。非航班event_at转换也复用严格flightTime解析：拒绝不存在时间，新重复时间必选偏移，已有时刻保留重复次序及秒。拖动到歧义/不存在时刻时打开编辑器，不改原计划。全天/酒店以date-only为业务日期，新代表event_at取当地中午，起始日未变保留原锚。

顶部区分网络与云端确认，显示待同步/待处理数量，可查看副本、导出JSON和手动重试。冲突/旧队列不自动重试；核对后重新编辑，不做静默最后写入覆盖。实时协同、字段级合并和旧客户端盲写仍不是保证；新客户端保护不能替代让旧PWA升级。详见[修复验收](ACCEPTANCE-2026-10-01.md)。

## 7. 后端安全层

所有函数先限制方法、Origin 和 JSON 体；真实用户通过 admin.auth.getUser 验 JWT，身份必须从 token 得到。demo 用独立随机令牌哈希查 session，不能让浏览器传 userId 或 tier 决定授权。

`service_role` 只存在 Edge 环境。CORS 是浏览器限制，不是防爬/权限控制。前端隐藏按钮只是体验，Owner 端点与 RPC 再次查有效 entitlement。Owner 后台仅返回账号邮箱、注册/登录时间、等级和计数，没有记录内容端点。

邀请码输入大写、去空白后 SHA-256；数据库储存哈希，不储存邀请码明文。邀请码最多把真实用户变成 Friend，绝不授 Owner。初始 Owner 由管理员在受控 SQL 环境绑定已验证 Auth UUID。

额度在数据库事务预留，requestId 唯一、桶按北京时间日/月分期，日志记录状态。缓存结果、非法未来航班和确认保存不得重复消耗。已请求上游的失败/未命中通常仍计数，不自动返还。

频率检查和桶预留共用事务锁，先锁再查60秒计数。航段版本按号码、两端IATA/日期/时间/时区变化递增；确认时行锁复核版本与请求。已确认请求UUID和正在查询请求UUID分开，重匹配不会误复用旧结果。

AI缓存保存与完成用量在store_ai_result中原子提交；失败仍返回内容及账号/动作/目标绑定、30分钟有效的HMAC凭据。浏览器保留原账号副本；retry_save只写数据库，不预留额度、不调用模型。航班预览亦有短时签名凭据，确认重试只写数据库。凭据不加密内容、不包含服务密钥，验证仍需JWT。摘要按活跃旅程当地日期投影，缓存键包含旅程ID/时区/当地日；额度日期仍为上海。

自动摘要在请求前通过IndexedDB读写事务领取owner/context标记，同origin窗口原子且跨刷新持久；失败/未知结果不会因30秒时钟或恢复前台重试。账号切换后不发原请求，领取新上下文时清理超过30天标记。设置手动生成仍可用。这不是服务器安全额度：其他设备、新origin或清站点数据可再尝试，后端缓存/配额/限流保持不变。

## 8. 外部服务与隐私

- Supabase：账号、业务记录、缓存与角色/配额；RLS 隔离普通用户。
- Resend：仅经 SMTP 发送 Auth 邮件，接收邮箱与验证码邮件内容。
- Aviationstack：航班号查询；服务端过滤日期及机场，不提交全部旅行笔记。
- DeepSeek：只发送当前动作需要的文本/行程摘要，数据最小化；不发送邮箱、JWT、API key。
- Frankfurter：仅币种代码与汇率请求，不发送用户记录。

公开头像 bucket 允许持有 URL 的人读取，不属于私密记录保证。平台管理员/service-role 在技术上能访问云端数据，不能宣称端到端加密或“任何管理员都看不到”。本地缓存同样是敏感数据；共享设备需要退出及谨慎清理，未同步数据先备份。

## 9. 兼容和演进

新日程字段用nullable JSONB；旧客户端未提供字段时不覆盖它。新客户端兼容缺少schedule_details的旧数据。迁移只新增，不删除原记录；新客户端可编辑白名单/CAS已取代盲写，旧客户端全行upsert仍可能覆盖其他用户可编辑字段，应尽快升级，不能把新协议保证用于旧程序。

升级顺序：向后兼容数据库 → Edge → 前端 → 实机验收。回滚前端保留兼容数据库，回滚函数保持新 Auth/Quota 合同。不要“回滚网站”时把全部数据库恢复成发布前快照而抹掉新增用户记录。

[数据库](DATABASE.md) · [API](API-CONTRACT.md) · [重建规范](REBUILD-SPEC.md) · [部署回滚](DEPLOYMENT-ROLLBACK.md)
