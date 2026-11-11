# V2.0.0 自我审计问题修复与复验

日期：2026-10-02。对象：v2.0.0-ui候选工作树（不是仅HEAD）。本轮按维护者“结合自我审计再次修正”授权实现五项修复；未推送、发布或操作生产。原有R01–R10及F01–F07保留，没有重新实现已正确的功能。

收尾与交付：2026-10-03；文件名保持自审发现日期。从五份Markdown恢复到全新目录、离线安装532个锁定依赖，lint/build及11组测试全部通过。恢复目录无Git历史，不伪造UI基线；原工作树合同通过。最新包名life-tracker-independent-review-2026-10-03-selfauditfix.zip，准确SHA与逐字节核验见包外交付清单。

## 1. 证据与版本区别

自审原报告在外部交付目录self-audit-2026-10-02/SELF-AUDIT-REPORT.md，历史包life-tracker-self-audit-2026-10-02.zip，SHA256：

`bdf161b2c91d4de2d15c82bd6a946cb65b89bee59f346e987ef0b9a1e6aa7e57`

原报告审查的源码是life-tracker-independent-review-2026-10-02-auditfix.zip，SHA256：

`b0d23cdc43cf4f7c46d4f535b82ee42fb073c80075fc48d00e12bea2b6c1e49f`

两个历史包保持不变，作为缺陷基线。原自审脚本是“断言缺陷仍可复现”，退出0不能当作产品通过。本轮scripts/test-self-audit-*转成修复后正向断言，当前源码包另命名selfauditfix，准确SHA在包外交付清单；不要用旧包复审新修复。

## 2. 五项修复

| 编号 / 级别 | 确认的问题 | 修复及不变边界 |
| --- | --- | --- |
| SA-01 / P2 | 提交成功但响应丢失，再编辑会合并删除原UUID，造成自身CAS假冲突 | outbox领取即标attempted；只合并明确未发送且无人依赖的项。已尝试项与v2未知项保留UUID，原收据重放后重基后继。不能用新的UUID盲写绕过真实冲突。 |
| SA-02 / P2 | 修正失败草稿已成功，刷新却把旧失败内容覆盖新缓存 | 新修正继承失败项的原云端CAS，不用本地编辑时间作版本。成功事务才标旧失败supersededBy；历史可导出，不叠加、不领取、不计待处理、不与修正抢重试。修正失败及真实外部冲突仍保留，不自动删除。 |
| SA-03 / P1 | 首页设备日期传入行程时区编辑器，未改时间也移一天 | Timeline给编辑器传旅程时区日期。主页显示分组策略不变，日期/时间在编辑器同一业务时区解释，保留绝对时刻。 |
| SA-04 / P2 | 通用日程不存在的夏令时时间被静默归一化 | 非航班event_at共用严格时间解析：跳时拒绝，重复新时刻必选第一次/第二次及UTC偏移，已有事件保留次序和秒。高铁出发、市内交通、跨日拖动同样遵守；拖动歧义先编辑，原记录不提交。全天/酒店新代表锚取当地中午，起始日未变保留旧锚，业务仍按date-only展示。 |
| SA-05 / P2 | 摘要失败每30秒重复请求，可能持续消耗调用 | IndexedDB读写事务原子领取owner/context，跨刷新持久、同origin窗口只领取一次。失败/未知结果也不自动重试，切账号前复核；设置的显式手动生成仍可用，首页提示入口。超过30天的旧标记在新领取时清理。 |

本轮变更主要在offline/data/App、Timeline/TransportPlanEditor/Planner/SyncStatusDialog、tripDates及三份新增测试。数据库SQL、Edge代码、Owner/邀请码/Auth流程、航空和AI额度政策没有再改。UI合同仅对本次获准修改的tripDates放行，其余39个冻结基线文件仍逐字节核验。

## 3. 已执行验证

全部使用本地合成数据，不消耗生产API额度：

