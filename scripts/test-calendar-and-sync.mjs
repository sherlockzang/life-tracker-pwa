import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import path from "node:path";
import * as idb from "idb";
import ts from "typescript";

// Only disposable IndexedDB data and pure/mock writes; no Supabase or upstream API.
const toolsPath = process.env.LIFE_TRACKER_TEST_TOOLS || "/private/tmp/life-tracker-audit-tools-20261001/node_modules";
const fake = await import("fake-indexeddb").catch(error => {
  if(error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return import(pathToFileURL(path.join(toolsPath, "fake-indexeddb/build/esm/index.js")));
});
for (const [key, value] of Object.entries(fake)) if (key.startsWith("IDB") || key === "indexedDB") globalThis[key] = value;
const modules = new Map();
let frozenNow;
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : frozenNow == null ? [] : [frozenNow])); }
  static now() { return frozenNow ?? Date.now(); }
}
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const exports = {};
  const code = ts.transpileModule(readFileSync(name === "flightTime" ? "supabase/functions/_shared/flightTime.ts" : `src/lib/${name}.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, Date: TestDate, Intl, crypto, TypeError, Error, console, ...fake, require: dependency => dependency === "idb" ? idb : load(dependency.endsWith("_shared/flightTime") ? "flightTime" : dependency.slice(2)) });
  modules.set(name, exports);
  return exports;
}

const calendar = load("calendar"), match = load("flightMatchState"), engine = load("syncEngine");
const trip = { id: "trip", timezone: "America/Los_Angeles", start_date: "2026-10-01", end_date: "2026-11-05" };
assert.equal(calendar.tripToday(trip, new Date("2026-10-01T02:00:00Z")), "2026-09-30");
assert.equal(calendar.tripToday({ timezone: "Asia/Tokyo" }, new Date("2026-10-01T02:00:00Z")), "2026-10-01");
assert.equal(calendar.validTimeZone("Invalid/Zone"),false);
assert.equal(calendar.tripToday({timezone:"Invalid/Zone"},new Date("2026-10-01T02:00:00Z")),"2026-10-01","Legacy invalid timezone uses explicit UTC fallback instead of crashing");
assert.equal(calendar.activeTrip([trip], new Date("2026-10-01T02:00:00Z")), undefined);
assert.equal(calendar.tripDayNumber({ ...trip, start_date: "2026-11-01" }, new Date("2026-11-02T08:01:00Z")), 2, "DST fallback is one calendar day, not 25-hour rounding");
assert.equal(calendar.tripDayNumber({ ...trip, start_date: "2026-03-08" }, new Date("2026-03-09T07:01:00Z")), 2, "DST forward is one calendar day");
const record = (id, event_at, extra = {}) => ({ id, user_id: "A", record_type: "trip", content: id, event_at, trip_id: trip.id, plan_status: "planned", ...extra });
const stop = (date, time, timezone, iata) => ({ date, time, timezone, iata, airport: iata, terminal: "" });
const flight = { airline: "ANA", flight_number: "NH105", departure: stop("2026-09-28", "00:50", "America/Los_Angeles", "LAX"), arrival: stop("2026-09-29", "05:00", "Asia/Tokyo", "HND"), seat: "22A" };
const groups = calendar.groupTimeline([
  record("30", "2026-09-30T10:00:00Z", { record_type: "note", trip_id: null }),
  record("28", "2026-09-29T08:00:00Z", { transport_type: "flight", transport_details: flight }),
  record("29", "2026-09-29T00:00:00Z", { record_type: "note", trip_id: null }),
], "UTC");
assert.equal(groups.map(([date]) => date).join(","), "2026-09-30,2026-09-29,2026-09-28");
const hotel = record("hotel", "2026-09-30T15:00:00Z", { schedule_details: { kind: "hotel", start_date: "2026-10-01", end_date: "2026-10-03", timezone: "Asia/Tokyo", title: "Stay", location: "Tokyo" } });
assert.equal(calendar.plansForDay([hotel], { ...trip, timezone: "Asia/Tokyo" }, "2026-10-02").length, 1, "Hotel continuation is present");
const inboundTrip = { ...trip, timezone: "Asia/Tokyo", start_date: "2026-09-29" };
assert.equal(calendar.plansForDay([record("inbound", "2026-09-28T07:50:00Z", { transport_type: "flight", transport_details: flight })], inboundTrip, "2026-09-29").length, 1);
assert.equal(calendar.plansForDay([record("cancelled", "2026-10-01T12:00:00Z", { plan_status: "cancelled" })], trip, "2026-10-01").length, 0);

const matched = record("flight", "2026-09-28T07:50:00Z", { transport_type: "flight", transport_details: flight, flight_plan_version: 4, actual_match_plan_version: 4, actual_info_matched: true, actual_info: { flight_number: "NH105", departure: { iata: "LAX", scheduled: { date: "2026-09-28" } }, arrival: { iata: "HND" } } });
assert.equal(match.flightMatchIsCurrent(matched), true);
assert.equal(match.flightMatchIsCurrent({ ...matched, flight_plan_version: 5 }), false);
assert.equal(match.invalidateChangedFlight(matched, { ...matched, transport_details: { ...flight, seat: "18K" } }).actual_info_matched, true);
for (const changed of [{ ...flight, flight_number: "NH999" }, { ...flight, departure: { ...flight.departure, time: "01:50" } }, { ...flight, arrival: { ...flight.arrival, iata: "NRT" } }]) assert.equal(match.invalidateChangedFlight(matched, { ...matched, transport_details: changed }).actual_info_matched, false);

// Legacy entries are quarantined, including entries without an attributable owner.
const old = await idb.openDB("life-tracker", 1, { upgrade(db) { db.createObjectStore("snapshots", { keyPath: "userId" }); const box = db.createObjectStore("outbox", { keyPath: "id" }); box.createIndex("by-created", "createdAt"); } });
await old.put("outbox", { id: "legacy-A", table: "records", operation: "upsert", payload: { id: "old", user_id: "A", content: "old offline" }, createdAt: "2020-01-01" });
await old.put("outbox", { id: "legacy-unknown", table: "records", operation: "upsert", payload: { id: "unknown" }, createdAt: "2020-01-01" });
old.close();
const box = load("offline");
await box.saveSnapshot({userId:"A",records:[{content:"A private cache"}],savedAt:"2026-10-01"});
await box.saveSnapshot({userId:"B",records:[{content:"B private cache"}],savedAt:"2026-10-01"});
assert.equal((await box.loadSnapshot("A")).records[0].content,"A private cache");
assert.equal((await box.loadSnapshot("B")).records[0].content,"B private cache");
assert.equal((await box.listMutations("A"))[0].legacy, true);
assert.equal((await box.listMutations(""))[0].state, "failed");
await box.retryFailedMutations("A");
assert.equal((await box.listMutations("A"))[0].state, "failed");
await assert.rejects(box.queueMutation({ ownerId: "B", table: "records", operation: "upsert", payload: { id: "cross", user_id: "A" }, expectedUpdatedAt: null }), /其他账号/);

const queue = (ownerId, id, content, expectedUpdatedAt = null) => box.queueMutation({ ownerId, table: "records", operation: "upsert", payload: { user_id: ownerId, id, content }, expectedUpdatedAt });
const a = await queue("A", "a", "A draft"), b = await queue("B", "b", "B draft");
assert.equal((await box.listMutations("B")).length, 1);
assert.equal((await box.listMutations("B"))[0].id, b.id);
let owner = "B", writes = 0;
const adapter = { currentOwner: async () => owner, claim: box.claimMutation, finish: box.finishMutation, fail: box.failMutation, write: async item => { writes++; return { data: { ok: true, row: { ...item.payload, updated_at: "2026-10-01T00:00:01.000Z" } }, error: null }; } };
assert.equal(await engine.replayMutation(a, adapter), null);
assert.equal(writes, 0, "Wrong account is not sent to the server");
assert.equal((await engine.replayMutation(b, adapter)).state, "confirmed");
assert.equal((await box.listMutations("B")).length, 0);
owner = "A";
const rls = await engine.replayMutation(a, { ...adapter, write: async () => ({ data: null, error: { code: "42501", message: "RLS denied" } }) });
assert.equal(rls.state, "failed"); assert.match(rls.error, /权限/);
const good = await queue("A", "good", "good");
assert.equal((await engine.replayMutation(good, adapter)).state, "confirmed", "A permanent failure does not block a different record");
const network = await queue("A", "network", "offline");
assert.equal((await engine.replayMutation(network, { ...adapter, write: async () => { throw new TypeError("Failed to fetch"); } })).state, "pending");
const conflict = await queue("A", "conflict", "local v1", "v1");
assert.equal((await engine.replayMutation(conflict, { ...adapter, write: async () => ({ data: { ok: false, code: "CONFLICT" }, error: null }) })).state, "conflict");
assert.equal((await box.listMutations("A")).find(item => item.id === conflict.id).payload.content, "local v1");

const first = await queue("A", "chain", "first", "old-version");
const coalesced = await queue("A", "chain", "second", "bogus-version");
assert.notEqual(coalesced.id, first.id); assert.equal(coalesced.expectedUpdatedAt, "old-version");
const claimed = await box.claimMutation(coalesced.id, "A");
assert.ok(claimed); assert.equal(await box.claimMutation(coalesced.id, "A"), null, "Only one tab can claim a mutation");
const child = await queue("A", "chain", "third", "old-version");
assert.equal(child.dependsOn, coalesced.id); assert.equal(await box.claimMutation(child.id, "A"), null);
await box.finishMutation(claimed, { updated_at: "new-version" });
const next = (await box.listMutations("A")).find(item => item.id === child.id);
assert.equal(next.dependsOn, null); assert.equal(next.expectedUpdatedAt, "new-version");

// Timestamp ties must not reorder dependencies, nor may coalescing erase a parent.
frozenNow=Date.parse("2026-10-01T10:00:00Z");
const tieParent=await queue("A","tied-chain","parent","v0");
const tieClaimed=await box.claimMutation(tieParent.id,"A");
const tieChild=await queue("A","tied-chain","child","v0");
const tieLast=await queue("A","tied-chain","last","v0");
assert.equal(tieLast.dependsOn,tieParent.id,"Coalescing the pending leaf preserves its inflight parent");
assert.equal((await box.listMutations("A")).some(item=>item.id===tieChild.id),false,"Unsent leaf is replaced by latest draft without an extra cloud write");
assert.ok(tieLast.createdAt>tieParent.createdAt,"Queue timestamps remain monotonic under a frozen/same-millisecond clock");
await box.failMutation(tieClaimed,"pending","offline after send");
const tieNewest=await queue("A","tied-chain","newest","v0");
const tieItems=(await box.listMutations("A")).filter(item=>item.entityId==="tied-chain");
for(const item of tieItems) if(item.dependsOn) assert.ok(tieItems.some(parent=>parent.id===item.dependsOn),"Coalescing must not orphan a dependent edit");
assert.equal(tieNewest.dependsOn,tieParent.id);
assert.ok(tieItems.some(item=>item.id===tieParent.id),"A pending parent with a child must not be coalesced away");
frozenNow=undefined;

// F02: foreign-entity prerequisites survive edits, reload and same-clock queues.
frozenNow=Date.parse("2026-10-02T10:00:00Z");
const relationalQueue = (table,id,payload,expectedUpdatedAt=null) => box.queueMutation({ownerId:"relations",table,operation:"upsert",payload:{id,user_id:"relations",...payload},expectedUpdatedAt});
const parentTrip=await relationalQueue("trips","new-trip",{name:"before"});
const parentPlan=await relationalQueue("records","new-plan",{trip_id:"new-trip",content:"plan"});
await relationalQueue("trips","new-trip",{name:"after"},"local-clock");
const actual=await relationalQueue("records","new-note",{trip_id:"new-trip",parent_plan_id:"new-plan",content:"actual"});
await relationalQueue("records","new-plan",{trip_id:"new-trip",content:"updated plan"},"local-clock");
assert.ok(parentPlan.relationDependencies.includes(parentTrip.id));
assert.ok(actual.relationDependencies.includes(parentPlan.id));
modules.delete("offline"); // New module/DB connection reads the durable dependencies.
const reloadedBox=load("offline"), cloud=new Map(), relationalWrites=[];
const relationalAdapter={currentOwner:async()=>"relations",claim:reloadedBox.claimMutation,finish:reloadedBox.finishMutation,fail:reloadedBox.failMutation,write:async item=>{
  relationalWrites.push(item);
  if(item.table==="records" && (!cloud.has(`trips:${item.payload.trip_id}`)||(item.payload.parent_plan_id&&!cloud.has(`records:${item.payload.parent_plan_id}`)))) return {data:null,error:{code:"P0001",message:"missing relation"}};
  const key=`${item.table}:${item.entityId}`,previous=cloud.get(key);
  assert.equal(item.expectedUpdatedAt,previous?.updated_at||null,"Only the same entity supplies CAS, never a foreign parent timestamp");
  const row={...item.payload,updated_at:`cloud-version-${relationalWrites.length}`};cloud.set(key,row);return {data:{ok:true,row},error:null};
}};
for(const item of await reloadedBox.listMutations("relations")) await engine.replayMutation(item,relationalAdapter);
assert.equal((await reloadedBox.listMutations("relations")).length,0);
assert.equal(cloud.get("trips:new-trip").name,"after");assert.equal(cloud.get("records:new-plan").content,"updated plan");
assert.ok(cloud.has("records:new-note"));
const blockedTrip=await relationalQueue("trips","blocked-trip",{name:"blocked"});
const blockedClaim=await reloadedBox.claimMutation(blockedTrip.id,"relations");
const blockedPlan=await relationalQueue("records","blocked-plan",{trip_id:"blocked-trip"});
assert.equal(await reloadedBox.claimMutation(blockedPlan.id,"relations"),null,"Inflight/leased parent blocks the child instead of causing FK failure");
await reloadedBox.failMutation(blockedClaim,"failed","RLS");
assert.equal(await reloadedBox.claimMutation(blockedPlan.id,"relations"),null,"Failed parent waits for explicit recovery");
await reloadedBox.retryFailedMutations("relations");
for(const item of await reloadedBox.listMutations("relations")) await engine.replayMutation(item,relationalAdapter);
assert.equal((await reloadedBox.listMutations("relations")).length,0);
const leasedTrip=await relationalQueue("trips","leased-trip",{name:"lease"});
await reloadedBox.claimMutation(leasedTrip.id,"relations");
const leaseChild=await relationalQueue("records","leased-plan",{trip_id:"leased-trip"});
assert.equal(await reloadedBox.claimMutation(leaseChild.id,"relations"),null);
frozenNow+=120_001;
for(const item of await reloadedBox.listMutations("relations")) await engine.replayMutation(item,relationalAdapter);
assert.equal((await reloadedBox.listMutations("relations")).length,0,"Expired parent lease can be reclaimed, then releases child without an FK failure");
frozenNow=undefined;

const switchItem = await queue("A", "switch", "pending"); let checks = 0, sent = false;
assert.equal(await engine.replayMutation(switchItem, { ...adapter, currentOwner: async () => ++checks === 1 ? "A" : "B", write: async () => { sent = true; return { data: null, error: null }; } }), null);
assert.equal(sent, false); assert.equal((await box.listMutations("A")).find(item => item.id === switchItem.id).state, "pending");
for (const error of [{ code: "42501" }, { code: "42703" }, { code: "23514" }, { code: "PGRST202" }]) assert.equal(engine.retryableWriteError(error), false);
for (const error of [{ status: 503 }, { code: "08006" }, new TypeError("Failed to fetch")]) assert.equal(engine.retryableWriteError(error), true);

// Execute the actual form handler, not a test reimplementation. A permanent
// cloud refusal must leave input intact, show its error and unlock the button.
const composerSource=readFileSync("src/components/QuickComposer.tsx","utf8");
const composerAst=ts.createSourceFile("composer.tsx",composerSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let submitHandler;
function findSubmit(node) { if(ts.isFunctionDeclaration(node)&&node.name?.text==="submit") submitHandler=node; ts.forEachChild(node,findSubmit); }
findSubmit(composerAst);
assert.ok(submitHandler);
const submitCode=ts.transpileModule(`export ${submitHandler.getText(composerAst)}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let resetCalls=0,closeCalls=0,formSaving=false,formError="",refuse=true;
const formExports={};
runInNewContext(submitCode,{exports:formExports,Error,content:"keep draft",notes:"notes",type:"note",amount:"",currency:"USD",category:"other",location:"",eventAt:"2026-10-01T10:00",toIso:()=>"2026-10-01T02:00:00Z",forcedTripId:undefined,tripId:"",parentPlanId:undefined,compact:true,
  setSaving:value=>{formSaving=value;},setSaveError:value=>{formError=value;},reset:()=>{resetCalls++;},onClose:()=>{closeCalls++;},onSave:async()=>{if(refuse)throw new Error("RLS denied; draft kept");}});
await formExports.submit({preventDefault(){}});
assert.equal(formSaving,false); assert.match(formError,/RLS denied/); assert.equal(resetCalls,0); assert.equal(closeCalls,0);
refuse=false;
await formExports.submit({preventDefault(){}});
assert.equal(formSaving,false); assert.equal(formError,""); assert.equal(resetCalls,1); assert.equal(closeCalls,1);
console.log("PASS: timezone/DST calendar, explicit timeline groups, hotel and inbound projections, flight match invalidation, IndexedDB owner isolation/quarantine/coalescing/leases/dependencies, RLS/network/conflict and account-switch replay; actual quick-record handler retains rejected drafts and unlocks saving.");
