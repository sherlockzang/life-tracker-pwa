import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
const root = process.env.LIFE_TRACKER_AUDIT_SOURCE || process.cwd();
const require = createRequire(resolve(root, "package.json")), ts = require("typescript"), idb = require("idb"), fake = require("fake-indexeddb");
for (const [key, value] of Object.entries(fake)) if (key.startsWith("IDB") || key === "indexedDB") globalThis[key] = value;
function offline() { const exports = {}; runInNewContext(ts.transpileModule(readFileSync(resolve(root,"src/lib/offline.ts"),"utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, Date, crypto, ...fake, require: name => { assert.equal(name,"idb"); return idb; } }); return exports; }
let box = offline();
const source = readFileSync(resolve(root,"src/App.tsx"),"utf8"), ast = ts.createSourceFile("App.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let effect;
function walk(node) { if (ts.isCallExpression(node) && node.expression.getText(ast)==="useEffect" && node.arguments[0]?.getText(ast).includes("summaryRequests.current.get(requestKey)")) effect=node.arguments[0]; ts.forEachChild(node,walk); }
walk(ast); assert.ok(effect);
let summary="", calls=0;
const context={exports:{}, user:{id:"owner"}, data:{profile:{user_id:"owner"},records:[]}, currentTrip:{id:"trip",timezone:"Asia/Tokyo"}, validTimeZone:()=>true, demoMode:false, online:true, dailySummary:"", clockNow:new Date("2026-10-03T00:00:00Z"), summaryContext:"stable-context", summaryRequests:{current:new Map()}, activeOwner:{current:"owner"}, tripToday:()=>"2026-10-03", plansForDay:()=>[{plan_status:"planned"}],
  claimAutomaticSummary:(...args)=>box.claimAutomaticSummary(...args), loadAutomaticSummary:(...args)=>box.loadAutomaticSummary(...args), saveAutomaticSummary:(...args)=>box.saveAutomaticSummary(...args), generateDailySummary:async()=>{calls++;return {result:"already persisted summary",persisted:true};}, setDailySummary:value=>{summary=value;}, showToast(){} };
runInNewContext(ts.transpileModule(`export const run=${effect.getText(ast)}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
async function settle(){for(let i=0;i<25;i++)await new Promise(resolve=>setImmediate(resolve));}
context.exports.run(); await settle(); assert.equal(calls,1); assert.equal(summary,"already persisted summary");
// A fresh window has no React state/map but does retain IndexedDB attempt marker.
box=offline(); summary="";context.dailySummary="";context.summaryRequests={current:new Map()};
for(let i=0;i<3;i++){context.clockNow=new Date(Date.parse("2026-10-03T00:00:00Z")+i*30000);context.exports.run();await settle();}
assert.equal(calls,1);assert.equal(summary,"already persisted summary");
assert.equal(await box.loadAutomaticSummary("another-owner", "stable-context"), undefined);
assert.equal(await box.loadAutomaticSummary("owner", "another-day"), undefined);
// A full or unavailable IndexedDB must not discard an already generated result.
summary=""; context.dailySummary=""; context.summaryContext="cache-failure"; let notice="";
context.saveAutomaticSummary=async()=>{throw new Error("storage unavailable");};
context.showToast=value=>{notice=value;};
context.exports.run(); await settle();
assert.equal(calls,2); assert.equal(summary,"already persisted summary"); assert.match(notice,/无法缓存/);
console.log("PASS R2-03: actual App effect restores successful summary after reload, preserves results on cache failure, and isolates owner/day.");
