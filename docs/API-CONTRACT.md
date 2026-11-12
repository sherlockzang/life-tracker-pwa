# API 合同与配额矩阵

初稿：2026-10-01；修复候选校核：2026-10-02。完整可还原的 Edge 实现与邮件模板在 [后端参考](reference/EDGE-REFERENCE.md)。

## 1. 通用协议

基础路径 `https://YOUR_PROJECT_REF.supabase.co/functions/v1/`。POST application/json；OPTIONS预检；其他方法拒绝405。真实用户传当前Supabase access token作为Bearer；通过supabase.functions.invoke调用。浏览器 publishable key不是JWT身份，不能当Owner凭据。

成功包络 `{data:...,requestId:edgeUUID}`；失败 `{error:{code,message,...extra},requestId:edgeUUID}`。body.requestId是业务幂等UUID，与包络用于排错的Edge请求UUID不同。

共享模块限制Origin为生产https://sherlockzang.github.io及localhost/127.0.0.1:3000；域名迁移或4173后端预览必须显式添加。缺Origin的非浏览器请求仍要身份验证；CORS不是防滥用认证。

| 端点 | gateway verify_jwt | 应用内验证 |
| --- | --- | --- |
| start-demo-session | false | 无用户JWT，签发受限demo令牌 |
| deepseek-assist | false | demoSessionToken查哈希或真实JWT getUser；不能免鉴权 |
| lookup-flight | true | 再查真实JWT；record必须本人 |
| query-transit-route | true | 转发到deepseek-assist |
| redeem-invite | true | 真实JWT；限本人兑换 |
| get-api-quota | true | 真实JWT；返回本人可见额度 |
| owner-admin | true | 真实JWT + 有效Owner，再由SQL复核 |

部署时按新Supabase项目的JWT签名/网关兼容做测试，禁止仅为解决401把全部函数公开而删掉应用内验证。

## 2. start-demo-session

请求：`{deviceHash:"32到128位hex"}`，JSON上限2000 bytes。客户端首次生成设备seedUUID，用SHA256作为deviceHash；seed持久在本地。

响应：`{data:{token:"随机UUID.随机UUID",expiresAt:"ISO"},requestId}`。服务器储存token_hash、稳定demo session ID，每次进入轮换令牌并延长7日。客户端存令牌/有效期。

deviceHash来自客户端，可以被清缓存/改值绕过“每设备”；不是硬身份防线，全球demo每日100次和非Owner轻量月池继续保护。并发创建/轮换和多窗口会话需独立测试。

## 3. deepseek-assist

JSON上限70000 bytes（含最长64000字符的恢复凭据）。通用：
```json
{"action":"route","requestId":"VALID_UUID","query":"从UCSB去LAX怎么走","demoSessionToken":"ONLY_FOR_DEMO"}
```

| action | 输入 | result类型 / 行为 |
| --- | --- | --- |
| route | query≤500；或origin/destination各≤120、departureTime≤80 | 中文路线string≤320；不确定时询问位置 |
| expense_parse | text非空且≤200字符 | {amount:number\|null,currency:string\|null,category:六类\|null,merchant:string\|null,note:string\|null} |
| note_polish | text≤200字符 | string≤260代码点；保留事实 |
| trip_recap | tripId UUID、regenerate?:boolean | string；本人旅程满足结束条件；服务端聚合；缓存复用 |
| daily_summary | clientContext?:string，仅前端本地副本定位；后端不信任它 | string；后端按各活跃旅程当地日投影；无计划skipped:true；按上下文缓存 |

route两条路径均由服务端接受：单独非空query，或完整非空origin+destination（query可省略，由服务端生成查询）；也可三项一起传。只给一个端点、三项皆空、超长内容/出发时间在预留前400。当前网页使用双输入出发地/目的地，不是单句输入UI。expense_parse的模型内层JSON必须是非null非数组对象，否则502 AI_INVALID_OUTPUT，不保存为空的成功记录；正常对象再逐字段规范化，无法确定字段可为null。

