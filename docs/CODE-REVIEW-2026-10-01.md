# 全项目代码审查与交付门禁（首轮证据）

> 后续状态：本报告以下保留修复前的R01–R10证据和行号，**不描述最新代码仍然存在这些缺陷**。用户随后授权修复；最新实现、测试及未验证门禁见[修复验收](ACCEPTANCE-2026-10-01.md)，交独立模型时以[交接单](INDEPENDENT-REVIEW-HANDOFF.md)和当前工作树为对象。

日期：2026-10-01。对象：`v2.0.0-ui` 工作树的当前源码及未提交增量，HEAD为`a57a11060b855468cb240c807ccbbd10c1e47a62`；稳定回退基线`stable-before-v2.0.0`为V1.4.1。文档内SHA256快照描述工作树，不等于HEAD提交内容。

## 1. 结论

**文档和从零恢复演练已完成；网站尚不满足“没有问题即可交付”的条件。** 前端静态检查、构建与四组纯逻辑回归通过，但审查发现保存/同步可靠性、航班匹配失效和并发频率限制等缺陷。R01–R04建议作为下一次发布的阻断项，修复后必须重新验证；不能以UI冻结校验或编译通过代替这些验收。

本次只整理文档、加入文档检查/恢复工具、调整UI冻结工具排除Markdown；没有修改业务逻辑、推送main、部署网站/函数、执行生产迁移、修改角色或调用真实航空/AI接口。以下是待修清单，不是已经修好的更新说明。

优先级：P1=可能造成数据丢失/错误数据或保护失效，优先修；P2=功能结果不一致或降级不可靠，应计划修复；“静态推断”表示未在真实数据库/真机复现，不能夸大为生产已发生。

## 2. 主要发现

### R01 · P1：永久保存错误被吞掉，界面仍像已保存/已同步

位置：[data.ts](../src/lib/data.ts)114–119行；[App.tsx](../src/App.tsx)136–146、228行。

`upsertOrQueue`在Supabase返回任何error后都入outbox，包括RLS拒绝、字段不存在、数据约束等永久错误，随后正常resolve。App已经乐观更新本地快照，继续显示“已记下来”；顶部“已同步”只由网络状态决定，不由队列/服务器确认决定。

只读模拟：令`navigator.onLine=true`，mock upsert返回`{error:{code:"42501",message:"RLS denied"}}`。`persistRecord`正常结束并调用queueMutation，没有将永久失败交给UI。此验证没有向生产数据库发送请求。

影响：用户误以为云端安全保存，之后清理设备/重装PWA可能丢掉仍在本地的记录；V2新列未部署时也会出现同类误导。

修复合同：区分可重试网络故障与永久业务错误；保存结果返回`confirmed/pending/failed`；展示待同步数量和失败原因；永久失败保留草稿/本地副本，不能直接宣称成功或无限重试。显示“已同步”必须满足当前账号队列为空且成功确认，而不是仅有网络。

回归：在线RLS/约束/缺列错误、离线后恢复、服务器500、请求超时、缓存写失败；每种状态都有正确提示，清缓存前可辨别未上传内容。

### R02 · P1：离线队列没有按账号分区，旧账号失败阻塞新账号

位置：[offline.ts](../src/lib/offline.ts)15–20、51–62行；[data.ts](../src/lib/data.ts)122–133行。

快照按userId隔离，但PendingMutation没有独立owner索引，`listMutations`列出整库操作，`syncOutbox`不接受当前userId，遇到首个error就break。

只读模拟：队列先放账号A待传记录，再放账号B待传记录；以B认证回放，A被RLS拒绝后立即退出，B从未尝试。RLS仍阻止写他人数据，本发现不是“B能读A云端记录”的证明，而是共享设备同步停滞问题。

另有冲突风险：队列存整行upsert，没有服务器版本条件；旧离线副本可能覆盖另一设备新修改，包括航班实际信息。未运行真实双设备冲突测试，不能保证当前同步安全。

