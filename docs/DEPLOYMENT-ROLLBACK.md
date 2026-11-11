# 部署、备份、灾难恢复与回滚

2026-11-12：生产数据库的 V2 七项迁移已通过 Supabase 管理接口应用，接口生成的版本号已用于仓库中的相应迁移文件名；禁止再次按旧文件名重复执行。7 个 Edge 函数已部署。生产 public 表的授权快照与旧函数代码仅保存在本机临时目录，均不含 Auth/Storage，须另建持久、完整的安全备份。前端发布与验证状态以实际 GitHub Actions 记录为准。

初稿：2026-10-01；修复候选校核：2026-10-02。命令是操作指南，不表示已经执行。每次操作先核对目标项目与分支。生产变更、外部请求、恢复数据库需要维护者明确批准。

## 1. 配置清单

| 项目 | 位置 / 是否公开 |
| --- | --- |
| VITE_SUPABASE_URL | .env.local或构建环境；公开 |
| VITE_SUPABASE_PUBLISHABLE_KEY | 同上；公开客户端key，不是service-role |
| SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY | Supabase Edge平台提供；service-role不得入前端 |
| AVIATIONSTACK_API_KEY | Supabase Edge Functions Secrets；秘密 |
| DEEPSEEK_API_KEY | 同上；秘密，可在发版后补 |
| Resend SMTP密码/API key | Supabase Auth SMTP设置；秘密，不是Edge环境变量 |
| PROJECT_REF | 当前目标项目标识；公开，执行前核对 |
| Supabase CLI token / 数据库连接密码 | 本地受控凭据；不能进入Git/构建日志 |
| Owner UUID / 邀请码哈希 | 受控数据库初始化；明文邀请码私下分发 |
| 域名DNS、SMTP发件域 | Cloudflare / Resend / Auth设置；单独保留配置记录 |

仓库 .env.example、supabase/.env.example只有模板。原src/lib/supabase.ts有生产公开默认连接；测试务必覆盖。GitHub Actions当前workflow不自动读取你电脑的.env.local；换项目需配置构建env或替换公开默认值，不能只改本地后说线上已更换。

