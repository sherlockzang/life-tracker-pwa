import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Actual source, isolated cloud and cache substitutes. Never use real projects.
const sourceRoot=process.env.LIFE_TRACKER_AUDIT_SOURCE||process.cwd();
function loader(stubs={},globals={}) {
  const modules=new Map();
  function load(file) {
    file=resolve(sourceRoot,file);if(!/\.[cm]?[jt]sx?$/.test(file))file+=".ts";
    if(stubs[file])return stubs[file];if(modules.has(file))return modules.get(file);
    const exports={};modules.set(file,exports);
    const code=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    runInNewContext(code,{exports,Date,Intl,Error,console,crypto,Request,Response,...globals,require:dependency=>dependency.startsWith("jsr:")?{}:load(resolve(dirname(file),dependency))},{filename:file});return exports;
  }
  return load;
}
const id=index=>String(index).padStart(6,"0"),owner="test-owner";
let cap=137,failTable="",pageCalls=[],snapshot={marker:"complete previous cache"},cacheWrites=0,mutatePage=false,drafts=[];
const rows=Array.from({length:1001},(_,index)=>({id:id(index),user_id:owner,record_type:"expense",content:id(index),amount:1,currency:"USD",expense_category:"food",event_at:"2026-10-02T01:00:00Z",transport_type:null,transport_details:null}));
const datasets={records:rows,trips:rows.map(row=>({id:row.id,user_id:owner,name:row.id,start_date:"2026-10-02",end_date:"2026-10-03",timezone:"UTC",archived_at:null})),exchange_rates:rows.map(row=>({id:row.id,user_id:owner,rate:1,rate_date:"2026-10-02",base_currency:"JPY",quote_currency:"USD"})),changelogs:[]};
datasets.changelogs=rows.map((row,index)=>({id:row.id,version:`0.${index}.0`,summary:[],created_at:"2026-10-02T00:00:00Z"}));
function query(table) {
  let after=null,limit=Infinity,order="id",ascending=true;
  const filters=new Map();
  const chain={select(){return chain;},eq(key,value){filters.set(key,value);return chain;},is(){return chain;},order(key,options){order=key;ascending=options?.ascending!==false;return chain;},limit(value){limit=value;return chain;},gt(key,value){assert.equal(key,"id");after=value;return chain;},maybeSingle:async()=>({data:table==="profiles"?{user_id:owner}:table==="user_settings"?{user_id:owner,theme:"dark",base_currency:"USD"}:null,error:null}),then(yes,no){return answer().then(yes,no);}};
  async function answer(){
    pageCalls.push({table,after});if(table!=="changelogs")assert.equal(filters.get("user_id"),owner,"Every page remains owner-scoped");
    if(failTable===table&&after)return {data:null,error:{code:"08006",message:"second page failed"}};
    if(mutatePage&&table==="records"&&after){datasets.records=datasets.records.filter(row=>row.id!==id(0));datasets.records.find(row=>row.id===id(800)).event_at="2020-01-01T00:00:00Z";mutatePage=false;}
    const result=datasets[table].filter(row=>!after||row.id>after).sort((a,b)=>String(a[order]).localeCompare(String(b[order]))*(ascending?1:-1)).slice(0,Math.min(cap,limit));
    return {data:result,error:null};
  }
  return chain;
}
const browserClient={from:query,auth:{getSession:async()=>({data:{session:{user:{id:owner},access_token:"synthetic-token"}}})}};
const dataModule=loader({[resolve(sourceRoot,"src/lib/supabase.ts")]:{supabase:browserClient},[resolve(sourceRoot,"src/lib/offline.ts")]:{listMutations:async()=>drafts,saveSnapshot:async value=>{snapshot=value;cacheWrites++;},loadSnapshot:async()=>snapshot}})("src/lib/data.ts");
const loaded=await dataModule.fetchAppData({id:owner,email:"test@example.invalid",user_metadata:{}});
assert.equal(loaded.records.length,1001);assert.equal(loaded.trips.length,1001);assert.equal(loaded.rates.length,1001);
assert.equal(loaded.changelogs.filter(row=>row.version.startsWith("0.")).length,1001);
assert.equal(loaded.records.reduce((sum,row)=>sum+row.amount,0),1001);assert.equal(snapshot.records.length,1001);assert.equal(cacheWrites,1);
assert.ok(pageCalls.filter(page=>page.table==="records").length>2,"A cap lower than requested limit does not imply end of collection");
const retainedSnapshot=snapshot;failTable="records";
await assert.rejects(dataModule.fetchAppData({id:owner,user_metadata:{}}));assert.equal(snapshot,retainedSnapshot);assert.equal(cacheWrites,1,"Partial successful pages never replace full local cache");
failTable="";mutatePage=true;
const duringUpdate=await dataModule.fetchAppData({id:owner,user_metadata:{}});assert.equal(duringUpdate.records.length,1001,"Deleting a previously read ID / moving a display date does not shift offset pages");
assert.ok(duringUpdate.records.some(row=>row.id===id(800)));
drafts=[{table:"records",entityId:"failed-draft",state:"failed",payload:{...rows[0],id:"failed-draft",content:"unsaved"}},{table:"records",entityId:"legacy-draft",legacy:true,state:"failed",payload:{...rows[0],id:"legacy-draft"}}];
const withFailure=await dataModule.fetchAppData({id:owner,user_metadata:{}});assert.ok(withFailure.records.some(row=>row.id==="failed-draft"));assert.ok(!withFailure.records.some(row=>row.id==="legacy-draft"));
console.log("PASS F01/F02: 1001-row records/trips/rates below configurable cap, owner filters, incomplete read retains full cache, immutable cursors survive display-date/deletion updates, failed drafts remain visible while legacy copies stay quarantined.");

