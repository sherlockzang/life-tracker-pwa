import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
const root = process.env.LIFE_TRACKER_AUDIT_SOURCE || process.cwd();
const require = createRequire(resolve(root, "package.json")), ts = require("typescript"), idb = require("idb"), fake = require("fake-indexeddb");
for (const [key, value] of Object.entries(fake)) if (key.startsWith("IDB") || key === "indexedDB") globalThis[key] = value;
const modules = new Map(), stubs = new Map();
function load(file) {
  file = resolve(root, file); if (!/\.tsx?$/.test(file)) file += ".ts";
  if (stubs.has(file)) return stubs.get(file); if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, Date, Intl, Error, TypeError, console, crypto, ...fake, require: name => name === "idb" ? idb : load(resolve(dirname(file), name)) });
  return exports;
}
const box = load("src/lib/offline.ts"), engine = load("src/lib/syncEngine.ts");
const v0 = "2026-10-03T00:00:00.000Z", cloud = new Map(); let sends = 0;
const queue = (owner, content, expected = v0) => box.queueMutation({ ownerId: owner, table: "records", operation: "upsert", expectedUpdatedAt: expected,
  payload: { id: "record", user_id: owner, content, record_type: "note", event_at: v0, updated_at: v0, created_at: v0, trip_id: null, parent_plan_id: null, transport_type: null, transport_details: null } });
function adapter(owner) {
  return { currentOwner: async () => owner, claim: box.claimMutation, finish: box.finishMutation, fail: box.failMutation,
    write: async item => { sends++; if (item.payload.content.length > 4000) return { data: null, error: { code: "23514", message: "content too long" } };
      const old = cloud.get(owner); if ((old?.updated_at || null) !== item.expectedUpdatedAt) return { data: { ok: false, code: "CONFLICT" }, error: null };
      const row = { ...item.payload, updated_at: new Date(Date.parse(v0) + sends * 1000).toISOString() }; cloud.set(owner, row); return { data: { ok: true, row }, error: null }; } };
}
// Control: a rejected leaf corrected after failure can still confirm.
cloud.set("control", { updated_at: v0, content: "cloud" });
const rejected = await queue("control", "x".repeat(4001));
assert.equal((await engine.replayMutation(rejected, adapter("control"))).state, "failed");
const correction = await queue("control", "corrected");
assert.equal((await engine.replayMutation(correction, adapter("control"))).state, "confirmed");
assert.equal(cloud.get("control").content, "corrected");

// R2-01: a correction already queued behind an inflight ancestor cannot repair
// that ancestor once the ancestor receives a permanent rejection.
cloud.set("chain", { updated_at: v0, content: "cloud" });
const a = await queue("chain", "x".repeat(4001));
const claimed = await box.claimMutation(a.id, "chain");
const b = await queue("chain", "valid edit during slow save"); assert.equal(b.dependsOn, a.id);
await box.failMutation(claimed, "failed", "content constraint rejected");
const c = await queue("chain", "valid latest correction");
assert.equal(c.dependsOn, null);
assert.deepEqual(Array.from(c.replacesFailed || []), [a.id]);
const before = sends;
for (const item of await box.listMutations("chain")) await engine.replayMutation(item, adapter("chain"));
assert.equal(sends, before + 1); assert.equal(cloud.get("chain").content, "valid latest correction");
await box.retryFailedMutations("chain");
for (const item of await box.listMutations("chain")) await engine.replayMutation(item, adapter("chain"));
assert.equal(cloud.get("chain").content, "valid latest correction");
assert.equal((await box.listMutations("chain")).find(item => item.id === a.id).state, "failed");

// R2-02: even a new edit deliberately based on the current cloud version can
// confirm but the old conflict is left active and overlays it on actual fetch.
cloud.set("conflict", { updated_at: v0, content: "cloud", id: "record", user_id: "conflict", record_type: "note", event_at: v0 });
const conflict = await queue("conflict", "old conflicting draft", "2026-10-02T00:00:00Z");
assert.equal((await engine.replayMutation(conflict, adapter("conflict"))).state, "conflict");
const reconciled = await queue("conflict", "explicitly reconciled draft", v0);
assert.equal(await engine.replayMutation(reconciled, adapter("conflict")), null, "Ordinary edits cannot silently resolve a conflict");
const inspected = await box.listMutations("conflict");
const resolution = await box.reconcileMutations(inspected, cloud.get("conflict"), "local");
assert.equal((await engine.replayMutation(resolution, adapter("conflict"))).state, "confirmed");
assert.equal(cloud.get("conflict").content, "explicitly reconciled draft");
const client = {
  auth: { getSession: async () => ({ data: { session: { user: { id: "conflict" }, access_token: "synthetic" } } }) },
  from(table) { let cursor; const chain = { select() { return chain; }, order() { return chain; }, limit() { return chain; }, eq() { return chain; }, is() { return chain; }, gt(_key, value) { cursor = value; return chain; },
    maybeSingle: async () => ({ data: table === "profiles" ? { user_id: "conflict" } : { user_id: "conflict", theme: "dark", base_currency: "USD" }, error: null }),
    then(yes, no) { return Promise.resolve({ data: table === "records" && !cursor ? [cloud.get("conflict")] : [], error: null }).then(yes, no); } }; return chain; }
};
stubs.set(resolve(root, "src/lib/supabase.ts"), { supabase: client });
const fetched = await load("src/lib/data.ts").fetchAppData({ id: "conflict", email: "synthetic@example.invalid", user_metadata: {} });
assert.equal(fetched.records[0].content, "explicitly reconciled draft");
assert.equal((await box.loadSnapshot("conflict")).records[0].content, "explicitly reconciled draft");
assert.ok((await box.listMutations("conflict")).every(item => item.supersededBy));

// Stale local review, unknown send state and a new cloud writer all fail closed.
cloud.set("race", { updated_at: v0, content: "cloud" });
const race = await queue("race", "draft", "stale");
await engine.replayMutation(race, adapter("race"));
const reviewed = await box.listMutations("race");
await queue("race", "new edit");
await assert.rejects(box.reconcileMutations(reviewed, cloud.get("race"), "cloud"), /已变化/);
const current = await box.listMutations("race");
const queued = await box.reconcileMutations(current, cloud.get("race"), "local");
cloud.set("race", { updated_at: "2026-10-04T00:00:00Z", content: "another device" });
assert.equal((await engine.replayMutation(queued, adapter("race"))).state, "conflict");
assert.equal(cloud.get("race").content, "another device");
assert.ok((await box.listMutations("race")).every(item => !item.supersededBy));
await box.reconcileMutations(await box.listMutations("race"), cloud.get("race"), "cloud");
assert.ok((await box.listMutations("race")).every(item => item.supersededBy));
const unknown = await queue("unknown", "may have committed"); await box.claimMutation(unknown.id, "unknown");
await assert.rejects(box.reconcileMutations(await box.listMutations("unknown"), null, "cloud"), /未确认/);
console.log("PASS R2-01/02: failed ancestor bypass, retained histories, explicit conflict review, confirmed fetch/cache, stale review/unknown send blocked, concurrent cloud CAS preserved, cloud choice archives without a write. Synthetic services only.");