修复合同：操作有ownerId且按当前认证用户过滤；切换/退出停止旧会话回放；拒绝缺少可信owner的旧队列项目，保留隔离副本；失败项目不要卡住其他合法项目。增加patch及预期版本/updated_at检查，冲突可恢复，不能静默覆盖。

回归：A离线保存→切B在线保存→B能同步、A内容不交给B；切回A能继续；两个设备并发编辑有冲突提示；队首永久错误不阻塞后续合法操作。

### R03 · P1：编辑航段后仍复用旧实际信息和旧预览

位置：[TransportPlanEditor.tsx](../src/components/TransportPlanEditor.tsx)99–100行；[flightDisplay.ts](../src/lib/flightDisplay.ts)26–40行；[lookup-flight](../supabase/functions/lookup-flight/index.ts)131–149行；[finish_flight_match SQL](../supabase/migrations/20260714060000_release_1_3_0_security_and_ai.sql)432–455行。

编辑计划采用`{...record, ...新计划}`，未清理actual匹配标记/内容。派生展示优先旧actual数据；后端也在校验新计划之前返回matched缓存。未确认preview只绑定record/request/user/有效期，确认RPC检查requestId，却没有比较航段快照；相同记录的号码/日期/机场修改后，旧结果仍可能被确认。

只读复现：计划改为`NH999 / 2026-10-01`，保留`actual_info_matched=true`和旧`NH105 / 2026-09-28`；调用flightDisplay仍得到旧号码/日期。编辑缓存问题源自现有保存流程；V2优先实际信息的展示使影响更直接，不应误称为纯视觉问题。

修复合同：对航班号、两端机场、当地日期/时刻/时区建立语义snapshotHash或版本；航段修改清理/标旧matched缓存和preview，备注/座位修改不失效。服务端确认事务锁定记录并校验同一snapshotHash，陈旧结果返回明确409；RPC不得只信任前端清标记。新查询请求与锁也要绑定版本。

回归：修改号码、机场、跨日时间后旧结果不覆盖；仅座位/备注修改仍保留匹配；查询期间另一窗口改计划，旧预览确认失败；重新查询只由用户主动操作，不因失效自动浪费航空额度。

### R04 · P1：AI的10次/分钟频率检查在事务锁之前

位置：[V1.4.1 quota SQL](../supabase/migrations/20260715000000_release_1_4_1_owner_admin_and_quota.sql)186–199、254–277行。

冷却检查、近60秒计数在advisory lock之前，配额桶检查和usage插入在锁之后。并发事务都可能先读到相同旧计数，再依次获得桶锁并通过，因此Friend等账号能够超过约定频率，直到下一次请求才触发冷却。

这是代码顺序和PostgreSQL并发模型的静态结论，本次没有数据库运行时并发测试。**全局100航空/非Owner80/轻量10000等桶仍在锁内，不能把此问题描述成月额度池可无限绕过。** Owner当前按产品策略豁免频率，本项针对非Owner。

修复合同：在读取cooldown、计数及插入usage之前获取principal事务锁，或将整个判定置于现有串行区域；锁顺序一致以免死锁。并发重放同requestId仍须唯一、不能重复扣桶。

回归：非Owner同秒20个请求，最多允许10个，余者429和统一约5分钟retryAt；已有9个时并发只增1个；不同用户不误触对方冷却；月桶满/重复UUID/Owner豁免也测试。必须在可丢弃测试库执行，不拿生产额度做压力测试。

### R05 · P2：旅行回顾分类金额混合不同币种

位置：[deepseek-assist](../supabase/functions/deepseek-assist/index.ts)89–110行。

expenseTotals按currency分开，但categoryTotals只按类别相加，不标币种。只读运行同一聚合算法，`餐饮1 USD + 餐饮100 JPY`得到餐饮101；模型无法可靠推断其含义，可能错误判断类别消费占比。前端图表已换算并不意味着服务端摘要也换算。