真实账号可传`expectedOwner:UUID`作为账号切换防线；它不授身份，服务端仍以JWT为准，不一致409且不预留额度。成功`data:{action,cached?,result,generatedAt?,skipped?,persisted?,warning?,recoveryToken?,contextKey?}`；缓存优先返回不再预留。所有AI回填由用户决定。演示回顾为预置/模拟，不调用模型；演示今日摘要不调用；轻量动作可调用真实DeepSeek。

上游 POST https://api.deepseek.com/chat/completions，key来自DEEPSEEK_API_KEY；V2.1 本地候选 model 为 deepseek-flash（V4.1 Flash），thinking disabled，stream false；temperature recap0.5/其余0.2，max_tokens450/150/200/800/300；解析消费启用JSON格式并二次验证。线上配置需以实际部署版本为准。服务端24s硬超时覆盖响应头和JSON body读取，不在拿到响应头后撤销deadline；忽略abort的mock传输也会结算超时。无效JSON或null/原始值等错误包络返回既有不可用错误，不直接TypeError。网络错误进入日志前只保留通用消息，不附秘密URL或Authorization。模型可用性需供应商确认，文档不是对未来型号的保证。

服务端recap读取本人records与trip，不信任客户端聚合。分类按币种分别合计，不混加或猜换汇。缓存唯一user/trip，显式重新生成才消耗；snapshotHash记录来源，当前不自动判定回顾缓存过期。每日摘要contextKey由服务端活跃trip的id/当地日期/timezone排序后SHA256生成，唯一user/context；summary_date仅为上海报告锚。上海午夜而旅程当地日未变不重新生成。新增/修改当天计划不会自动invalidate已经生成的同上下文摘要，属于快照而非实时规划。

所有用于完整状态/聚合/计划投影的集合按不可变id游标分页到空页；任一页失败为DATA_UNAVAILABLE且不预留/不调用上游。分页是逐请求读取，不是数据库事务快照；并发新写入在后续刷新收敛。

缓存读取失败会在上游前停止。生成后缓存/用量提交失败仍返回内容及`persisted:false`、中文warning、HMAC恢复凭据；前端保存到原账号本地副本，并阻止普通查看回顾/摘要时重复生成。缓存与usage完成由`store_ai_result`在一个事务提交，较旧恢复不会覆盖较新的缓存。

保存重试请求`{action:"retry_save",recoveryToken:"SIGNED_TOKEN"}`；只支持真实JWT并检查scope/user/action/目标/30分钟有效期，不走预留或DeepSeek。成功`data:{persisted:true,recoverySaved:true,newerPreserved?,result,...}`。凭据携带内容但不含密钥，并非加密文件；service-role仅服务端签名使用。过期副本仍可复制/导出，不能凭过期token写云端。

## 4. lookup-flight

### 匹配请求

```json
{"action":"match","recordId":"RECORD_UUID","requestId":"NEW_UUID","planVersion":1,"rematch":false}
```

JSON上限20000 bytes。只能匹配已保存的本人flight记录，实际资格以数据库plan为准。未匹配流程：本地资格→服务端资格→查当前version的preview→claim行锁→reserveQuota→航空请求→精确过滤→暂存preview→返回。已取消、非法日期/时区、DST不存在或未消歧时刻、错误UTC偏移、非正时长、缺可信IATA或未到查询窗口不会请求上游。重复当地时刻需两端分别提供numeric `utc_offset_minutes`；前端/Edge使用相同纯解析器，未选择不能消耗额度。

上游 https://api.aviationstack.com/v1/flights?flight_iata=NH105&limit=100，access_key只由服务端附加；不要在日志打印完整URL。没有请求历史/未来高级接口，不假设免费计划支持它们；服务器按出发当地日期和两个IATA过滤返回数组。

响应：
- 新结果：`data:{cached:false,preview:ActualFlightInfo,requestId:业务UUID,planVersion,recoveryToken?,expiresAt?,persisted?,warning?}`。
- 复用未确认预览：同上加staged:true，复用旧requestId。
- 已确认缓存：`data:{cached:true,actualInfo,matchedAt,requestId:已确认UUID,planVersion}`，不使用正在重匹配的active UUID替代。

