# 数据库、存储和权限说明

初稿：2026-10-01；修复候选校核：2026-10-02。精确 SQL（字段类型、默认值、约束、索引、触发器、RLS、RPC、历史种子）全部保存在 [独立迁移参考](reference/SCHEMA-REFERENCE.md)。它是可提取回 .sql 文件的完整文本，不依赖原 SQL 文件仍存在。

## 1. 执行顺序

| 顺序 / 文件时间前缀 | 内容 |
| --- | --- |
| 20260714000000_initial_schema | settings、trips、records、rates、关系触发器、RLS、record-images |
| 20260714010000_profiles_changelogs | profiles、changelogs、Auth profile 触发器、avatars |
| 20260714020000_release_1_1_1 | 首版及更新记录、图标说明 |
| 20260714030000_release_1_1_2 | 图标和安装说明 |
| 20260714040000_release_1_2_0_transport | transport_type / details、交通约束与更新说明 |
| 20260714050000_release_1_2_1_flight_lookup | 航班匹配版本说明 |
| 20260714060000_release_1_3_0_security_and_ai | 实际航班、角色、邀请、演示、配额、缓存、RPC |
| 20260714061000_release_1_3_0_demo_device_session | 演示 device_hash 唯一，重复设备保留 session ID |
| 20260714062000_owner_entitlement_repair | 原维护者 UUID 角色修复 |
| 20260715000000_release_1_4_1_owner_admin_and_quota | Owner 后台审计、航空总池100/非Owner80、OwnerAI无额度、头像SELECT策略 |
| 20261111172324_release_2_0_0_ui | V2版本说明及新增用户版本默认 |
| 20261111172339_all_day_schedules | V2 nullable schedule_details 与范围约束 |
| 20261111172344_safe_client_mutations | 字段白名单、版本冲突、幂等收据与单调updated_at |
| 20261111172354_flight_integrity | 航段版本、元数据保护、原子确认与旧Edge安全桥接 |
| 20261111172402_ai_cache_context | 旅程当地日缓存上下文、缓存与用量原子提交 |
| 20261111172411_atomic_quota_admission | 频率检查移入事务锁，额度数值不变 |
| 20261111172418_audit_relations_and_periods | 父计划反向关系约束、并发SHARE锁；修正既有桶重置元数据，不重置计数 |
| 20261112050946_harden_profile_trigger | 撤销客户端对资料触发器函数的直接执行权限 |
| 20261112050955_record_image_ownership | 移除仅随记可附图的旧限制，存储桶仍为私有并受账号策略保护 |

目前共 19 项迁移；以上版本号按原项目生产迁移记录校准。空项目依次执行；已有项目先核对迁移历史，只运行未应用项。后一个同名 RPC 覆盖前一个，不能只取早期额度函数。临时 PostgreSQL 验收覆盖旧数据升级、CAS/RLS 及并发；Auth/Storage 采用平台结构模拟，不能代替真实项目集成验证。

参考 SQL 内原项目 Owner 邮箱哈希及邀请码哈希是历史身份种子，不是可跨项目复用的账号机制。新建项目应在执行前去掉/替换这两类身份种子，再按本文件初始化新 Owner / 邀请码。历史角色 repair 不要用于任意新用户。

## 2. 关系

```text
auth.users
 ├─ 1:1 profiles / user_settings / api_entitlements
 ├─ 1:N trips
 │       ├─ 1:N records
 │       │       └─ records.parent_plan_id → 同用户同旅程的 trip 计划
 │       └─ 1:1 trip_recaps（每用户每旅程唯一）
 ├─ 1:N records / exchange_rates / invite_attempts / api_usage_events
 ├─ 1:1 invite_redemptions → invite_codes
 ├─ 1:N daily_summaries（每用户/旅程当地日上下文唯一，上海日期只报告）
 ├─ 1:N client_mutation_receipts（每用户/请求UUID唯一，服务端专用）
 └─ owner_entitlement_audit（actor、target）
demo_sessions → api_usage_events
records → flight_match_previews
api_quota_buckets / policies / cooldowns 是服务端专用设施
```

Auth 用户删除大多 cascade；trips 被 records 引用时 restrict；parent_plan 删除时子记录关联 set null；Owner 审计 actor restrict。产品暂未提供任意删除入口，但恢复/管理数据时必须理解 FK。

## 3. 用户业务表

创建时间默认now()；更新触发器取greatest(clock_timestamp(),old.updated_at+1microsecond)，保证同一事务内版本也改变。客户端比较服务器返回的完整时间字符串，不截断微秒。