修复合同：分类按币种分别汇总，或者使用明确主币种和可靠汇率快照计算，记录未换算项；提示词不得自行猜汇率。回归混币、缺汇率和空金额，结果能追溯原始币种。

### R06 · P2：“今天”定义不一致，全天/酒店摘要缺失

位置：[App.tsx](../src/App.tsx)195–210行；[deepseek-assist](../supabase/functions/deepseek-assist/index.ts)116–136行；[ExpenseStats.tsx](../src/components/ExpenseStats.tsx)46行。

- 当前旅程用UTC日期选，Day用设备午夜算，摘要后端用上海今天，而计划归属另用旅程时区。UTC/上海/洛杉矶在午夜前后可落在不同日。
- dailyPrompt查询未选schedule_details，只用event_at/起飞日期筛选；酒店续住日、跨日全天、前日出发首日落地的航班不与V2按日投影视图保持一致。
- 消费日桶截ISO前10字符，按UTC分日，可能与用户当地记录日期不同。

以上为静态路径分析，未做真实跨时区午夜端到端验收。修复应定义“展示今天/旅程Day/摘要日期”的各自日历并共用日期投影；配额重置继续上海，不必强行把业务日也改上海。回归同一时刻在上海/东京/洛杉矶、DST、连住日及入境航班。酒店摘要未扩展已在原UI验收中披露。

### R07 · P2：时间线日期组并未保证倒序（原有遗留）

位置：[Timeline.tsx](../src/components/Timeline.tsx)26–42、51行。

先按event_at倒序，再用机场当地日期/设备日期/全天起始日建组，最后按对象插入顺序渲染。日期键未独立排序，因此可见30→28→29。

只读提取localDateKey并用UTC已排序、显示日期分别为09/30、09/28、09/29的三条记录分组，结果键顺序就是30→28→29。先前已经同数据比较稳定tag和V2，均有此问题，**不是本次UI改版新回归**；原约定留V2.0.1，仍需明确记录，不能宣称首页排序已全面正确。

修复合同：定义同一展示日历，日期组显式倒序，组内按相同时间规则排序；或明确记录在各自当地日归组但仍对日期键排序。航班卡片显示当地时间不能改变event_at来迎合分组。回归同日不同添加顺序、跨日期变更线及全天记录。

### R08 · P2：AI/航班预览缓存和usage完成写入未检查错误

位置：[deepseek-assist](../supabase/functions/deepseek-assist/index.ts)237–242行；[lookup-flight](../supabase/functions/lookup-flight/index.ts)198行；[共享API](../supabase/functions/_shared/api.ts)98–100行。

缓存upsert/complete_api_usage的返回error未检查，函数可能正常返回结果，但回顾/摘要未持久保存，或航空preview无法再确认。下一次重新生成/匹配又可能调用上游并计数；不能据此承诺“只生成一次始终可查看”。

静态发现，本次未故障注入真实Edge/DB。修复需区分上游成功与结果持久化失败，保存失败不冒充已缓存，允许重试持久化而非重复生成；日志失败可观测。已产生的上游请求不要盲目退款。回归DB写拒绝、超时、重复确认、usage完成失败。

### R09 · P2：未收录机场无法完整手动保存飞机模板

位置：[TransportPlanEditor.tsx](../src/components/TransportPlanEditor.tsx)91、169–176行。

自由输入会清IATA，保存强制两端IATA非空；所以“查询不可用仍可手填”的降级实际仅对字典已覆盖机场成立。文档已改正这一能力描述，未把机场补全当作全球机场覆盖。

修复目标：可信名字/时区足以保存手动计划，自动匹配另验IATA；可选择明确手动模式或新增机场输入。未收录时不可引导用户选不相符机场。回归未知机场、字典机场名称改动、非法IATA以及手动模式不调用航空。