### 确认请求

`{action:"confirm",recordId,requestId:预览业务UUID,planVersion,recoveryToken?}`。只能确认本人、同record、未过期且同航段version预览。响应`data:{confirmed:true,record:完整LifeRecord,usageLogPending?}`；不再消耗额度。行锁确认写实际信息并删预览，不覆盖计划/seat等用户字段。应直接采用返回的服务器记录，不能把service字段再次通过用户CAS回写。

航段语义变化递增version，旧预览/确认拒绝PLAN_CHANGED；座位、备注、登机口不改变version。上游14s硬超时包括响应头和body；超时清匹配状态、完成错误usage但不退款，也不写preview。未命中不修改原计划。stage或usage保存失败返回签名结果，confirm可只重试保存；前端本地预览按owner/record/version分区，29分钟有效，不因再次开页重复调用。正在匹配B时确认已确认A只返回A，不能误套B。

滚动升级兼容：旧客户端缺planVersion的match从本人数据库当前计划推导；旧confirm仅从同owner/record/request的存储预览版本或已确认UUID推导。绝不能把当前version赋给任意旧payload。显式传入陈旧version仍拒绝。SQL也提供旧Edge桥接，仅接受能证明当前航段的数据库预览；不信任旧finish传入的actual_info。

常见错误：INCOMPLETE_FLIGHT_PLAN、FLIGHT_NOT_COMPLETED、MATCH_WINDOW_EXPIRED、AMBIGUOUS_FLIGHT_TIME、INVALID_FLIGHT_OFFSET（400）；FLIGHT_CANCELLED、MATCH_IN_PROGRESS（409）；NO_EXACT_MATCH（404）；PREVIEW_EXPIRED（410）；API_NOT_CONFIGURED/API_UNAVAILABLE（503）；API_TIMEOUT（504）；配额429。未来/过窗口要引导手动填写，不展示不符合日期航班。对于重复时刻，上游排定ISO偏移也必须与已选计划候选一致才会自动匹配；实际信息缺少一致的偏移证明时只显示clock，不猜确定用时。

已取消计划在前端/Edge及新旧SQL claim入口拒绝，不预留或请求上游；stage/confirm也拒绝被取消的记录。若请求已发出后用户才取消，不能收回供应商调用，不自动退还已预留额度；恢复计划不自动重查。

上游data必须是数组；每项须为object并包含合法departure/arrival/flight和必要IATA/scheduled，坏项跳过以保留后面的有效精确匹配。非空列表全坏返回API_UNAVAILABLE，不把null项抛TypeError；合法列表无匹配为NO_EXACT_MATCH。已发供应商请求保持一次用量，不退款；错误路径完成usage并清claim，不保存preview。

## 5. redeem-invite / get-api-quota

redeem请求 `{code:"维护者提供的邀请码"}`，max2000bytes。服务器uppercase去空白SHA256→RPC。成功 `data:{tier:"friend"|"owner"}`；INVALID_INVITE400，TOO_MANY_ATTEMPTS429（五次失败/小时），服务错误503。Friend/Owner已授权兑换不降级。

get-api-quota请求空object；成功：
```json
{
  "data": {
    "tier":"owner", "timezone":"Asia/Shanghai", "cooldownUntil":null,
    "deepseekMonthTotal":0,
    "aviation":{
      "globalUsed":18,"globalLimit":100,"globalRemaining":82,
      "nonOwnerUsed":18,"nonOwnerLimit":80,"ownerUsed":0
    },
    "buckets":[{"bucket_key":"aviation:global:2026-10","used_value":18,"limit_value":100,"period_end":"ISO"}]
  },
  "requestId":"EDGE_UUID"
}
```

get-api-quota从已存桶与当前预期桶补零合成；Owner不显示个人AI200/回顾50旧限额。deepseekMonthTotal是全部账号计数，不是“非Owner轻量池已用”值。桶展示不会额外扣费。

entitlement、桶、cooldown或exact月计数读取失败均DATA_UNAVAILABLE/503，不返回伪造tier/余额；只有成功无行才补默认值。上海day/month重置时间按本地日历下一日/下月1日构造再转UTC，与数据库会话时区无关。已存period_end须随最新迁移修正，不能只改前端展示。