| 表 | 主键、字段与规则 |
| --- | --- |
| user_settings | user_id PK/FK；base_currency 默认USD（13种枚举）；theme 默认system（system/dark/light） |
| profiles | user_id PK/FK；display_name trim1–40；avatar_url nullable；avatar_color #RRGGBB 默认#0A84FF；has_seen_onboarding false；last_seen_version nullable |
| trips | id UUID、user_id；name1–120；destination 默认空；start_date/end_date DATE；timezone默认UTC；archived_at nullable；end>=start；(id,user_id)唯一 |
| records | id UUID、user_id；record_type expense/trip/note；content1–4000；notes/location nullable；event_at timestamptz；trip_id、parent_plan_id nullable；plan_status planned/completed/cancelled；sort_order numeric(18,4)；image_path nullable |
| exchange_rates | id UUID、user_id、base/quote、rate numeric(20,10)>0、rate_date DATE、source api/manual；base!=quote；不是每个币对唯一，可保存多个快照 |
| changelogs | id UUID、version唯一x.y.z、summary text[]、created_at；用户只读 |

records.amount numeric(18,4)、currency、expense_category 必须同 expense 类型一起存在，amount>=0；非 expense 三字段必须NULL。非trip不能有plan_status/sort_order；旅程内trip必须有status；parent只能用于expense/note，不能自指；image_path仅note。

records_validate_relations 触发器：trip 必须属于该 user；parent 必须是同 user 的 trip 记录，且 child.trip_id 和 parent.trip_id 一致。不能只依赖应用表单保证。

触发列包含record_type；已有子项时，父计划修改trip_id/type/user_id若破坏子项关系会拒绝，不自动移动子项或改CAS版本。子项检查父行时取FOR SHARE，父更新已有行锁，与并发创建子项串行并在锁等待后重新验证；两种提交次序均经真实PG验证。复杂互相更新出现40001/40P01/55P03时客户端保留pending等待重试，不无限重试永久关系错误。升级前若已存在不一致历史关系，应先列出并人工核对，不自动猜测应移到哪段旅程。

发布前只读核对（存在结果就先停下核对，不能直接删除或迁移用户记录）：
```sql
select c.id as child_id, c.trip_id as child_trip, p.id as parent_id, p.trip_id as parent_trip
from public.records c left join public.records p on p.id = c.parent_plan_id
where c.parent_plan_id is not null and (
  p.id is null or p.record_type <> 'trip' or c.user_id <> p.user_id or c.trip_id is distinct from p.trip_id
);
```

额度end在上海本地timestamp上先加日/月，再转timestamptz，不依赖数据库会话时区。最后迁移根据period_start修复旧period_end；桶key、limit、used_value和usage事件保持原值。

索引：trips(user_id,start,end)；records(user_id,event_at desc)、(user_id,record_type,event_at desc)、有旅程的日序、parent；rates(user_id,base,quote,rate_date desc)；changelogs(created_at desc)。

## 4. records 扩展 JSON 合同

### 4.1 交通

transport_type 可为空或 flight/rail/metro；transport_details JSONB 可为空或object；二者成对存在且只用于旅程内、无parent的trip计划。数据库约束没有严格检查 JSON 内全部字段，客户端及 Edge 必须做语义验证。

Flight（date YYYY-MM-DD，time HH:mm，timezone 标准 IANA）：

```json
{
  "airline": "全日空 ANA",
  "flight_number": "NH105",
  "departure": {
    "date": "2026-09-28", "time": "00:50",
    "airport": "洛杉矶国际机场 (LAX)", "iata": "LAX",
    "terminal": "B", "timezone": "America/Los_Angeles"
  },
  "arrival": {
    "date": "2026-09-29", "time": "05:00",
    "airport": "东京羽田国际机场 (HND)", "iata": "HND",
    "terminal": "3", "timezone": "Asia/Tokyo"
  },
  "gate": "", "registration": "", "seat": "22A",
  "aircraft_type": "787-9", "notes": ""
}
```

两端FlightStop还支持可选numeric `utc_offset_minutes`，表示当地UTC偏移分钟、东为正。洛杉矶2026-11-01 01:30必须选择-420（第一次）或-480（第二次）；只有唯一候选的时间不需要添加该字段。日期/时间/时区变化清除旧选择；偏移属于航段semantic signature，改变后递增版本并失效旧预览。字段存在原JSON内，无额外数据库列。服务端拒绝字符串、无候选/错误偏移和未选择的歧义时刻。

Rail：system_type为china_hsr/japan_shinkansen/germany_db/taiwan_hsr/other；custom_system选填；train_number；departure/arrival包含date/time/station；seat_carriage/notes选填。

Metro：origin/destination；estimated_departure_time、estimated_arrival_time、route_description、notes选填。具体接口类型完整保存在领域参考，不更名snake_case字段。

### 4.2 全天与酒店

schedule_details 可选（旧客户端没有此键），JSONB nullable，只用于旅程内顶层trip且transport_type为空：