### R10 · P2：离线窗口恢复焦点会被标成在线

位置：[App.tsx](../src/App.tsx)102–112行。

focus复用onOnline，直接setOnline(true)，不检查navigator.onLine。即使syncOutbox因离线返回0，顶部仍可能显示“已同步”，后续保存提示也受误导。静态发现，与R01应一并修。

回归飞行模式→切后台→切回PWA，保持离线标识；网络可用但后端不可达应显示待同步/服务错误，而非成功。

## 3. 需求差异与运营限制

这些不是隐含已实现的功能，也不得让未来AI仅按旧讨论自动上线：

- 当前非Owner10000/月只约束轻量route/expense_parse/note_polish，recap/summary不计这个共享桶。早期“所有非Owner DeepSeek共享总池”的表述若仍是要求，需要明确后端调整；当前规则已准确写入API矩阵，未偷偷改限额。
- Demo设备标识由客户端产生，清缓存/伪造seed可以换身份；每日2次是体验限制，不是不可绕过的实体设备限制，仍有demo全体100/日池。
- Owner后台只读Auth第一页1000人、返回最多50人，暂无完整分页；不应承诺无限用户管理。
- 邀请码只授Friend，Owner受控绑定Auth UUID；前端Owner标签不构成授权。公开头像不等于私密记录，service-role管理员技术上能访问数据。
- 旧头像RLS报错不能仅凭源码断定生产策略已修复；V1.4.1源码有读取/写入策略，仍需检查生产迁移及本人上传路径。没有真账号上传测试，不宣布解决。
- PWA模板、安装图标与安全区域代码保留；iPhone17Pro真机、键盘弹出、OTP真实收发未重新验收。没有Passkey、邮件日程提醒、完整导出或通用照片记录功能。

## 4. 已完成的验证

| 检查 | 结果 / 所证明的内容 |
| --- | --- |
| 当前工作树npm run lint | 通过，前端静态规则 |
| 当前工作树npm run build | 通过，包含tsc与Vite/PWA生产构建 |
| test-airlines | 通过，114航司、别名、含数字代码、前导零和号码补全 |
| test-flight-duration | 通过，两地时区/DST/跨日及无效输入的纯时长算法 |
| test-flight-trip-placement | 通过，区间归属、首日入境及日期平移 |
| test-schedules-and-flight-display | 通过，全天/酒店投影、换店/冲突、实际字段降级 |
| verify-ui-contract | 通过，51个冻结文件；排除的是文档，不是后端代码 |
| git diff --check | 通过，未观察到diff空白错误 |
| 8个Edge TypeScript文件语法解析 | 0个parseDiagnostics；**不是Deno类型检查或运行时测试** |
| Markdown源码/图标SHA256 | 93个逐文件一致，包括完整锁文件和PNG |
| 空目录恢复 | 从Markdown恢复93文件到独立/tmp目录，没有复用Git或源码链接 |
| 恢复副本npm ci/lint/build及四组测试 | 全部通过，证明依赖锁与文档源码可恢复构建 |
| 只读问题复现 | R01永久错误、R02队列阻塞、R03旧实际展示、R05混币、R07组顺序得到报告所述结果；不是修复通过 |

恢复演练先尝试离线npm缓存，缺少一个包导致ENOTCACHED，之后获准下载公开锁定依赖并成功；这是首次缓存不足，不是恢复代码失败。无生产配置秘密参与。没有云端后端时，完整网页功能不是靠静态构建自动可用；必须按部署文档重建Auth/SQL/Storage/Edge/SMTP。

本次终端实际运行Node26.3.1；文档建议的Node22.13+是项目运行要求/推荐，不表示本次额外在Node22重复测试。文档检查通过15份Markdown、71个本地链接及93份逐文件快照；对快照另做私钥格式检查，识别并排除.env.example中的示例占位符，没有发现匹配的实际私钥格式。此检查不等于完整秘密泄漏审计。

