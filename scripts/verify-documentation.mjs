import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { createHash } from "node:crypto";
import { readReference } from "./restore-documentation-reference.mjs";

const root = process.cwd();
const docs = ["README.md", "supabase/README.md"];
function walk(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const next = resolve(path, entry.name);
    if (entry.isDirectory()) walk(next);
    else if (extname(next) === ".md") docs.push(next);
  }
}
walk(resolve(root, "docs"));
let links = 0;
for (const path of docs) {
  const text = readFileSync(resolve(root, path), "utf8");
  // Snapshot code is opaque data; validate narrative links only.
  const narrative = text.replace(/^\x60{4}[^\n]*\n[\s\S]*?^\x60{4}$/gm, "").replace(/^\x60{3}[^\n]*\n[\s\S]*?^\x60{3}$/gm, "");
  for (const match of narrative.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "").split("#")[0];
    if (!target || /^[a-z]+:\/\//i.test(target) || target.startsWith("#")) continue;
    assert(existsSync(resolve(dirname(resolve(root, path)), target)), `Broken doc link in ${path}: ${target}`);
    links++;
  }
  assert(!/\b(?:sk-[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,})\b/.test(narrative), `Possible private API key in ${path}`);
}
const entries = readReference(resolve(root, "docs/reference"));
for (const [path, entry] of entries) {
  const source = readFileSync(resolve(root, path));
  assert.equal(createHash("sha256").update(source).digest("hex"), entry.sha256, `Stale snapshot: ${path}`);
}
const required = ["ARCHITECTURE", "REBUILD-SPEC", "DATABASE", "API-CONTRACT", "DEPLOYMENT-ROLLBACK", "USER-GUIDE", "CODE-REVIEW-2026-10-01"];
for (const name of required) assert(existsSync(resolve(root, `docs/${name}.md`)));
const api = readFileSync(resolve(root, "docs/API-CONTRACT.md"), "utf8");
for (const name of ["lookup-flight", "deepseek-assist", "start-demo-session", "redeem-invite", "get-api-quota", "owner-admin", "query-transit-route"]) assert(api.includes(name));
for (const value of ["10000", "15次", "80次", "100次", "2次"]) assert(api.includes(value), `Missing quota: ${value}`);
console.log(`Documentation passed: ${docs.length} Markdown files, ${links} local links, ${entries.size} source/asset snapshots verified.`);
