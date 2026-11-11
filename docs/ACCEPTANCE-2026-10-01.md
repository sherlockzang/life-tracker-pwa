# 修复验收记录

日期：2026-10-01。对象：V2.0.0本地工作树，基线HEAD `a57a11060b855468cb240c807ccbbd10c1e47a62`，修改尚未提交/推送/部署。第一轮缺陷证据保留在[原审查报告](CODE-REVIEW-2026-10-01.md)；本文件描述修复后的状态。

追加修复及最终文档恢复复验：2026-10-02；保留原文件名以维持审查证据和链接。

本日后续收到独立审计F01–F07并全部处置，最新复验以[审计修复记录](AUDIT-FIXES-2026-10-02.md)为准。当前17迁移、8组回归、40文件UI保护合同；下面早期16/7/41/110等计数是原阶段证据，不代替新快照。临时PG本轮已获审查允许并重跑通过；此前共享内存阻挡记录保留历史，不再是当前PG验证阻塞。仍未在真实Supabase和iPhone上线验收。

随后完成SA-01–SA-05自审修复与2026-10-03收尾，最新状态以[自审修复记录](SELF-AUDIT-FIXES-2026-10-02.md)及交付清单为准：17迁移、11组前端/模拟回归、39冻结文件、117源码资源快照、21份Markdown。旧计数保留历史；本轮仍未发布。

## 结论与边界

R01–R10均已有代码修复及对应本地回归，并追加修复DST重复clock、取消航班资格、整响应超时及AI航班归日边界。前端静态检查、生产构建、七组功能/故障回归、安全/PWA合同与真实本地PostgreSQL18.4验收通过；源码/图标快照刷新后逐文件校验并可从Markdown还原。

**这是可交独立模型审查的候选包，不是无条件上线许可。** 沙箱内PostgreSQL曾因共享内存失败；受安全审查允许的沙箱外临时本地数据库已成功运行，测试通过后停止集群。测试用简化Auth/Storage平台表与角色模拟，不能等同于生产Supabase Auth/Storage/OTP完整验收。7个Edge入口另用Deno2.5.3实际类型检查通过，但真正iPhone独立PWA、Supabase Edge HTTP/完整运行集成及供应商真实返回未重新验证。未执行生产迁移、部署、角色变更或真实AI/航空请求。

## 修复映射

| 项 | 修复 | 已验证 | 尚需补充 |
| --- | --- | --- | --- |
| R01 保存错误吞掉 | confirmed/pending/failed/conflict；失败保留草稿和副本；顶部状态依队列/确认 | RLS/约束/缺RPC为永久失败，网络为pending；保存表单与通知分流 | 真数据库权限与真机断网恢复 |
| R02 账号与同步冲突 | owner索引、逐请求账号复核、CAS、幂等收据、依赖链、叶合并及租约 | 双账号/切换/旧队列隔离、同毫秒编辑、租约、显式owner查询；真SQL CAS并发/幂等 | 真设备双端编辑 |
| R03 航段与旧结果 | server版本、预览绑定、行锁确认、元数据保护；active/confirmed请求分离 | mock及真SQL编辑失效/保护、A→B重匹配、旧Edge桥接；旧PWA→新Edge兼容mock | 实项目滚动升级 |
| R04 频率竞态 | 全局事务锁提前，额度数值不变 | 真PG20事务最多10通过；已有9次再并发仅1通过，5分钟冷却、用户隔离/Owner豁免 | 实部署运行走查 |
| R05 混币回顾 | 分类金额按币种分组，提示模型不猜换汇/占比 | USD1与JPY100不合成101 | 真模型输出人工复核 |
| R06 今天/酒店摘要 | 旅程当地日、纯日历Day、酒店/全天/首日入境投影、上下文缓存；统计按设备日 | 午夜/DST/多旅程/换店/摘要context变化；旧无效时区引导修复 | 真机午夜/后台切前台 |
| R07 时间线顺序 | 日期组显式倒序，同组绝对时间倒序 | 30→28→29例变为30→29→28 | 更多真实记录走查 |
| R08 结果保存失败 | 检查缓存/usage错误；保留内容、签名恢复；仅重试保存 | mock签名/错账号/恢复零上游；真SQL缓存+usage回滚/恢复、新缓存不被旧恢复覆盖 | 完整HTTP响应丢失边界 |
| R09 手填未知机场 | 可存名称/当地时区，API匹配才要求IATA | 手动保存校验与API资格分离 | 更多机场手填走查 |
| R10 focus误在线 | 恢复前台读取navigator.onLine及真实云端状态 | 代码检查；离线不再直接置online=true | iPhone飞行模式/恢复前台 |

## 测试入口

```bash
npm ci --ignore-scripts
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
node scripts/verify-ui-contract.mjs
node scripts/verify-documentation.mjs
git diff --check
```

新增测试仅使用模拟IndexedDB、mock数据库/上游及真实WebCrypto签名，无生产请求。QuickComposer的真实submit处理函数也执行故障回归，RLS拒绝后保留草稿、显示错误并解除saving。UI合同冻结41个历史/安全/PWA文件、OTP/Auth/Owner/邀请码处理和`#0A84FF`主色；QuickComposer因本次保存错误修复显式放行。允许明确授权的可靠性范围，不以整份App字节相等假装验收业务。

数据库独立入口：

```bash
node scripts/test-database-integrity.mjs
```