主包仍有大于500KB的Vite提示，未调高阈值隐藏。构建成功不证明移动网性能良好；未来可在保持功能前提下分块，但不作为本次文档任务的代码变更。

## 5. 依赖安全审查

2026-10-01对锁文件恢复副本执行只读npm audit，没有运行audit fix或修改依赖：

- `npm audit --omit=dev`：0告警。
- 完整audit：9个受影响包，7 high、1 moderate、1 low、0 critical；均在本次omit=dev检查之外的开发依赖树。

| 包 | audit最高级别 |
| --- | --- |
| @babel/core | low |
| baseline-browser-mapping | moderate |
| brace-expansion | high |
| browserslist | high |
| fast-uri | high |
| js-yaml | high |
| nanoid | high |
| postcss | high |
| vite | high |

告警数量按受影响包计，不是独立CVE数；生产依赖0告警也不是整个系统安全证明，远程Deno依赖/云服务/运行时不在npm audit覆盖范围。开发/CI工具会处理文件和网络，不能因为dev标记而全部忽略。

例如当前Vite8.0.13落在官方某开发服务器公告影响范围，但该公告另有Windows/NTFS且显式暴露dev server的前提；本次Mac本地环境不满足该特定Windows前提，GitHub Pages静态站也不是Vite服务器，不能据此声称生产网站已被利用。[Vite官方安全公告](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)。PostCSS也有构建工具告警，需按处理输入和版本检查实际影响。[PostCSS官方安全公告](https://github.com/postcss/postcss/security/advisories/GHSA-r28c-9q8g-f849)。

交付前建议单独授权依赖维护：更新直接/传递依赖、审查锁diff、重新跑全部测试和构建，不使用`npm audit fix --force`跳过破坏性升级审查。工具漏洞适用条件由安全公告及部署方式决定；本报告只记录当前audit结果，不替代安全评估。

## 6. 尚未验证及发布门禁

当前环境没有Deno/Supabase CLI/Docker，因此未执行SQL初始化、数据库并发测试、Deno运行时/类型检查。没有修改真实Auth/Storage/RLS，未执行生产灾备导出，未检查线上函数版本与迁移历史。文档是灾备操作说明，不是你的云端数据已经备份的证明。

正式交付网站前至少需要：

1. 修R01–R04及其回归；明确R05–R10的修复/延期决定，不能把延期写成验收通过。
2. 处理开发依赖安全告警，或记录具体适用条件和维护者接受的残余风险。
3. 在测试Supabase完整执行12个基线迁移和新增修复迁移，验证旧记录、新schedule列、跨用户RLS、Storage路径和Owner RPC。
4. 测试两真实账号、Friend/Owner、撤回权限、邀请码、并发配额和缓存；通过mock上游验证费用保护，不耗生产100次航空池。
5. SMTP真实6位码新用户/旧用户收发及PWA内登录；两窗口隔离与前台恢复；iPhone17Pro安全区域、键盘和离线重启。
6. 导出并异地保存源码、Auth/数据库和Storage备份；在测试项目恢复角色/记录/头像、核对数量及权限。
7. 用户批准发布后才提交/部署，并核对Pages资源、函数版本、迁移状态；保留稳定回滚基线，按兼容回滚文档执行。

## 7. 给未来AI的审查要求

先读[重建规范](REBUILD-SPEC.md)、[架构](ARCHITECTURE.md)、[数据库](DATABASE.md)、[API](API-CONTRACT.md)和[部署回滚](DEPLOYMENT-ROLLBACK.md)。参考快照用于恢复实物，审查报告用于避免复制错误。

修复后在本报告追加日期、测试、源码版本和结论；不得删掉失败证据伪装首次就成功。涉及旧RPC应新增迁移，不改已上线迁移历史；更新受影响Markdown快照/SHA256、恢复测试和用户指南。未经维护者授权，不改生产身份、密钥或额度，不部署半成品。