外部密钥只留平台，后补EdgeSecrets后相应功能可启用，通常无需重发静态前端；但是必须已部署正确函数/模板，且密钥名完全匹配。SMTP配置与EdgeSecrets是不同入口。[Supabase环境变量说明](https://supabase.com/docs/guides/functions/secrets)

## 2. 从已有源码启动

```bash
git clone https://github.com/sherlockzang/life-tracker-pwa.git
cd life-tracker-pwa
git status --short
npm ci
npm run dev
```

手动创建.env.local并填测试项目公开配置。开发http://localhost:3000/life-tracker-pwa/。Node22.13+，当前Vite8需符合engine。npm ci用于有锁文件的源码恢复；完全从文档重建无锁时先按reference依赖安装生成锁文件。

当前已知基线：
- stable-before-v2.0.0 → d85c3fcfb34a285ed8fb9a833a918f28beded705（稳定V1.4.1）
- V2工作分支 v2.0.0-ui，HEAD a57a11060b855468cb240c807ccbbd10c1e47a62，后续尚有未提交修改。
- 当前脚本包版本2.0.0；本次文档不改变线上。以后这些SHA只是历史定位，不作为永远当前值。

用git worktree或新分支保留稳定源码；不要在有用户改动的工作目录reset --hard。新分支建议codex/前缀，不能覆盖已有同名分支。

## 3. 空Supabase项目初始化

1. 新建独立测试Supabase项目，记录URL/ref、公开key，安全保存数据库密码。
2. 恢复supabase/config.toml、functions、migrations、templates；新项目替换project_id。
3. 查看[数据库说明](DATABASE.md)；新项目先移除原Owner/邀请码历史种子，再按顺序运行17个迁移。已有V1.4.1项目仅应用最后7个；本轮没有运行生产迁移。先核对已有parent_plan_id是否与父计划同owner/同trip且父为trip类型；不一致时人工核对，不能让迁移猜测应移动哪方。
4. Supabase CLI先安装并记录版本；本地数据库需要Docker。项目已有config，不重复init覆盖。
5. link/push前确认目标：
```bash
supabase login
supabase link --project-ref YOUR_TEST_PROJECT_REF
supabase migration list --linked
supabase db push --linked --dry-run
supabase db push --linked
```
6. 若用Dashboard SQL Editor，依次执行各文件且记录迁移管理方式。手动执行不会自动建立CLI历史；之后不得盲目repair/applied，先证明结构一致再按CLI规范同步。
7. 两个普通测试用户验证RLS；确认profiles创建、触发器、Storage桶/策略、schema扩展齐全。
8. OTP建立维护者用户，管理员检查Auth UUID并授Owner；初始化新的邀请码。
9. 按下面步骤部署函数与Secrets、邮件，再执行接口验收。

干净测试项目可用supabase start/db reset验证迁移；**db reset仅用于可丢弃的本地测试库**，不对生产或用户数据运行。没有CLI/Docker/数据库连接时只能静态审查SQL，必须明确“未执行”。

## 4. OTP与Resend SMTP

正式登录需要6位数字验证码，模板和前端同时匹配。Supabase的默认邮件服务用于受限测试，不适合作为正式投递系统；不能把“免费套餐不能改模板”当作设计前提。[Supabase SMTP说明](https://supabase.com/docs/guides/auth/auth-smtp)

1. Resend验证自己的发件域，例如 auth.example.com。把它给出的DNS记录逐项加入DNS服务商；邮件相关记录按要求DNS only，不盲开HTTP代理。不要猜记录值。
2. 等Resend Verified，创建最小发送权限key，安全保管。
3. Supabase Authentication Email/SMTP设置：sender使用已验证域名下的发件地址，name Life Tracker；host smtp.resend.com，username resend，密码Resend key。官方示例使用TLS端口465；如已有587/STARTTLS配置正常不必为了文档改动，按供应商支持选择。[Resend官方集成](https://resend.com/docs/send-with-supabase-smtp)
4. Auth Email Templates同时修改Confirm signup及Magic Link这两个模板；源码为supabase/templates/confirmation-otp.html、magic-link-otp.html，独立参考也保存全文。两者正文呈现{{ .Token }}，不要ConfirmationURL链接，主题说明“登录验证码”。
5. OTP配置为6位，设置合理有效期/发送间隔；保留服务端Auth限流。前端输入one-time-code；账号不存在自动创建。
6. URL Configuration仍设生产Site URL及必要本地/生产redirect白名单，用于旧链接兼容，不意味着OTP需要跳转：
   - https://sherlockzang.github.io/life-tracker-pwa/
   - http://localhost:3000/life-tracker-pwa/
7. 对新邮箱、已有邮箱分别测试“邮件收到数字→原PWA输入→会话持久化→后台恢复”。不把浏览器成功当作已安装iOS PWA成功。
8. 若开启Captcha，先实现前端获取并提交captchaToken，再开Auth强制保护；否则验证码发送会被挡住。
9. Passkeys后台开关不代表前端已支持；当前无注册/登录/管理流程，不能宣称已上线。

OTP方式由模板Token与verifyOtp配合；官方给出了邮箱验证码流程。[Supabase密码less邮箱登录](https://supabase.com/docs/guides/auth/auth-email-passwordless)

## 5. 部署Edge Functions与秘密

Secrets推荐Dashboard填，或在受控目录建立被Git忽略、权限600的.env文件，用CLI --env-file；避免把明文值写进命令历史、README、截图和终端输出。

```bash
supabase secrets set --project-ref YOUR_PROJECT_REF --env-file supabase/.env.local
supabase functions deploy start-demo-session --project-ref YOUR_PROJECT_REF
supabase functions deploy deepseek-assist --project-ref YOUR_PROJECT_REF
supabase functions deploy lookup-flight --project-ref YOUR_PROJECT_REF
supabase functions deploy query-transit-route --project-ref YOUR_PROJECT_REF
supabase functions deploy redeem-invite --project-ref YOUR_PROJECT_REF
supabase functions deploy get-api-quota --project-ref YOUR_PROJECT_REF
supabase functions deploy owner-admin --project-ref YOUR_PROJECT_REF
```

config.toml里两个支持演示的端点verify_jwt=false，其余true；不能给所有部署命令一律加--no-verify-jwt。应用层仍需getUser/demo token校验。目录包含_shared依赖，不能只上传孤立index.ts漏模块。[Supabase部署函数](https://supabase.com/docs/guides/functions/deploy)

7端点全部核对部署成功；Deno检查、未鉴权拒绝、Standard/Friend/Owner权限、quota及mock上游结果逐个验收。缺DeepSeek/Aviationkey只应影响相关自动服务，基础记录可用。

上游模型名称当前deepseek-v4-flash；部署前检查供应商当前支持。不要因为前端“有AI按钮”就认为密钥、模型、额度已实测。测试真实调用要事先确认消耗，演示航空不得真实调用。

## 6. 发布GitHub Pages

当前workflow：main push / workflow_dispatch→checkout→setup-node22→npm ci→npm run build→configure-pages→upload-pages-artifact dist→deploy-pages。permissions contentsread/pageswrite/id-tokenwrite，environment github-pages。

1. 仓库Settings Pages Source选GitHub Actions。configure-pages Not Found常见于Pages尚未启用，先确认站点与权限，不误认为TypeScript构建错误。
2. 在工作分支完成审查；批准后提交并合并main。main推送会自动部署，提前告知维护者。
3. 版本三处一致：package.json（锁文件根版本）、src/version.ts、src/lib/releaseNotes.ts；配套SQL changelog。长期更新记录须保留1.0.0开始各版。
4. 新字段先部署全部7个增量迁移，再Edge（尤其lookup-flight/deepseek-assist/get-api-quota及_shared），最后前端；包含全天酒店、CAS、航段版本、AI上下文、原子频率、反向关联约束与reset元数据修正，不能只发前端。SQL-first旧Edge桥接与旧PWA→新Edge兼容须在测试项目验收，不能仅凭静态代码宣称安全。
5. Actions build/deploy都成功才算流程完成；另外打开线上确认manifest/icons/assets/实际版本，不用CI绿色代替产品检查。[GitHub Pages自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
6. 清洁新浏览器+已有安装PWA都验收；旧Service Worker会缓存旧包，autoUpdate不是保证即时跨所有设备更新。
7. 记录release SHA、日期、迁移列表、7函数对应源码SHA/部署版本、Auth模板、公开构建配置、测试结果、回滚目标；秘密只记录保管位置。

部署先冻结功能，以[最新验收](ACCEPTANCE-2026-10-01.md)为准：代码修复不等于真实SQL、Deno、真机与安全审计门禁通过。

## 7. 自定义域名迁移

可继续GitHub仓库/Actions/Pages/Supabase工具，只改变站点origin与配置，不需要重写业务。顺序：

1. Pages绑定域名/配置DNS/CNAME、验证HTTPS。用维护者确实拥有的域名，不凭示例修改DNS。
2. 若根部署，Vitebase、manifest start_url/scope改/，index.html图标与OG链接、App静态Logo路径同时改；不能只加CNAME。
3. Supabase Auth Site URL/redirect允许新地址；Edge _shared/api.ts CORS允许新origin，确认不含URL path。
4. Service Worker scope、图标路径、Web Manifest验证；旧域名浏览器会话/IndexedDB不能自动迁移到新origin，用户在新PWA重新OTP登录后读取同云端数据。
5. 若将来Passkey，RP ID必须最终稳定站点域名，不能把auth发件域当RP ID；域名切换可能需要重新登记凭证。
6. 不删除旧站点/跳转直到新站点验收；避免两个scope服务互相缓存。
7. SMTP发件域是独立配置：网站域名和发件域不必相同。无需为了换网站域名轮换SMTP密码。

## 8. 分层发布门禁

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
node scripts/verify-ui-contract.mjs
node scripts/verify-documentation.mjs
git diff --check
```

真实数据库入口`node scripts/test-database-integrity.mjs`使用可丢弃本地PG18，不连接生产；包含17个迁移、V1.4.1历史数据升级、CAS/RLS、20并发限频、航空池、AI原子提交、旧航班接口与重匹配、父子双向并发和UTC/上海月末。只配置化历史Owner哈希到合成账号，不修改历史迁移文件。2026-10-02已在受审查允许的沙箱外本地运行通过；沙箱内仍可能因共享内存失败。它模拟Auth/Storage结构，不替代Supabase测试项目或Deno集成验证。

另需：

- Deno：7入口已实际类型检查（临时Deno2.5.3，当前jsr Supabase2解析为2.117.2），并修正UUID字符串推断；npm lint仍仅src。此项不等于Supabase Edge HTTP/运行集成，发布前继续验证。远程`@2`不是精确锁定，重跑需记录解析版本。
- SQL：空库迁移、升级旧库、回滚前端兼容、两用户RLS、OwnerRPC拒绝普通用户。
- 并发：100/80航空桶、10000轻量桶不超；60s burst也不能并发越过；同requestUUID不双计。
- OTP：新旧邮箱模板、有效/过期码、PWA后台回前台、退出与重登。
- 实机：iPhone17Pro主屏PWA安全区、键盘、320/402px、横屏、深浅主题、静态离线。
- 数据：离线队列跨账号、网络失败、永久RLS错误、重试、跨设备旧数据冲突。
- 航班：未来0调用、精确过滤、preview/confirm、编辑失效、DST边界、跨日入境。
- 酒店：范围、入住/续住/退房、换店、重叠、编辑一次更新所有日期。
- AI：预览确认、missingkey、超时、无计划skip、缓存不扣、币种/日历不误导。
- 真实供应商测试在维护者批准后少量做，不用公开demo验证100次真实航空。
- 联网npm audit（生产和完整开发依赖）及必要升级回归；维护者授权后完成9个受影响开发/构建包的兼容修复，最新完整/生产审计均0命中，Vite锁定8.3.1且业务生产依赖不变。详见[审计报告](DEPENDENCY-AUDIT-2026-10-01.md)。每次发布仍重新审计，不把当次0命中当永久零漏洞。

### 8.1 Edge类型检查

从项目根目录运行（已安装Deno时）：

```bash
deno check --no-config --no-lock supabase/functions/start-demo-session/index.ts supabase/functions/deepseek-assist/index.ts supabase/functions/lookup-flight/index.ts supabase/functions/query-transit-route/index.ts supabase/functions/redeem-invite/index.ts supabase/functions/get-api-quota/index.ts supabase/functions/owner-admin/index.ts
```

本轮用官方npm临时`deno@2.5.3`运行上式，不把它加入应用依赖、不改生产秘密、不执行函数。首次检查会下载公开jsr依赖，需要网络；缓存命中可离线重复。不要用语法解析0错误代替真正类型检查。实际发布还应记录Supabase CLI/运行时与远程SDK版本。

## 9. 回滚分层

### 9.1 静态前端回滚

先暂停合并/发布，记下坏版SHA/日志。对用户脏工作区不进行reset/checkout覆盖。新建隔离worktree检查目标：

```bash
git worktree add --detach ../life-tracker-rollback stable-before-v2.0.0
cd ../life-tracker-rollback
npm ci
npm run build
```

这只生成旧源码构建，不会部署。批准后选择：
- Actions部署**保存过的旧dist artifact**（artifact有保存期限，先验证版本）。
- 或对main做范围明确的git revert（保留提交历史；merge提交需确认正确mainline），review后push触发Pages。
- 或由发布工作流显式构建选定commit并部署。当前workflow无ref输入，不能在UI选tag就假设job会构建它；须核对workflow引用。

回滚前检查旧前端能够读取新schema及当前Edge兼容省略planVersion的旧请求。保留schedule_details等增量字段/新用户记录。前端回滚不撤销已写数据；旧UI不显示酒店也不应删除它。当前IndexedDB已v3，先导出本地队列；旧程序请求低版本会报VersionError，不能宣称向下兼容或删除库掩盖错误。需制作兼容v3且不重放历史失败项的回退构建，或先完成/导出待同步再按维护者确认流程恢复。旧客户端仍盲写整行，回退仅短期用。核对新安装及已有PWA。

本次自审修复没有新增SQL或Edge部署需求；客户端v3升级需测试v2→v3、旧标签页versionchange、历史导出、失败摘要不重试，详见[自审修复](SELF-AUDIT-FIXES-2026-10-02.md)。

### 9.2 Edge回滚

从已验证release bundle恢复各函数目录和_shared共同版本，再部署需要的函数；确认与当前SQL RPC兼容。旧flight preview仅在同owner/current claim及排定航段完全一致时由SQL桥接补version；旧finish只使用验证过的存储预览，忽略传入payload。先验证这些拒绝/允许边界。不要回退到不校验角色/额度的旧航班函数。回滚旧AI端点会失去新缓存/恢复保障，未确认内容先导出；Secrets/SMTP仍保留，配额日志不会清零。

### 9.3 SQL回滚

无自动down迁移。增量列/表通常留着，由前向修复解决约束/函数错误。若RPC需退回，必须审查新旧权限与额度是否兼容（V1.3旧Owner限额会重新出现）。

只有数据损坏且维护者批准时才恢复备份；优先新项目恢复并对比。整库恢复会丢备份之后的用户写入，必须先导出当前数据并做差异补偿；不允许为了UI坏掉就恢复整个生产DB。删除列、truncate、db reset都不是常规回滚。

## 10. 备份层次与独立保存

| 内容 | 方式 / 注意 |
| --- | --- |
| 全部源码+Git历史+未提交修改 | Git镜像或bundle + 单独工作树源码归档；bundle不含未提交/未跟踪 |
| 本Markdown包 | 保存到不同设备/云盘；带SHA256；五份reference含完整应用源码/图标/锁文件，不含云端历史数据或秘密 |
| 数据库结构与数据 | 受控CLI逻辑dump/平台备份，含自定义Auth/Storage策略与迁移历史 |
| Auth身份 | UUID保持一致；若重建新用户需映射FK，不能按显示昵称自动认领 |
| Storage对象 | 分桶下载文件、相对路径、MIME/size清单；数据库dump不含图片字节 |
| Edge代码/配置/模板 | 源码归档及reference，部署版本另外登记 |
| 秘密 | 密码管理器/平台，导出加密；绝不塞公开docs.zip |
| DNS/SMTP/Pages设置 | 配置截图/文本，无敏感密码；记录域/host/port/发件人 |

例如有Git历史的源码备份：

```bash
git bundle create life-tracker-history.bundle --all
git bundle verify life-tracker-history.bundle
```

在干净验证目录测试bundle克隆；再补工作树未提交文件/正式Logo/锁文件。不要把node_modules/.env.local/缓存/包含令牌的浏览器profile装进公开压缩包。

数据库使用当前CLI与官方恢复说明；连接串含密码，仅经受控环境变量/凭据工具提供。按部署环境确认dump覆盖范围，不能把仅public表导出称作完整身份备份：

```bash
supabase db dump --db-url "$OLD_DB_URL" --role-only -f roles.sql
supabase db dump --db-url "$OLD_DB_URL" -f schema.sql
supabase db dump --db-url "$OLD_DB_URL" --data-only --use-copy -f data.sql
supabase db dump --db-url "$OLD_DB_URL" --schema supabase_migrations -f history_schema.sql
supabase db dump --db-url "$OLD_DB_URL" --schema supabase_migrations --data-only --use-copy -f history_data.sql
```

使用CLI版本对应的排除平台表参数；dump后检查auth数据/自定义trigger、storage元数据与自定义policy是否覆盖，不把CLI默认行为当永久保证。敏感dump需加密、访问控制及保留周期。Storage对象另行导出。[Supabase备份恢复及Storage迁移官方指南](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

此文只给恢复流程，未替维护者执行生产数据库/图片/秘密备份。SMTP、URL、EdgeSecret和DNS不在数据库dump中。

## 11. 灾难恢复演练

### 从Markdown恢复源文件（已在空目录演练）

五份reference包含全部src、17个SQL、7函数与共享模块、邮件、测试、构建配置、锁文件和9个PNG。准确数量由校验脚本输出。每块注释标明source路径、SHA256和encoding，四反引号代码块保存正文；utf8按原字节恢复，base64解码后恢复原PNG。刷新后必须重新恢复到空目录验证，不把旧演练结果用于新快照。新增`node scripts/test-audit-regressions.mjs`也必须运行。

若工具也丢失，在DOMAIN-REFERENCE中找到scripts/restore-documentation-reference.mjs代码块，提取为独立.mjs。其CLI支持--reference路径，--out必须是不存在的新目录；不加--write仅校验。不要把全部SQL混成一个文件，也不要因为旧identity seed存在就对生产执行。

```bash
node scripts/restore-documentation-reference.mjs
node scripts/restore-documentation-reference.mjs --out ../life-tracker-recovered --write
cd ../life-tracker-recovered
npm ci
npm run lint
npm run build
```

当恢复工具位于别处，追加--reference /ABSOLUTE/PATH/TO/docs/reference。恢复工具只提取应用文件，不复制说明文档；请将本包README.md、docs目录、supabase/README.md另行保留在恢复目录，文档校验脚本需要它们。恢复后没有Git历史、真实.env.local、云端数据、角色身份、部署登记，需另行恢复或初始化；没有stable tag/HEAD就不能运行依赖原Git基线的verify-ui-contract。独立源码ZIP另包含说明文档，但同样不含这些云端材料。正式发布须补最新验收中的门禁。

### 云端与运行环境恢复

1. 备份原材料到仓库之外；记录SHA256和来源版本，确认可读。
2. 在新测试项目恢复结构/数据/Auth身份，或空库走迁移重新实现；这两条路径不混跑。文档包恢复仅是源码恢复，不会替你做这一步。
3. 根据官方CLI流程恢复roles/schema/data及migrationhistory；Auth/Storage自定义trigger/RLS按迁移重建；敏感加密rootkey/Vault如使用需专门处理（本应用没有自建Vault流程）。
4. 恢复Storage对象到原相对路径，核对private/public桶和头像访问。
5. 重设7函数、Secrets、SMTP模板、公开URL/key、CORS、Pages/PWA路径。
6. 授Owner只对已确认UUID；停用旧未知邀请码，创建新邀请。
7. 用户OTP重新登录；失效旧会话、秘密如果有泄漏立即轮换。
8. 对所有用户数量、记录数量、trip关联、金额、hotel范围、quota桶、审计做对账；保留备份后新增数据差异。
9. 功能矩阵/实机/离线/权限/并发验收，正式切DNS/发布前取得批准。
10. 标记哪些历史数据或资源未恢复，不用“功能能跑”宣称全量恢复成功。

## 12. 常见故障定位

| 现象 | 优先检查 |
| --- | --- |
| 邮件仍是链接 | 两个OTP模板是否都改、是否看了旧邮件、模板Token是否生效 |
| 不收邮件 | Resend Verified/发件域、SMTP密码、Auth限流、垃圾箱、投递日志 |
| Safari登录PWA仍未登录 | 在PWA输入OTP；getSession不能跨存储容器复制会话 |
| new row violates RLS | JWT/userUUID、对象目录、upsert需要SELECT、SQL是否已应用；不关RLS |
| AI无响应 | key名、模型支持、函数版本、Auth/demo、配额、CORS、服务日志 |
| 航班无结果 | 1h–48h窗、两端IATA、出发当地日期、号码/代码共享、供应商无数据 |
| Pagesconfigure404 | Pages Source GitHub Actions、仓库Pages权限和站点开启 |
| 安装图标旧 | 确认apple-touch PNG可访问、版本路径、已有主屏图标缓存；未同步记录先保护 |
| 本地有新UI线上没有 | 没push/merge，Actions失败、旧SW缓存、构建配置不是本地env |
| 酒店保存失败 | schedule迁移未应用、end<=start、JSON字段/类型不匹配 |
| 保存提示成功但云端没有 | outbox/permanent错误吞入队、账号切换、迁移/权限；按审查修复 |
