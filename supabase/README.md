# Supabase 运维入口

当前登录方式为邮箱6位验证码，不是Magic Link主流程。数据库、函数、配额和部署说明统一维护在以下文档，避免多份操作指引互相矛盾。

- [数据库表、字段、RLS与初始化](../docs/DATABASE.md)
- [API请求/响应和实际执行配额](../docs/API-CONTRACT.md)
- [SMTP、Secrets、部署、备份和回滚](../docs/DEPLOYMENT-ROLLBACK.md)
- [完整独立SQL参考](../docs/reference/SCHEMA-REFERENCE.md)
- [完整独立后端及OTP模板参考](../docs/reference/EDGE-REFERENCE.md)

空项目运行17个迁移，已有项目只运行未应用部分。V2最后7个增量包含全天/酒店、客户端CAS、航段版本、AI缓存恢复、原子限频、父计划反向约束与上海reset元数据修正；本次没有运行生产SQL。2026-10-02临时PG18的17迁移、旧数据升级、并发和权限验收已通过；发布前独立执行`node scripts/test-database-integrity.mjs`，并在测试Supabase补实际Auth/Storage/Deno集成验证。

真实秘密只配置到平台：AVIATIONSTACK_API_KEY、DEEPSEEK_API_KEY进入EdgeSecrets；ResendSMTP密码进入AuthSMTP设置。service_role不得进入VITE配置或公开仓库。

Owner绑定受控AuthUUID，不靠邀请码。原迁移中历史Owner/邀请哈希不应直接作为新项目身份初始化。全部步骤及新Owner授权SQL见数据库文档。
