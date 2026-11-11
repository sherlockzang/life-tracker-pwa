import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

// Read actual candidate sources; use only disposable fake IndexedDB and a
// deterministic receipt/CAS server substitute. Never contact Supabase or APIs.
const root = process.env.LIFE_TRACKER_AUDIT_SOURCE || process.cwd();
const require = createRequire(resolve(root, "package.json"));
const ts = require("typescript"), idb = require("idb");
const fake = require("fake-indexeddb");
for (const [key, value] of Object.entries(fake)) if (key.startsWith("IDB") || key === "indexedDB") globalThis[key] = value;
const stubs = new Map(), modules = new Map();
function load(file) {
  file = resolve(root, file); if (!/\.tsx?$/.test(file)) file += ".ts";
  if (stubs.has(file)) return stubs.get(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, Date, Intl, Error, TypeError, console, crypto, ...fake,
    require: dependency => dependency === "idb" ? idb : load(resolve(dirname(file), dependency)) }, { filename: file });
  return exports;
}
const oldDb = await idb.openDB("life-tracker", 2, { upgrade(db) { db.createObjectStore("snapshots", { keyPath: "userId" }); const store = db.createObjectStore("outbox", { keyPath: "id" }); store.createIndex("by-created", "createdAt"); store.createIndex("by-owner", "ownerId"); } });
const oldItem = { id: crypto.randomUUID(), ownerId: "old-v2", entityId: "old-record", table: "records", operation: "upsert", payload: { id: "old-record", user_id: "old-v2", content: "old" }, state: "pending", expectedUpdatedAt: null, dependsOn: null, createdAt: "2026-10-01T00:00:00Z" };
await oldDb.put("outbox", oldItem); oldDb.close();
const box = load("src/lib/offline.ts"), engine = load("src/lib/syncEngine.ts");
const upgraded = await box.queueMutation({ ownerId: "old-v2", table: "records", operation: "upsert", payload: { ...oldItem.payload, content: "edited" }, expectedUpdatedAt: null });
assert.equal(upgraded.dependsOn, oldItem.id, "Unknown v2 send history is preserved conservatively during v3 upgrade");
assert.equal((await box.listMutations("old-v2")).length, 2);
const cloud = new Map(), receipts = new Map(); let sequence = 0, loseResponse = false, rejectWrite = false;
const baseVersion = "2026-10-02T00:00:00.000Z";
function server(item) {
  const body = JSON.stringify([item.table, item.payload, item.expectedUpdatedAt]);
  const previousReceipt = receipts.get(item.id);
  if (previousReceipt) { assert.equal(previousReceipt.body, body); return previousReceipt.response; }
  const key = `${item.ownerId}:${item.entityId}`, previous = cloud.get(key);
  if ((previous?.updated_at || null) !== item.expectedUpdatedAt) return { data: { ok: false, code: "CONFLICT" }, error: null };
  const row = { ...item.payload, updated_at: new Date(Date.parse(baseVersion) + ++sequence * 1000).toISOString() };
  cloud.set(key, row);
  const response = { data: { ok: true, row }, error: null };
  receipts.set(item.id, { body, response });
  return response;
}
function adapter(ownerId) {
  return { currentOwner: async () => ownerId, claim: box.claimMutation, finish: box.finishMutation, fail: box.failMutation,
    write: async item => {
      if (rejectWrite) return { data: null, error: { code: "42501", message: "synthetic RLS rejection" } };
      const response = server(item);
      if (loseResponse) { loseResponse = false; throw new TypeError("Failed to fetch after server commit"); }
      return response;
    } };
}
const queue = (ownerId, id, content, expectedUpdatedAt = null) => box.queueMutation({ ownerId, table: "records", operation: "upsert", expectedUpdatedAt,
  payload: { id, user_id: ownerId, record_type: "note", content, event_at: baseVersion, updated_at: baseVersion, created_at: baseVersion, trip_id: null, parent_plan_id: null, transport_type: null, transport_details: null } });
const results = [];

// Positive control: receipt retry with the same UUID is correctly idempotent.
const control = await queue("control", "same-id", "v1"); loseResponse = true;
assert.equal((await engine.replayMutation(control, adapter("control"))).state, "pending");
assert.equal((await engine.replayMutation(control, adapter("control"))).state, "confirmed");
assert.equal((await box.listMutations("control")).length, 0);
results.push({ case: "control", observed: "same UUID retry confirms saved row" });

// SA-01: retain committed UUID, replay its receipt, then rebase the successor.
for (const existing of [false, true]) {
  const owner = existing ? "lost-update" : "lost-create", entity = "record";
  if (existing) cloud.set(`${owner}:${entity}`, { id: entity, user_id: owner, content: "v0", updated_at: baseVersion });
  const first = await queue(owner, entity, "v1", existing ? baseVersion : null);
  loseResponse = true;
  assert.equal((await engine.replayMutation(first, adapter(owner))).state, "pending");
  assert.equal(cloud.get(`${owner}:${entity}`).content, "v1");
  const second = await queue(owner, entity, "v2", existing ? baseVersion : null);
  assert.notEqual(second.id, first.id);
  assert.equal(second.dependsOn, first.id);
  assert.equal((await box.listMutations(owner)).some(item => item.id === first.id), true);
  assert.equal(await engine.replayMutation(second, adapter(owner)), null);
  modules.delete(resolve(root, "src/lib/offline.ts"));
  const reloaded = load("src/lib/offline.ts");
  const nextAdapter = { ...adapter(owner), claim: reloaded.claimMutation, finish: reloaded.finishMutation, fail: reloaded.failMutation };
  assert.equal((await engine.replayMutation(first, nextAdapter)).state, "confirmed");
  assert.equal((await engine.replayMutation(second, nextAdapter)).state, "confirmed");
  assert.equal(cloud.get(`${owner}:${entity}`).content, "v2");
  assert.equal((await box.listMutations(owner)).length, 0);
  results.push({ case: `SA-01-${existing ? "update" : "create"}`, observed: "receipt restored across reload; successor confirms v2 without false conflict" });
}