测试使用临时本地PG18集群、随机测试用户和16个迁移，不读生产私钥、不连接Supabase。仅将两份历史Owner配置哈希映射到`example.invalid`合成账号，SQL逻辑不变；保留原源码不改历史迁移。先执行V1.4.1加入已匹配/陈旧航班和历史摘要，再升级剩余6个迁移，验证数据保留与版本迁入。测试还覆盖真实20并发、100/80及10000边界、CAS/RLS、confirmed UUID保护、A→B确认、旧接口、AI原子提交和上海午夜同上下文缓存。

首次需安装锁定embedded-postgres/pg；脚本只恢复包内安全相对链接，不创建系统用户。沙箱内曾报`shmget: Operation not permitted`，最新受审查允许的沙箱外运行退出0；失败仍退出1，不以静态检查代替通过。PG18不等于实际Supabase平台版本，发布前继续做测试项目集成。

历史：2026-10-01真实PG运行含16迁移及DST/取消通过；首个2026-10-02交付包重跑曾因shmget在initdb失败，那个包只能说“上一轮通过、本轮环境阻挡”。收到独立报告后的本轮权限已允许仅本机临时测试，真实17迁移及F03/F06新增用例成功。不能把后来成功追溯改写成旧包也在当时成功；同样不能把旧包110快照/SQL字节用于新版本复验。最新结果见审计修复记录。

## 本轮追加验证

- 依赖：官方registry完整及omit=dev审计均0命中；兼容更新、不使用force，业务生产依赖版本未变，Vite仍8，详见依赖报告。
- Edge：Deno2.5.3对7个入口实际`deno check --no-config --no-lock`退出0。实际发现并修正DeepSeek和flight两个UUID变量类型推断错误。jsr Supabase`@2`本轮解析2.117.2，不等于远程依赖永久锁定或函数运行验收。
- 上游故障：同一硬deadline覆盖慢headers/慢body，模拟忽略abort的传输也返回AI_TIMEOUT/API_TIMEOUT；只保留一次已预留尝试、清计时器及航空claim、不写缓存或预览。非法/非object JSON返回既有不可用错误；模拟含fake key的网络错误不进入响应/日志。
- AI日期：航班每日投影改用与前端/Edge相同的offset-aware解析器，首次/第二次在Pacific/Gambier午夜两侧分别归日；未选歧义和不存在时刻不作为模型推断依据。
- 文档灾备：五份reference包含110个完整源码/配置/测试/迁移/图标文件，逐字节SHA256校验通过。2026-10-02从Markdown恢复到新的空目录，离线安装锁定依赖，lint、生产构建、七组回归、文档校验及7个Deno入口再检查均退出0。18份Markdown、98个本地链接无断链。恢复目录无Git历史，因此基线UI合同仅在原工作树通过，不伪造恢复目录基线；数据库受限重跑情况如上，不标为恢复目录已通过。
- 浏览器：使用已安装Chrome的独立临时配置、本机127.0.0.1预览、无效本地Supabase连接和纯本机demo数据；外部请求均拦截，未进入真实demo会话或API。实操验证重复clock无静默默认、必选校验、两种偏移实时120/60分钟、存储UTC/offset、重开保留选择和改日期清选择；1440px深色、402×874px深/浅色无页面横向溢出、无未捕获运行错误，实际计算出的深/浅主色均为rgb(10,132,255)即#0A84FF。截图位于交付目录qa。此为桌面Chrome尺寸仿真，不是iPhone/Safari/安全区或OTP真机验收。

## 剩余风险及产品边界

- npm在线安全审计最初因DNS及外传授权不足而受阻，没有绕过；用户明确授权后取得报告，再按继续修复指令兼容更新9个开发/构建受影响包。最新官方registry完整/生产报告均0命中；生产业务依赖与精确测试工具无变更，Vite仍8。已重跑lint/构建/七组回归/真PG与UI合同。0命中不等于整站零漏洞，详见[依赖审计](DEPENDENCY-AUDIT-2026-10-01.md)。
- 主包仍超过500KB，构建保留警告，没有提高阈值隐藏；不影响本轮编译通过，后续可优化分包。
- 秋季DST回拨已增加第一次/第二次强制选择及numeric UTC偏移；前端保存、飞行时长、行程归日、Edge资格和数据库版本/旧接口采用一致约束。测试包含LA/纽约回拨、两端歧义、Lord Howe半小时回拨、错误偏移和不存在时刻。供应商实际clock没有一致偏移证明时不会猜测实际用时；真实航空返回仍须测试项目核对。
- 客户端IDB/LocalStorage不是云端备份；清数据、换设备可能失去未确认内容。旧无owner副本保留隔离，不展示给任意账号。
- 签名恢复30分钟有效，超时仍保留文字副本但不能凭过期凭据写云端；可先复制/导出，核对后再操作。首次上游完成但整个HTTP响应丢失时，客户端未拿到内容，不能承诺可恢复所有网络故障。
- 航班匹配也更新服务器updated_at；待同步座位/备注可遇到安全CAS冲突。副本保留，核对后重新编辑；不静默覆盖。
- 10000仍仅非Owner轻量AI池；当前Standard15次/日是既有实现。没有擅自扩展预算或改成历史讨论的10次。
- 旧客户端直接整行写入仍属旧协议，新增CAS保护仅新客户端路径；升级后应让旧PWA刷新。用户业务RLS未关闭。
- 存储头像真实上传、Passkey、邮件提醒、通用记录图片与完整云数据导出均不由此次验收承诺。副本JSON只导出本机待处理内容。

独立模型按[审查交接单](INDEPENDENT-REVIEW-HANDOFF.md)检查，所有发布阻断项满足后再由维护者批准上线。
