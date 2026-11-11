# 依赖安全审计

日期：2026-10-01。对象：V2.0.0本地候选工作树。记录首次授权审计及维护者随后要求继续修复后的兼容更新；未上传源码、业务数据或密钥，未提交、部署或请求生产。安装脚本始终禁用，未使用force。

## 执行与结果

Node26.3.1，npm11.16.0，官方registry `https://registry.npmjs.org`。

```bash
npm audit --json --registry=https://registry.npmjs.org
npm audit --omit=dev --json --registry=https://registry.npmjs.org
```

| 范围 | 受影响包 | 严重级别 | 退出码 |
| --- | --- | --- | --- |
| 修复前完整依赖树 | 9 | 7高、1中、1低；无critical | 1（成功取得报告，但存在公告） |
| 修复前仅生产依赖 | 0 | 无命中 | 0 |
| 修复后完整依赖树 | 0 | 无命中 | 0 |
| 修复后仅生产依赖 | 0 | 无命中 | 0 |

9指修复前受影响的包名数量，不是只有9条独立漏洞公告。以下全部在锁文件中标记为dev依赖；首次报告对每个包都显示fixAvailable=true。更新后已重新安装锁定版本并运行回归，不仅依赖这一标志。

| 包 | 修复前 → 修复后锁定版本 | 修复前npm级别 | 主要公告示例 |
| --- | --- | --- | --- |
| @babel/core | 7.29.0 → 7.29.7 | low | [sourceMappingURL本地文件读取](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8) |
| baseline-browser-mapping | 2.10.30 → 2.11.26 | moderate | [非法输入造成进程终止](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv) |
| brace-expansion | 1.1.14 / 2.1.2 / 5.0.6 / 5.0.7 → 1.1.21 / 2.1.7 / 5.0.12 / 5.0.12 | high | [嵌套展开递归耗尽](https://github.com/advisories/GHSA-qhr7-859c-m2p7)等多条DoS公告 |
| browserslist | 4.28.2 → 4.29.3 | high | [不可信统计输入导致崩溃/原型写入](https://github.com/advisories/GHSA-73wf-gq98-2v4g) |
| fast-uri | 3.1.2 → 3.1.8 | high | [URL权限部分注入](https://github.com/advisories/GHSA-qw65-cvwx-89v3)等解析差异公告 |
| js-yaml | 4.1.1 → 4.3.2 | high | [合并键限制绕过导致CPU耗尽](https://github.com/advisories/GHSA-2883-xcg3-v3hh) |
| nanoid | 3.3.12 → 3.3.19 | high | [自定义生成器零长度死循环](https://github.com/advisories/GHSA-2v37-7h3g-55p8) |
| postcss | 8.5.14 → 8.5.28 | high | [source map路径遍历读取](https://github.com/advisories/GHSA-r28c-9q8g-f849) |
| vite | 8.0.13 → 8.3.1 | high | [Windows替代路径绕过server.fs.deny](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) |

## 解释与发布要求

生产依赖0命中仅表示npm当时的公告库与本次范围没有报告受影响包，不能等同于整站零漏洞。开发/构建链可能处理不可信源码、配置、路径或依赖输入，仍应修复；开发服务器也不是可以公开暴露的安全服务。npm审计不覆盖Supabase数据库策略、Deno/jsr后端导入、业务逻辑、OTP流程或真实iPhonePWA。

首次授权仅安全审计；维护者随后明确要求继续处理，才执行`npm audit fix --package-lock-only --ignore-scripts`及`npm ci --ignore-scripts`。锁文件仅开发/构建链发生版本更新，业务生产依赖无变更。Vite最低范围提高到^8.3.1，仍Vite8；Node engines、dev/build/preview脚本、三项精确数据库/IDB测试工具不变，没有新增业务依赖或overrides。Rolldown随Vite兼容更新到1.2.12，仍支持Node22.13+。

兼容升级后生产/完整审计均退出0，lint、构建、七组回归、UI合同与真实本地PG18验收通过；PWA的base/scope/start_url、正式图标、导航fallback与七天汇率缓存也核对一致。快照与全新目录恢复演练以最终[修复验收](ACCEPTANCE-2026-10-01.md)为准。安装仍提示glob11.1.0/source-map beta弃用警告；弃用警告与本次audit漏洞数不是同一概念，不能隐瞒警告，也不以它推翻当前0命中报告。

审计0命中不是整个应用绝对安全；真实平台/供应商/真机门禁继续保留。其他修复与最终文件数量以[修复验收](ACCEPTANCE-2026-10-01.md)及[独立审查交接单](INDEPENDENT-REVIEW-HANDOFF.md)为准。
