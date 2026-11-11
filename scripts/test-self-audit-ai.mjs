import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

// Execute the actual App daily-summary effect, with a rejecting AI substitute.
// No real AI, Supabase, HTTP requests or billed tokens are used.
const root = process.env.LIFE_TRACKER_AUDIT_SOURCE || process.cwd();
const require = createRequire(resolve(root, "package.json")), ts = require("typescript");
const idb = require("idb"), fake = require("fake-indexeddb");
for (const [key, value] of Object.entries(fake)) if (key.startsWith("IDB") || key === "indexedDB") globalThis[key] = value;
const offlineSource = resolve(root, "src/lib/offline.ts");
function loadOffline() {
  const exports = {};
  const code = ts.transpileModule(readFileSync(offlineSource, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, ...fake, crypto, Date, require: name => { assert.equal(name, "idb"); return idb; } });
  return exports;
}
let offline = loadOffline();
const file = resolve(root, "src/App.tsx"), source = readFileSync(file, "utf8");
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effectNode, dependencyNode;
function walk(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("summaryRequests.current.get(requestKey)")) {
    effectNode = node.arguments[0]; dependencyNode = node.arguments[1];
  }
  ts.forEachChild(node, walk);
}
walk(ast); assert.ok(effectNode);
assert.match(dependencyNode.getText(ast), /clockNow/);
assert.match(source, /setInterval\(\(\) => setClockNow\(new Date\(\)\), 30_000\)/);
const map = new Map(), summaryRequests = { current: map };
let calls = 0, dailySummary = "", shouldFail = true;
const globals = {
  exports: {}, user: { id: "synthetic-owner" }, data: { profile: { user_id: "synthetic-owner" }, records: [] },
  currentTrip: { id: "synthetic-trip", timezone: "Asia/Tokyo" }, validTimeZone: () => true, demoMode: false, online: true,
  plansForDay: () => [{ plan_status: "planned" }], tripToday: () => "2026-10-02", summaryContext: "unchanged-context",
  summaryRequests, generateDailySummary: async () => { calls++; if (shouldFail) throw new Error("synthetic upstream failure"); return { result: "synthetic successful summary" }; },
  claimAutomaticSummary: (...args) => offline.claimAutomaticSummary(...args), loadAutomaticSummary: (...args) => offline.loadAutomaticSummary(...args), saveAutomaticSummary: (...args) => offline.saveAutomaticSummary(...args), activeOwner: { current: "synthetic-owner" },
  setDailySummary: value => { dailySummary = value; }, showToast() {}
};
const code = ts.transpileModule(`export const run = ${effectNode.getText(ast)}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const context = { ...globals, clockNow: new Date("2026-10-02T00:00:00Z"), dailySummary };
runInNewContext(code, context, { filename: file });
const observations = [];
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
for (const second of [0, 30, 60]) {
  context.clockNow = new Date(Date.parse("2026-10-02T00:00:00Z") + second * 1000);
  context.dailySummary = dailySummary;
  const cleanup = context.exports.run();
  await settle();
  assert.equal(map.size, 0, "Failure removes single-flight entry");
  assert.equal(dailySummary, "");
  observations.push({ second, calls, summary: dailySummary });
  cleanup?.();
}
assert.equal(calls, 1, "Failure does not trigger automatic retries on 30-second ticks");
// Reloading the module/window preserves admission history, not just in-memory single flight.
offline = loadOffline(); context.summaryRequests = { current: new Map() };
context.exports.run(); await settle(); assert.equal(calls, 1);
// Positive control: a new day's context can generate a summary once.
shouldFail = false; context.dailySummary = dailySummary; context.summaryContext = "next-day-context";
context.exports.run(); await settle();
assert.equal(calls, 2); assert.equal(dailySummary, "synthetic successful summary");
context.dailySummary = dailySummary;
assert.equal(context.exports.run(), undefined); assert.equal(calls, 2);
// Another account is isolated; an account switch during asynchronous admission must not send AI.
context.dailySummary = ""; context.summaryContext = "switched-context";
context.activeOwner.current = "other-owner";
context.exports.run(); await settle(); assert.equal(calls, 2);
context.user = { id: "other-owner" }; context.data.profile.user_id = "other-owner";
context.exports.run(); await settle(); assert.equal(calls, 3);
// Manual retry remains an explicit Settings action, not a background timer.
assert.match(readFileSync(resolve(root, "src/components/SettingsPanel.tsx"), "utf8"), /await generateDailySummary\(summaryContext\)/);
console.log(JSON.stringify({ sourceRoot: root, case: "SA-05", mode: "actual AST-extracted App effect + rejecting AI mock; no billed API calls", observations,
  result: "PASS: one failed automatic attempt, no clock/reload retry, new context admitted, account switch blocked, other account isolated; explicit Settings retry available",
  limitation: "Disposable IndexedDB and synthetic upstream only; no real provider or iOS browser exercised" }, null, 2));