```json
{
  "kind": "hotel",
  "start_date": "2026-10-01",
  "end_date": "2026-10-03",
  "check_in_time": "15:00",
  "check_out_time": "11:00",
  "booking_reference": "OPTIONAL-REFERENCE"
}
```

kind=all_day 时日期可相等，两端包含；hotel退房>入住，过夜不含退房日。SQL将日期cast为DATE检查真实性/顺序；标题、地址、备注仍在records通用字段。一条记录投影多天，不增加day_number列或酒店每日子记录。

### 4.3 实际航班

actual_match_status 非空默认never，六值 never/eligible/matching/matched/not_found/failed；actual_info JSONB object nullable；actual_info_matched bool false；actual_matched_at / provider / request_id nullable；request_id UUID有唯一索引（非NULL）。

actual_info 与原交通计划分开，含status/airline/flight_number/departure/arrival/aircraft_type/registration/source/matched_at。两端每个scheduled/estimated/actual都是 `{iso:string|null,date:string,time:string}`，另含airport/iata/timezone/delay_minutes/terminal/gate。日期字符串和ISO偏移按供应商原值保留，不能把raw ISO截断后重新当旅程时区。

新增flight_plan_version bigint默认0（航班创建为1）、actual_match_plan_version nullable、actual_confirmed_request_id nullableUUID。触发器在航段语义改变时递增并清有效标记/请求，历史actual_info保留但不用于新航段。座位/登机口/备注不递增；authenticated/CAS不能伪造实际元数据。旧匹配只有两端排定时间/时区/号码/机场完全一致且有可信请求标识才迁入有效版本。

## 5. 服务端表与安全

| 表 | 核心字段与唯一性 |
| --- | --- |
| api_entitlements | user_id PK；tier standard/friend/owner；source default/invite/owner_bootstrap/admin；granted_at、revoked_at、updated_at |
| invite_codes | idUUID；code_hash64hex唯一；label、active、max_redemptions nullable、redeemed_count>=0、expires_at |
| invite_redemptions | idUUID；invite_code_idFK；user_id唯一；redeemed_at |
| invite_attempts | bigint identity；user_id、succeeded、attempted_at；user/time索引 |
| demo_sessions | idUUID；token_hash64hex唯一；device_hash唯一32–128hex；expires_at、last_seen_at、created_at |
| api_quota_policies | policy_keyPK；service aviation/deepseek；quota_group；tier；period_type day/month/rolling；positive limit_value；soft_limit |
| api_quota_buckets | bucket_keyPK；service/group；period_start/end；positive limit_value；used_value>=0；updated_at |
| api_usage_events | idUUID；request_idUUID唯一；user_id XOR demo_session_id；service/group/feature/tier；status reserved/completed/upstream_error/not_found/failed；counted默认true；response_meta；created/completed |
| api_cooldowns | principal_keyPK；reason；until_at；created/updated |
| flight_match_previews | request_idPK；record_id/user_idFK；plan_version非空；actual_info object；expires_at默认+30min；(record_id,request_id)唯一 |
| trip_recaps | idUUID；user_id/trip_id组合唯一；content；source_snapshot_hash；generated/updated |
| daily_summaries | idUUID；user_id/context_key组合唯一；summary_date报告锚；context_key旧数据按各旧上海日期隔离、新数据64hex；content；generated_at |
| client_mutation_receipts | (user_id,request_id)PK；request_body/response_body JSONB；created_at；浏览器不可直接读写 |
| owner_entitlement_audit | bigintidentity；actor_user_id/target_user_id；old_tier；new_tier仅standard/friend；created_at |

普通浏览器对服务端专用表无 SELECT/INSERT/UPDATE/DELETE。trip_recaps/daily_summaries仅本人SELECT。changelogs所有authenticated可读但不可写。用户业务表auth.uid()=user_id CRUD，anon无表访问权限。Owner不是PostgreSQL超级用户：仍不能通过浏览器直接读别人记录。

Service-role RPC：

- redeem_friend_invite(user_id,code_hash)：五次失败/小时后拒绝；检查active/有效期/余兑换数；锁邀请码行；记录attempt/redemption；授friend，保留owner。
- consume_api_quota(user_id,demo_session_id,feature,request_id)：真实/演示身份必须恰好一个；查tier；分服务组；防重、频率、桶检查、预留、usage日志。
- complete_api_usage(request_id,status,response_meta)：完成日志，不退额度。
- claim_flight_match(user_id,record_id,request_id,rematch=false)：同用户航班锁；已有matched缓存；matching两分钟内拒并发。
- finish_flight_match(user_id,record_id,request_id,status,actual_info=null)：只对当前claim的request写matched/not_found/failed；保留计划。
- claim_flight_match_v2(user_id,record_id,request_id,plan_version,rematch=false)：锁本人行核对version，缓存仅返回已确认UUID；阻止同航段并发。
- stage_flight_match_v2(user_id,record_id,request_id,plan_version,actual_info)：行锁复核当前claim与version，存30分钟有效预览。
- confirm_flight_match_v2(user_id,record_id,request_id,plan_version,actual_info=null)：行锁再次核对，消费预览或服务端验签后的恢复内容；重复确认幂等，不把active请求误作confirmed结果。
- store_ai_result(user_id,request_id,feature,content,generated_at,trip_id?,summary_date?,context_key?,snapshot_hash?,response_meta?)：预留usage本人/功能一致、缓存较新者优先、缓存+usage事务提交；上海日期不是summary缓存身份。
- owner_set_user_tier(actor,target,newtier)：服务端再查actorOwner；只允许standard/friend；Owner目标锁定；变更写审计。

