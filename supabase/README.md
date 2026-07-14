# Supabase 配置

## 数据库

1. 打开 Supabase 项目的 **SQL Editor**。
2. 按文件名顺序运行 `migrations/` 中的 SQL 文件。
3. 在 **Authentication → URL Configuration** 设置：
   - Site URL：`https://sherlockzang.github.io/life-tracker-pwa/`
   - Redirect URL：`https://sherlockzang.github.io/life-tracker-pwa/`
   - 本地 Redirect URL：`http://localhost:3000/life-tracker-pwa/`

迁移会创建个人记录、行程、交通模板、资料和更新记录所需的数据结构与 RLS，并配置头像与记录图片存储桶。

## 邮箱验证码登录

Life Tracker 1.4.0 使用 Supabase Email OTP。新账号的 **Confirm signup** 模板和已有账号的 **Magic Link** 模板都必须显示 `{{ .Token }}`，不能只提供 `{{ .ConfirmationURL }}` 链接。仓库内对应模板为：

- `templates/confirmation-otp.html`
- `templates/magic-link-otp.html`

用户收到 6 位数字验证码后直接在 PWA 内输入，因此 iOS 主屏幕 PWA 不需要通过 Safari 回传登录状态。

## Aviationstack 航班查询

航班查询使用服务端 Secret `AVIATIONSTACK_API_KEY`，由 `lookup-flight` Edge Function 代理。真实 Key 不得放进前端环境变量或提交到仓库。

部署函数：

```bash
npx supabase login
npx supabase link --project-ref ihqkgtmikwdakhyglels
npx supabase secrets set AVIATIONSTACK_API_KEY=你的密钥 --project-ref ihqkgtmikwdakhyglels
npx supabase functions deploy lookup-flight --project-ref ihqkgtmikwdakhyglels
```

未来航班只保存手动计划信息，不调用 Aviationstack。系统会按计划到达日期、当地时间和 IANA 时区换算 UTC；到达约一小时后至 48 小时内，用户可主动点击“匹配实际飞行信息”。服务端会重新读取用户记录并严格核对航班号、出发日期及起降机场，返回计划/实际对比预览，用户确认后才会保存。

## DeepSeek 智能助手

API Key 只保存在 Supabase Edge Function 的服务端环境中，绝不能写进 `VITE_*` 变量、前端源码或 GitHub 仓库。

### 1. 申请 DeepSeek API Key

1. 打开 <https://platform.deepseek.com/> 并登录。
2. 进入 **API Keys** 页面，新建一个 Key。
3. 复制并妥善保存 Key；根据 DeepSeek 控制台提示确认账户额度可用。

### 2. 在 Supabase 保存密钥

1. 打开项目 `ihqkgtmikwdakhyglels` 的 Supabase Dashboard。
2. 左侧进入 **Edge Functions**，打开 **Secrets Management**。
3. 新增 Secret：
   - Key：`DEEPSEEK_API_KEY`
   - Value：刚才复制的 DeepSeek API Key
4. 点击 **Save**。保存后密钥会立即提供给已部署的函数，不需要重新发布网站。

### 3. 部署 Edge Function

仓库以通用 `deepseek-assist` 函数承载路线查询、记账解析、随记润色、旅行回顾与每日摘要；旧的 `query-transit-route` 仅作为向后兼容入口。可在项目根目录执行：

```bash
npx supabase login
npx supabase link --project-ref ihqkgtmikwdakhyglels
npx supabase functions deploy deepseek-assist query-transit-route --project-ref ihqkgtmikwdakhyglels
```

检查 Secret 是否存在：

```bash
npx supabase secrets list --project-ref ihqkgtmikwdakhyglels
```

也可以通过 Dashboard 的 Edge Functions 编辑器查看已部署函数，但应以仓库内代码为准，避免线上代码和版本记录不一致。

### 4. 本地测试（选做）

复制 `supabase/.env.example` 为一个不会提交的本地文件，例如 `supabase/.env.local`，填入真实 Key 后运行：

```bash
npx supabase functions serve deepseek-assist --env-file supabase/.env.local
```

正式账号需要先登录 Life Tracker；演示模式使用按设备延续的短期服务端会话。函数会验证身份、执行原子配额和频率保护、限制输入输出长度，并在 DeepSeek 不可用时让前端回退为手动填写。旅行回顾会先在服务端汇总消费与地点，并最多抽样 20 条随记，不会把整段原始行程直接发送给模型。

## v1.3.0 Edge Functions

```bash
npx supabase functions deploy deepseek-assist start-demo-session redeem-invite get-api-quota lookup-flight query-transit-route --project-ref ihqkgtmikwdakhyglels
```

- `deepseek-assist`：统一 AI action 分发、固定 system prompt、额度与缓存
- `start-demo-session`：生成并轮换按设备延续的演示 token
- `redeem-invite`：服务端散列验证与 Friend 权限兑换
- `get-api-quota`：返回当前账号可展示的额度快照
- `lookup-flight`：完成时间校验、精确匹配、并发锁和预览确认
