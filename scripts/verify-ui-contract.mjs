// Read-only contracts for approved V2 presentation and R01–R10 reliability changes.
// This is not a substitute for database/runtime tests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const baseline = "stable-before-v2.0.0";
const before = path => execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" });
const after = path => readFileSync(path, "utf8");
const files = execFileSync("git", ["ls-tree", "-r", "--name-only", baseline], { encoding: "utf8" }).trim().split("\n");
// Explicitly approved reliability surfaces; everything else in the domain/backend
// guard remains frozen, especially login, entitlement and invitation endpoints.
const reliability = new Set([
  "src/components/HomeRouteSearch.tsx", "supabase/functions/owner-admin/index.ts", // R2-04/05 DST choice and complete pagination, no entitlement policy change.
  "src/lib/offline.ts", "src/lib/data.ts", "src/lib/flightLookup.ts", "src/lib/transport.ts", "src/types.ts",
  "src/lib/ai.ts", "supabase/functions/lookup-flight/index.ts",
  "src/lib/tripDates.ts", // SA-04 strict non-flight DST resolution, same Auth/quota policy.
  "src/components/QuickComposer.tsx",
  "supabase/functions/deepseek-assist/index.ts", "supabase/functions/_shared/api.ts",
  "supabase/functions/get-api-quota/index.ts", // F05/F06 read errors / Shanghai reset dates; no policy change.
]);
let checked = 0;
for (const path of files) {
  const guarded = path.startsWith("src/lib/") && path !== "src/lib/releaseNotes.ts"
    || path.startsWith("supabase/") && !path.endsWith(".md")
    || ["src/types.ts", "src/main.tsx", "vite.config.ts", "index.html"].includes(path)
    || path.startsWith("public/")
    || ["src/components/QuickComposer.tsx", "src/components/HomeRouteSearch.tsx"].includes(path);
  if (guarded && !reliability.has(path)) {
    assert.equal(after(path), before(path), `Protected baseline changed: ${path}`);
    checked++;
  }
}
function functions(source) {
  const ast = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return Object.fromEntries(ast.statements.filter(ts.isFunctionDeclaration).map(statement => [statement.name.text, statement]));
}
const printer = ts.createPrinter({ removeComments: true });
function logicPrefixes(source) {
  const ast = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return Object.fromEntries(Object.values(functions(source)).filter(statement => statement.body).map(statement => {
    const at = statement.body.statements.findIndex(item => ts.isReturnStatement(item));
    const prefix = statement.body.statements.slice(0, at < 0 ? undefined : at);
    return [statement.name.text, prefix.map(item => printer.printNode(ts.EmitHint.Unspecified, item, ast)).join("\n")];
  }));
}
assert.deepEqual(logicPrefixes(after("src/components/LoginScreen.tsx")), logicPrefixes(before("src/components/LoginScreen.tsx")), "OTP send/verify handlers changed");
const approvedSummarySettings = after("src/components/SettingsPanel.tsx")
  .replace("generateDailySummary(summaryContext)", "generateDailySummary()")
  .replace('[result.result, result.warning].filter(Boolean).join("\\n\\n")', "result.result");
assert.deepEqual(logicPrefixes(approvedSummarySettings), logicPrefixes(before("src/components/SettingsPanel.tsx")), "Settings owner/profile handlers changed beyond approved summary calendar/warning");
function firstAuthEffect(source) {
  const ast = ts.createSourceFile("app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const app = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "App");
  const effect = app.body.statements.find(item => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression) && item.expression.expression.getText(ast) === "useEffect");
  assert.ok(effect?.getText(ast).includes("onAuthStateChange"), "First effect must still manage the Auth session");
  return printer.printNode(ts.EmitHint.Unspecified, effect, ast);
}
assert.equal(firstAuthEffect(after("src/App.tsx")), firstAuthEffect(before("src/App.tsx")), "Session/foreground Auth recovery changed");
const prior = JSON.parse(before("package.json")), current = JSON.parse(after("package.json"));
assert.deepEqual(current.engines, prior.engines, "Node engine changed without compatibility review");
assert.deepEqual(current.scripts, prior.scripts, "Build/development entry points changed");
assert.deepEqual(current.overrides, prior.overrides, "Dependency overrides require explicit review");
const approvedTestTools = { "embedded-postgres": "18.4.0-beta.17", "pg": "8.23.1", "fake-indexeddb": "6.2.5" };
for (const field of ["dependencies", "devDependencies"]) {
  const extras = Object.keys(current[field]).filter(name => !Object.hasOwn(prior[field], name));
  for(const name of extras) assert.equal(field === "devDependencies" ? approvedTestTools[name] : undefined, current[field][name], `Unapproved package addition in ${field}: ${name}`);
  assert.deepEqual(Object.keys(current[field]).filter(name=>!extras.includes(name)).sort(), Object.keys(prior[field]).sort(), `Unapproved package removal in ${field}`);
  for (const name of Object.keys(prior[field])) {
    const major = value => Number(value.match(/\d+/)?.[0]);
    assert.equal(major(current[field][name]), major(prior[field][name]), `Unreviewed dependency major upgrade: ${name}`);
  }
}
assert.equal(current.version, "2.0.0");
assert.ok(after("src/components/SettingsPanel.tsx").includes("Built with the help of Codex, with special thanks to Claude for prompt design and development support."));
assert.equal(after("src/styles/tokens.css").match(/--accent:\s*([^;]+);/)[1].toLowerCase(), "#0a84ff");
for (const path of ["src/styles.css", "src/components/ExpenseStats.tsx"]) assert.ok(!/#[\da-f]{3,8}\b/i.test(after(path)), `Uncentralized visual color: ${path}`);
assert.ok(after("src/styles.css").includes("env(safe-area-inset-top)"));
assert.ok(after("vite.config.ts").includes('registerType: "autoUpdate"'));
assert.ok(after("src/lib/data.ts").includes("save_user_mutation"), "CAS save RPC must not be replaced by blind upsert");
assert.ok(after("src/lib/offline.ts").includes('"by-owner"'), "Owner-partitioned outbox index required");
assert.ok(after("src/lib/syncEngine.ts").includes('data?.code === "CONFLICT"'), "Conflict cannot masquerade as a confirmed write");
console.log(`PASS: ${checked} protected baseline files, immutable historical migrations, OTP/owner/profile/Auth handlers, PWA identity/icons, exact accent token, explicit reliability allowlist and same-major dependencies.`);