// SA-02: after a correction confirms, retain the rejected history without
// letting it override the newer cloud row on the next actual fetch.
const owner = "corrected", entity = "record";
cloud.set(`${owner}:${entity}`, { id: entity, user_id: owner, record_type: "note", content: "original", event_at: baseVersion, updated_at: baseVersion });
const rejected = await queue(owner, entity, "rejected old draft", baseVersion);
rejectWrite = true;
assert.equal((await engine.replayMutation(rejected, adapter(owner))).state, "failed");
rejectWrite = false;
const corrected = await queue(owner, entity, "corrected confirmed draft", "local-only-version");
assert.equal(corrected.expectedUpdatedAt, baseVersion, "Visible failed draft timestamp is not a cloud CAS version");
await box.retryFailedMutations(owner);
assert.equal((await box.listMutations(owner)).find(item => item.id === rejected.id).state, "failed", "Retry must not race the superseding correction");
assert.equal((await engine.replayMutation(corrected, adapter(owner))).state, "confirmed");
assert.equal((await box.listMutations(owner)).length, 1);
assert.equal((await box.listMutations(owner))[0].id, rejected.id);
assert.equal((await box.listMutations(owner))[0].supersededBy, corrected.id);
assert.equal(await box.claimMutation(rejected.id, owner), null);
await box.retryFailedMutations(owner);
assert.equal((await box.listMutations(owner))[0].state, "failed");
const client = {
  auth: { getSession: async () => ({ data: { session: { user: { id: owner }, access_token: "synthetic-session" } } }) },
  from(table) {
    let cursor;
    const chain = { select() { return chain; }, order() { return chain; }, limit() { return chain; }, eq() { return chain; }, is() { return chain; }, gt(_key, value) { cursor = value; return chain; },
      maybeSingle: async () => ({ data: table === "profiles" ? { user_id: owner } : { user_id: owner, theme: "dark", base_currency: "USD" }, error: null }),
      then(yes, no) { return Promise.resolve({ data: table === "records" && !cursor ? [cloud.get(`${owner}:${entity}`)] : [], error: null }).then(yes, no); } };
    return chain;
  }
};
stubs.set(resolve(root, "src/lib/supabase.ts"), { supabase: client });
const fetched = await load("src/lib/data.ts").fetchAppData({ id: owner, email: "synthetic@example.invalid", user_metadata: {} });
assert.equal(cloud.get(`${owner}:${entity}`).content, "corrected confirmed draft");
assert.equal(fetched.records[0].content, "corrected confirmed draft");
assert.equal((await box.loadSnapshot(owner)).records[0].content, "corrected confirmed draft");
results.push({ case: "SA-02", observed: "confirmed correction remains active in fetch/cache; old failed draft retained as non-retryable exportable history" });

// A failed correction does not archive its predecessor or hide either draft.
const failure = await queue("not-confirmed", "entity", "bad", null); rejectWrite = true;
await engine.replayMutation(failure, adapter("not-confirmed"));
const failure2 = await queue("not-confirmed", "entity", "correction", null);
await engine.replayMutation(failure2, adapter("not-confirmed")); rejectWrite = false;
assert.ok((await box.listMutations("not-confirmed")).every(item => !item.supersededBy));

// An external writer remains protected by CAS; correction cannot force overwrite.
cloud.set("foreign-writer:entity", { updated_at: baseVersion, content: "old" });
const denied = await queue("foreign-writer", "entity", "bad", baseVersion); rejectWrite = true;
await engine.replayMutation(denied, adapter("foreign-writer")); rejectWrite = false;
cloud.set("foreign-writer:entity", { updated_at: "2026-10-03T00:00:00Z", content: "other device" });
const correctedConflict = await queue("foreign-writer", "entity", "corrected", "local-only");
assert.equal((await engine.replayMutation(correctedConflict, adapter("foreign-writer"))).state, "conflict");
assert.equal(cloud.get("foreign-writer:entity").content, "other device");
assert.ok((await box.listMutations("foreign-writer")).every(item => !item.supersededBy));

const claims = await Promise.all(Array.from({ length: 20 }, () => box.claimAutomaticSummary("summary-owner", "same-context")));
assert.equal(claims.filter(Boolean).length, 1, "Cross-window admission is an IndexedDB transaction, not a localStorage race");
assert.equal(await load("src/lib/offline.ts").claimAutomaticSummary("summary-owner", "same-context"), false);
assert.equal(await box.claimAutomaticSummary("other-owner", "same-context"), true);
console.log("PASS SA-01/02/05: v2->v3 conservative upgrade, lost-response create/update recovery across reload, confirmed correction/history/cache, failed correction retained, foreign writer CAS, and atomic persistent account-scoped automatic-summary admission.");