class ApiError extends Error {constructor(code,message,status=400){super(message);this.code=code;this.status=status;}}
let quotaFailure="",quotaTier="owner",quotaCalls=[];
const fixedNow=Date.parse("2026-10-02T03:00:00Z");
class Clock extends Date {constructor(...args){super(...(args.length?args:[fixedNow]));}static now(){return fixedNow;}}
function quotaQuery(table){
  let after=null,keys=[];
  const chain={select(){return chain;},eq(){return chain;},is(){return chain;},gte(){return chain;},in(_key,value){keys=value;return chain;},gt(key,value){if(key==="bucket_key")after=value;return chain;},order(){return chain;},limit(){return chain;},maybeSingle(){return answer(true);},then(yes,no){return answer(false).then(yes,no);}};
  async function answer(single){
    quotaCalls.push(table);const error=quotaFailure===table?{message:"database unavailable"}:null;
    if(error)return {data:null,count:null,error};
    if(table==="api_entitlements")return {data:quotaTier?{tier:quotaTier}:null,error:null};
    if(table==="api_cooldowns")return {data:null,error:null};
    if(table==="api_usage_events")return {data:null,count:18,error:null};
    assert.equal(table,"api_quota_buckets");assert.equal(single,false);
    return {data:keys.sort().filter(key=>!after||key>after).slice(0,2).map(key=>({id:key,bucket_key:key,used_value:key.includes("aviation:global:")?18:0,limit_value:100,period_end:"2026-10-31T16:00:00Z"})),error:null};
  }
  return chain;
}
const mockApi={admin:()=>({from:quotaQuery}),ApiError,authenticatedUser:async()=>({id:owner}),requestOrigin:()=>"http://localhost",preflight:()=>null,json:(_origin,_id,body)=>new Response(JSON.stringify(body)),errorResponse:(_origin,_id,error)=>new Response(JSON.stringify({error:{code:error.code||"INTERNAL_ERROR"}}),{status:error.status||503})};
const quotaLoad=loader({[resolve(sourceRoot,"supabase/functions/_shared/api.ts")]:mockApi},{Date:Clock});
const quota=quotaLoad("supabase/functions/get-api-quota/index.ts").default;
const quotaRequest=async()=>{const response=await quota.fetch(new Request("http://localhost/quota"));return {status:response.status,body:await response.json()};};
const goodQuota=await quotaRequest();assert.equal(goodQuota.status,200);assert.equal(goodQuota.body.data.tier,"owner");assert.equal(goodQuota.body.data.aviation.globalRemaining,82);
for(const table of ["api_entitlements","api_quota_buckets","api_cooldowns","api_usage_events"]){quotaFailure=table;const result=await quotaRequest();assert.equal(result.status,503);assert.equal(result.body.error.code,"DATA_UNAVAILABLE");assert.equal(result.body.data,undefined);}
quotaFailure="";quotaTier=null;assert.equal((await quotaRequest()).body.data.tier,"standard","Successful no entitlement defaults to standard, unlike a failed query");
const period=quotaLoad("supabase/functions/_shared/quotaPeriod.ts").shanghaiPeriod;
for(const [instant,end] of [["2026-10-02T00:00:00Z","2026-10-31T16:00:00.000Z"],["2026-02-15T00:00:00Z","2026-02-28T16:00:00.000Z"],["2024-02-15T00:00:00Z","2024-02-29T16:00:00.000Z"],["2026-04-01T00:00:00Z","2026-04-30T16:00:00.000Z"],["2026-12-31T00:00:00Z","2026-12-31T16:00:00.000Z"]])assert.equal(period(new Date(instant)).monthEnd,end);
assert.equal(period(new Date("2026-09-30T15:59:59Z")).month,"2026-09");assert.equal(period(new Date("2026-09-30T16:00:00Z")).month,"2026-10");
console.log("PASS F05/F06: independent entitlement/bucket/cooldown/count failures return DATA_UNAVAILABLE without fabricated balance; successful no-row default; Shanghai long/short/leap/December month boundaries.");