## 6. owner-admin

body≤4000bytes；仅有效Owner。

- list：`{action:"list",query:"邮箱关键字"}`→`data:{users:[{id,email,createdAt,lastSignInAt,tier,source,grantedAt,monthUsage:{aviation,deepseek}}]}`。当前只读取Auth第一页1000人并最多返回50人，不是无限分页后台。
- set_tier：`{action:"set_tier",targetUserId:"UUID",tier:"standard"|"friend"}`→`data:{ok:true,old_tier,new_tier}`。目标Owner锁定409，未知用户404，非Owner403。修改事务与audit绑定。

不接受tier:"owner"，不允许从产品后台新授Owner。不存在读取个人记录、删除账户、群发邮件或任意SQL功能。

## 7. query-transit-route

兼容V1.2旧端点，接受origin/destination/query/departureTime；内部强制actionroute并生成新requestUUID，返回deepseek-assist包络。同一轻量额度；不是另一份额外AI预算。新前端优先使用deepseek-assist。

## 8. 当前执行配额

所有日/月按Asia/Shanghai重置；航空上限受provider账户实际额度约束。本表以最后的V1.4.1 RPC为准，而非早期讨论或旧策略seed。

| 功能 | Demo | Standard | Friend | Owner |
| --- | --- | --- | --- | --- |
| 真实航空 | 不调用，仅模拟 | 2次/日 + 非Owner80次/月 + 全局100次/月 | 无个人日限 + 非Owner80/月 + 全局100/月 | 可用全局全部剩余，仍100/月 |
| 轻量AI（route/expense/note共用） | 2次/设备/日 + demo全体100/日 + 非Owner10000/月 | 15次/人/日 + 非Owner10000/月 | 无个人日限 + 非Owner10000/月 | 不设产品账号额度、不占非Owner池 |
| 旅行回顾 | 模拟 | 3次/人/月 | 10次/人/月 | 无产品账号额度 |
| 今日摘要 | 不请求 | 1次/人/日 | 无个人额度，缓存复用 | 无个人额度，缓存复用 |
| AI频率 | 60秒内已请求10次→第11次冷却5分钟 | 同左 | 同左 | 当前实现豁免 |
| 基础记录、手动规划 | 不受AI额度 | 不受AI额度 | 不受AI额度 | 不受AI额度 |

Owner“20保底”不是个人20上限：别人合计≤80且全局≤100，给Owner预留可支配空间。Owner先用较多后也会挤压非Owner可用总量；不会承诺别人一定能用80。例别人18、Owner7，全局25，Owner剩75而不是82。

**10000仅轻量组**，旅行回顾/摘要不计这个桶。若产品要求所有非OwnerAI合计10000，应另行改RPC与展示，不能只改文档。Owner不限额不是provider无额度/无限成本；外部余额、网络和模型限制仍存在。

新迁移将事务advisory lock提前到重复请求与频率读取之前，频率判定和桶预留共同串行化；所有原额度保持不变。已在临时真实PG18验证20并发、9次后并发、冷却隔离和Owner豁免；并非真实供应商或生产压力测试。

## 9. 错误与计数语义

先验证输入/权限/缓存，后预留再发上游。预留失败不请求。缓存确认不扣；主动重新匹配/重新生成扣。请求上游后not_found、timeout、upstream_error仍计数，因为provider可能已计费；禁止自动无限重试。

统一错误显示中文，Edge响应的error对象可带retryAt / resetAt给UI倒计时；retry_at / reset_at仅是SQL额度RPC内部字段名。不得把服务端503误译成“网络已离线”，不得直接显示秘密或数据库内部堆栈。SDK FunctionsHttpError需要读取response JSON获得业务code。

可观测性只记录requestId、feature、tier、结果状态、token统计与必要HTTP状态，避免完整记录文本、邮件OTP、JWT、秘密、完整航空URL。定期清理到期preview/demo和旧usage须先确认保留/审计政策，当前无自动清理任务。
