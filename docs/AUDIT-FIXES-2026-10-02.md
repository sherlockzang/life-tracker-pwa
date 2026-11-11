# 独立审计问题处置与复验

日期：2026-10-02；对象：V2.0.0本地候选工作树。维护者提供的[独立原报告](INDEPENDENT-AUDIT-2026-10-02.md)审计旧包SHA256 `4d01b0253fcb2e7e127c7008bf1458d1fbb92edd9e896d25ce9bf97125d77a68`。本轮逐项核对，F01–F07均有实际代码缺口，全部修复；并未修改额度产品政策或部署生产。此文是开发者复验记录，不代替下一轮独立复审。

## 修复对应

| 发现 | 处置 | 回归证据 |
| --- | --- | --- |
| F01 P1 单页当完整数据 | 前端records/trips/rates/changelogs及AI完成状态/聚合/摘要用唯一不可变id游标读取到空页。短页不是结束。全批失败不覆盖缓存，不基于部分数据生成AI | test-audit-regressions：1001条、服务端cap137；分页中途错误原缓存保留；删除已读ID/改变event_at仍不跳页。test-ai-reliability：第1001条未完成阻止回顾，完整聚合USD1001，摘要中途失败零上游/额度 |
| F02 P1 关联离线顺序 | 独立relationDependencies；拓扑重放/领取时重推导父trip/plan，父failed/inflight等待；被引用父节点不合并丢失；只同实体后继继承CAS | 实际fake-IDB：离线旅程→计划→编辑旅程→子随记→编辑父计划；同毫秒、重新载入DB连接、父租约/失败/显式重试，全部最终confirmed且子CAS不是父版本；failed副本刷新仍可见 |
| F03 P2 反向关系约束 | 新增20261002000000迁移。更新触发列含record_type；有子项时拒绝父trip/type/user破坏关系。child检查parent取FOR SHARE，与parent UPDATE行锁串行 | 真实PG18：authenticated CAS父移动/类型变更拒绝；child先插入持锁→parent更新等待后拒绝，以及parent先移动→child等待后拒绝，两方向实测 |
| F04 P2 内层形状 | AI消费结果非null非数组object才规范化，否则AI_INVALID_OUTPUT/502。航班项验证必要nested对象/IATA/scheduled，跳过坏项；全坏非空列表API_UNAVAILABLE。已发尝试不退款 | 实际Edge源码mock：null/数组/布尔/数字/字符串不保存为空成功；一次quota/一次upstream/完成失败日志；[null,坏行,有效行]可正常预览，全坏清claim且不stage |
| F05 P2 配额故障造余额 | entitlement、完整桶集合、冷却、月计数全部检查；任一失败DATA_UNAVAILABLE/503，无data余额。只有成功无行才补零 | 分别注入四分支错误；每项503无假余额；成功无entitlement仍standard；Owner其他人用18时显示82剩余 |
| F06 P2 错误月末 | Edge以上海年月构造下月1日；尚未发布的atomic迁移在上海本地timestamp先加日/月再转换；新迁移只修既有period_end，不动key/limits/used/logs | Edge长短月/闰二月/跨年/上海月界；真实SQL UTC和上海session执行当前admission表达式矩阵；旧二月桶end修复且18已用/100限额保持 |
| F07 P2 route合同 | 保留文档二选一合同。query-only或完整origin/destination均合法，三项也可；单端点/缺项/超长提前400。网页仍双输入，文案不再声称主页单句UI | 三条合法输入成功；缺项/超长/出发时间超长全部400且零upstream/quota；API/架构/重建规范已一致 |

共同约束：账号隔离、CAS/UUID幂等、实际航班版本、恢复签名、100/80航空总池及10000轻量共享池不变；Standard轻量15次/日仍是现有政策，历史10次差异没有擅自决定。10000只轻量，不把recap/summary误写为同一个总池。没有新增业务依赖。

## 已执行的复验

- 新`test-audit-regressions.mjs`先对旧包的已恢复源码执行，实际退出1：cap137下loaded137≠1001。再对当前源码执行退出0；不是只写永远通过的断言。
- 原七组回归加新增第八组，lint/build、原工作树UI合同（40个冻结文件；get-api-quota仅F05/F06显式放行）、Deno2.5.3七入口类型检查、git diff检查。
- `test-database-integrity.mjs`首次沙箱initdb仍因shmget退出1；本轮通过安全审查获得仅本机隔离测试执行后重跑，真实PG18.4退出0，17迁移及新增两个关系race/会话时区矩阵均通过。临时集群停止，无生产网络或上游调用。
- 更新五份源码reference后，从全新目录恢复并重新安装锁文件、构建和执行八组回归；文档校验核对源文件SHA与本地链接。最终包清单记录准确数量/哈希。

最终结果：原工作树和全新恢复目录均lint/build、八组回归、七Deno入口检查退出0；恢复目录也在获审查允许的临时PG18.4实际执行17迁移和完整数据库回归退出0（不是只沿用原目录结果）。40文件Git/UI合同在原工作树通过，恢复目录无Git不伪造基线。20份Markdown、108本地链接、114份源码/资源快照通过校验。2026-10-02官方registry全量与omit=dev的npm audit均退出0、公告命中0；仅只读审计，没有再次变更锁文件。

环境：Node26.3.1/npm11.16.0、Vite8.3.1、Deno2.5.3（缓存Supabase jsr2.117.2）、临时PG18.4。恢复npm ci使用既有公开依赖离线缓存并ignore-scripts，532包；glob11.1.0/source-map beta弃用警告保留。主包653.70kB，超过500kB提醒未隐藏。本轮无UI样式修改，未重新跑浏览器/真机交互；旧包截图及独立报告的Chrome结果只是旧阶段证据，不冒充新源码端到端验收。

## 仍需维护者决策和发布门禁

真实Supabase OTP/Storage/JWT网关、iPhone主屏PWA/旧SW更新、真正历史备份升级及部署回滚仍未在本轮执行；不把Chrome或模拟Auth/Storage的PG验收当成这些验证。当前构建仍有超过500KB提醒，Node22目标环境仍需复验，Deno远程@2非永久锁定。

ID游标分页不是一个数据库事务快照。并发新写入可能到下一次刷新才显示，已读后删除可能暂保留到下次；不会把单页上限当完整、按可变日期/offset跳过后续旧行，任一页失败不发布部分结果。

新的反向触发器保护后续写入，不会猜测修复已存在的错误父子关系；发布前须按部署文档列出并人工核对历史不一致。新增迁移只修reset元数据，非额度重置。七个V2增量须按SQL→Edge（包括get-api-quota/_shared）→前端顺序发布，仍需维护者批准。本地修改尚未提交、推送或上线。
