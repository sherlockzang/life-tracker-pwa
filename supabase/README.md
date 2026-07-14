# Supabase 配置

## 数据库

1. 打开 Supabase 项目的 **SQL Editor**。
2. 按文件名顺序运行 `migrations/` 中的 SQL 文件。
3. 在 **Authentication → URL Configuration** 设置：
   - Site URL：`https://sherlockzang.github.io/life-tracker-pwa/`
   - Redirect URL：`https://sherlockzang.github.io/life-tracker-pwa/`
   - 本地 Redirect URL：`http://localhost:3000/life-tracker-pwa/`

迁移会创建个人记录、行程、交通模板、资料和更新记录所需的数据结构与 RLS，并配置头像与记录图片存储桶。

## DeepSeek 路线查询

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

仓库已包含 `supabase/functions/query-transit-route/index.ts`。可在项目根目录执行：

```bash
npx supabase login
npx supabase link --project-ref ihqkgtmikwdakhyglels
npx supabase functions deploy query-transit-route --project-ref ihqkgtmikwdakhyglels
```

检查 Secret 是否存在：

```bash
npx supabase secrets list --project-ref ihqkgtmikwdakhyglels
```

也可以通过 Dashboard 的 Edge Functions 编辑器创建或更新 `query-transit-route`，但应以仓库内代码为准，避免线上代码和版本记录不一致。

### 4. 本地测试（选做）

复制 `supabase/.env.example` 为一个不会提交的本地文件，例如 `supabase/.env.local`，填入真实 Key 后运行：

```bash
npx supabase functions serve query-transit-route --env-file supabase/.env.local
```

AI 查询需要先登录 Life Tracker。函数会验证用户登录状态，限制请求长度和响应长度，并在 DeepSeek 不可用时让前端回退为手动填写。
