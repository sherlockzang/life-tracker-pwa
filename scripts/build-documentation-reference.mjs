import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import { readReference } from "./restore-documentation-reference.mjs";

// Mechanical, deterministic source archives only. Never read .env.local,
// node_modules, Git internals, uploads, credentials or runtime data.
const root = process.cwd();
const dateIndex = process.argv.indexOf("--date");
const snapshotDate = dateIndex >= 0 ? process.argv[dateIndex + 1] : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate || "") || new Date(`${snapshotDate}T12:00:00Z`).toISOString().slice(0, 10) !== snapshotDate) throw new Error("--date must be a valid YYYY-MM-DD date");
const sections = new Map(["SCHEMA", "EDGE", "DOMAIN", "FRONTEND", "ASSET"].map(name => [name, []]));
const directoryFiles = directory => {
  const result = [];
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing source symlink: ${directory}/${entry.name}`);
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...directoryFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
};
for (const path of directoryFiles("src")) sections.get(path.startsWith("src/components/") || path === "src/App.tsx" || path.startsWith("src/styles") ? "FRONTEND" : "DOMAIN").push(path);
sections.get("SCHEMA").push(...directoryFiles("supabase/migrations"));
sections.get("EDGE").push(...directoryFiles("supabase/functions"), ...directoryFiles("supabase/templates"));
sections.get("DOMAIN").push(...directoryFiles("scripts"), ...directoryFiles(".github"),
  ".gitignore", ".env.example", "package.json", "package-lock.json", "index.html", "vite.config.ts", "eslint.config.mjs",
  "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "supabase/config.toml", "supabase/.env.example");
sections.get("ASSET").push(...directoryFiles("public"));

const titles = { SCHEMA: "完整有序数据库迁移", EDGE: "完整后端与验证码邮件模板", DOMAIN: "领域、字典、配置与测试", FRONTEND: "完整界面与样式", ASSET: "正式图标二进制" };
const language = path => ({ ".ts": "typescript", ".tsx": "tsx", ".mjs": "javascript", ".js": "javascript", ".sql": "sql", ".json": "json", ".toml": "toml", ".html": "html", ".css": "css", ".yml": "yaml" })[extname(path)] || "text";
const generated = new Map();
const seen = new Set();
for (const [name, paths] of sections) {
  let text = `# ${titles[name]}精确参考\n\n快照：${snapshotDate}，V2.1.0 本地候选工作树，未声明部署。由 build-documentation-reference.mjs 机械生成；每块保存原始字节和 SHA256。\n\n先读[验收记录](../ACCEPTANCE-2026-10-01.md)、[重建规范](../REBUILD-SPEC.md)和[恢复流程](../DEPLOYMENT-ROLLBACK.md)。这是代码快照，不保证所有发布门禁已完成。SQL 含历史身份种子，新项目先安全替换。包中无云端历史数据、用户上传图片或服务私钥。\n`;
  for (const path of paths) {
    if (seen.has(path) || path.includes(".env.local") || /(?:^|\/)node_modules(?:\/|$)/.test(path)) throw new Error(`Duplicate or unsafe path: ${path}`);
    seen.add(path);
    const bytes = readFileSync(resolve(root, path));
    const binary = name === "ASSET";
    const body = bytes.toString(binary ? "base64" : "utf8");
    if (!binary && (!Buffer.from(body).equals(bytes) || /^`{4}/m.test(body))) throw new Error(`Unsafe source encoding/fence: ${path}`);
    if (/(?:\bsk-[A-Za-z0-9]{20,}|\bre_[A-Za-z0-9]{20,})/.test(body)) throw new Error(`Possible private key in source: ${path}`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    text += `\n## ${path}\n\n<!-- source: ${path} sha256: ${hash} encoding: ${binary ? "base64" : "utf8"} -->\n\x60\x60\x60\x60${binary ? "base64" : language(path)}\n${body}\n\x60\x60\x60\x60\n`;
  }
  generated.set(`${name}-REFERENCE.md`, text);
}
if (!process.argv.includes("--write")) {
  console.log(`Dry run: ${seen.size} source/asset files selected. Use --write to refresh five reference Markdown files.`);
} else {
  const destination = resolve(root, "docs/reference");
  mkdirSync(destination, { recursive: true });
  for (const [name, text] of generated) writeFileSync(resolve(destination, name), text);
  if (readReference(destination).size !== seen.size) throw new Error("Generated reference is incomplete");
  console.log(`Refreshed and verified ${seen.size} exact source/asset snapshots.`);
}