- npm run lint：零警告通过。
- npm run build：TypeScript及生产PWA构建通过；仍有主包超过500kB的性能提示（不是构建失败），本次主包约656.16kB/gzip196.65kB。
- 原八组测试：airlines、flight-duration、flight-trip-placement、schedules-and-flight-display、calendar-and-sync、flight-integrity、ai-reliability、audit-regressions全部通过。
- test-self-audit-sync：v2→v3保守升级；丢响应的新建/更新+模块刷新+原收据恢复；成功修正历史/真实fetch缓存；失败修正保留；外部writer仍CAS冲突；20个并发摘要领取仅一个成功、刷新/账号隔离。
- test-self-audit-calendar：执行实际编辑器submit和Planner拖动函数；洛杉矶设备显示东京00:30计划的原时刻不变；通用/高铁/市内DST跳时拒绝、两次重复时刻、秒保持；date-only新旧锚；拖动到跳时/回拨先确认。时间逻辑不是另写测试副本。
- test-self-audit-ai：执行实际App effect和真实offline领取函数，模拟上游失败。在0/30/60秒调用计数始终1；刷新不重试，新日期可生成，切账号不发旧请求，另一个账号独立。设置手动入口仍存在。
- verify-ui-contract、git diff --check通过。
- 7个Edge入口：Deno2.5.3/cache SDK实际类型检查通过（本轮Edge未再修改）。
- test-database-integrity：默认沙箱initdb被shmget禁止，随后获审查允许的仅本地临时PG18.4运行通过。17个迁移、V1.4.1升级、CAS/RLS/头像路径、父子并发约束、上海月界、20事务限流、100/80航空和10000轻量边界、航班版本/DST/取消、AI缓存与用量原子提交全部通过。不连接生产，Auth/Storage结构仍是平台模拟。

三组新增脚本使用真实模块/AST提取处理函数，外部服务由可控替代实现；这不等于浏览器端到端或真Supabase全部通过。恢复快照及最新包的最终完整性/空目录验证见交付清单。

## 4. 数据升级和回退

IndexedDB由v2升v3，增加automaticSummaries，旧队列不丢弃，attempted缺失一律按可能已发送处理；v1未知归属副本继续隔离。新字段可选以读取旧队列。旧标签页可能阻塞版本升级，应先导出未确认副本并关闭旧窗口；不要删库解决。

低版本构建openDB(2)不能打开v3（VersionError）。回退需兼容v3及历史项语义的构建，或先安全完成/导出未同步数据；不承诺离线队列自动降级。详见[部署回滚](DEPLOYMENT-ROLLBACK.md)。云端本轮不需要新增迁移，但此前候选的17迁移仍须按部署流程验证。

## 5. 尚待独立验证与非保证

- 真实Supabase Auth/Storage/Edge HTTP联调、SMTP投递、iPhone17 Pro安装PWA/安全区/后台前台、浏览器多窗口升级阻塞、发布/回滚演练尚未在本轮执行。不得据此报告“生产零缺陷”或“已上线”。
- 摘要尝试标记是设备可靠性防重，不是反滥用安全边界；换设备、新origin或清站点数据可再次自动尝试，服务端规则保持。若要账户全设备的绝对次数/金额上限需另定政策和服务端门禁，不能偷偷将本地标记当安全控制。
- 当前API合同的普通轻量AI是15次/日、10000池只覆盖非Owner轻量组，回顾/摘要另有规则；早期讨论的10次/日或所有AI统一10000与此不同。已在既有文档披露，本轮不越权改额度政策，请维护者/独立模型再确认。
- 高铁到达时间、酒店选填入住/退房时间仍是模板文字/当地clock，不等于实时铁路信息或逐段跨时区精确时长。本次严格校验针对event_at，不能宣传所有字段都做了航段级解析。
- 失败历史仍保存本机，清站点数据会丢失。完整云端备份及上传图片不在源码包。
- 联网依赖审计本轮未重跑；依赖未变，既有0命中证据仍只是当时结果。

建议第三方先逐项尝试打破SA-01–SA-05，再复核F01–F07及原R01–R10是否回归。测试命令见[README](../README.md)，范围及独立审查约束见[交接单](INDEPENDENT-REVIEW-HANDOFF.md)。