上述服务RPC固定search_path并revoke public/anon/authenticated EXECUTE，仅service_role调用。旧finish的matched分支只消费已验证数据库preview，忽略传入actual_info；旧无version预览必须证明同owner/current claim/完全相同排定航段才能由触发器绑定版本。纯辅助`flight_iso_offset_minutes(text)`、`flight_local_utc_offsets(date,time,timezone)`和`flight_stop_offset_proved(plan,actual)`不读表或身份，只验证时间/偏移；旧claim在上游之前拒绝无候选、错误偏移或未选重复clock。claim/stage/confirm也拒绝cancelled，不因完成状态的正常切换丢弃原计划。

另外`save_user_mutation(p_table,p_payload,p_expected_updated_at,p_request_id)`是供authenticated调用的SECURITY DEFINER RPC，固定public/pg_temp路径；anon/public不可执行。内部用auth.uid()、严格表/字段白名单、owner一致检查，不能自授角色或伪造航班元数据。新建expected=NULL只允许不存在行，更新比较完整updated_at；冲突返回`{ok:false,code:"CONFLICT"}`，成功返回`{ok:true,row}`。按用户/request保存请求体及结果收据，重试同请求幂等；同UUID不同body报22023；请求锁与实体锁、收据/更新同事务。直接业务CRUD的旧RLS未关闭，CAS保护仅新协议路径，旧PWA应刷新升级。

consume目前数字写在RPC；api_quota_policies是描述表，**只改表内数字不会改变执行上限**。改额度需同时改RPC、get-api-quota显示、登录文案、测试及文档。收据/usage/preview的清理政策尚未自动化；管理者需先定审计保留周期，不擅自删除未确认副本对应数据。

## 6. 初始化新 Owner 和邀请码

先用 OTP 建立并验证自己的 Auth 用户，从 Dashboard Authentication Users 获取 UUID。管理员确认身份后在测试/目标项目 SQL Editor执行以下模板；不要让用户浏览器提交任意UUID到此SQL。

```sql
insert into public.api_entitlements (user_id, tier, source, revoked_at)
values ('REPLACE_WITH_VERIFIED_OWNER_UUID'::uuid, 'owner', 'owner_bootstrap', null)
on conflict (user_id) do update
set tier='owner', source='owner_bootstrap', revoked_at=null, updated_at=now();
```

新邀请码先在受控本地程序按“trim→大写→去所有空白→SHA256 UTF8”生成哈希，再用参数化管理工具插入：

```sql
insert into public.invite_codes (code_hash,label,active,max_redemptions)
values ('REPLACE_WITH_64_HEX_SHA256', 'trusted friends', true, 100);
```

实际明文只经可信私聊分发，不进入README、前端、日志或公开仓库。重建时停用历史seed；禁用邀请码不自动撤回已授Friend，需Owner后台或受控SQL调整用户等级。

## 7. Storage

avatars：public=true，最大2097152字节，image/jpeg/png/webp。前端裁剪为方形WEBP，路径userUUID/avatar.webp、upsert=true；SELECT/INSERT/UPDATE/DELETE策略限自己目录。公开下载URL并不被此SELECT策略变成私密；URL带版本参数避免旧头像缓存。

record-images：private，最大10485760字节，jpeg/png/webp/heic；路径首层userUUID，四类策略只本人。当前前端没有通用照片上传功能。未来需要短期签名URL，不能getPublicUrl当私密读取。

数据库备份只含Storage元数据，不含对象字节；备份/迁移必须另外导出两个bucket文件及路径清单。

## 8. 数据恢复注意

空库重建使用迁移；已有完整schema/data恢复不可再盲跑全部迁移。Auth用户UUID、业务FK、用户trigger和Storage策略需一起恢复/核对。schema.sql/数据不会恢复SMTP密码、EdgeSecrets、项目URL/keys、DNS或用户本地待同步操作。

服务端敏感表需数据库管理员检查；不能为了方便前端额度显示给authenticated放开全部usage事件。测试RLS用两真实用户JWT，不用service_role测试得出“用户隔离成功”结论。
