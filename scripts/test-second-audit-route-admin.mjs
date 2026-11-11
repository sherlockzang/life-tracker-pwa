import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
const root=process.env.LIFE_TRACKER_AUDIT_SOURCE||process.cwd(), require=createRequire(resolve(root,"package.json")), ts=require("typescript");
const modules=new Map();
function load(file){file=resolve(root,file);if(!/\.tsx?$/.test(file))file+=".ts";if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);runInNewContext(ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Intl,Error,require:name=>load(resolve(dirname(file),name))});return exports;}
function extract(path,names,globals){const source=readFileSync(resolve(root,path),"utf8"),ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,path.endsWith("tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS), nodes=new Map();function walk(node){if(ts.isFunctionDeclaration(node)&&node.name)nodes.set(node.name.text,node);ts.forEachChild(node,walk);}walk(ast);const exports={};runInNewContext(ts.transpileModule(names.map(name=>`export ${nodes.get(name).getText(ast)}`).join("\n"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Intl,Error,...globals});return {exports,source};}
const trip={id:"trip",start_date:"2026-11-01",end_date:"2026-11-02",timezone:"America/Los_Angeles"},dates=load("src/lib/tripDates.ts"),transport=load("src/lib/transport.ts");
async function saveRoute(planTime,localOffset){let saved,error="",closed=false;const {exports}=extract("src/components/HomeRouteSearch.tsx",["saveRoute"],{availableTrips:[trip],tripId:"trip",result:"synthetic AI route",planDate:"2026-11-01",planTime,localOffset,origin:"A",destination:"B",records:[],transportTitle:transport.transportTitle,dateInZone:dates.dateInZone,zonedDateTimeToIso:dates.zonedDateTimeToIso,onSave:async value=>{saved=value;},close:()=>{closed=true;},setSaving(){},setError:value=>{error=value;}});await exports.saveRoute();return {saved,error,closed};}
const normal=await saveRoute("00:30");assert.ok(normal.saved);assert.equal(normal.closed,true);
const repeated=await saveRoute("01:30");assert.equal(repeated.saved,undefined);assert.equal(repeated.closed,false);assert.match(repeated.error,/两次/);
const routeSource=readFileSync(resolve(root,"src/components/HomeRouteSearch.tsx"),"utf8");assert.match(routeSource,/aria-label="重复当地时间"/);assert.match(routeSource,/localChoice.key === localKey/);
const first=await saveRoute("01:30",-420),second=await saveRoute("01:30",-480);
assert.equal(first.saved.event_at,"2026-11-01T08:30:00.000Z");assert.equal(second.saved.event_at,"2026-11-01T09:30:00.000Z");

// R2-05: execute actual Owner list function with realistic capped reads.
const users=Array.from({length:1001},(_,index)=>({id:`user-${index}`,email:index===1000?"target@example.invalid":`user-${index}@example.invalid`,created_at:"2026-10-01T00:00:00Z"}));
const events=Array.from({length:1100},(_,i)=>({id:String(i).padStart(6,"0"),user_id:"user-0",service:"deepseek",feature:"note_polish"}));let requests=[],failPage=false,failUsage=false;
const api={auth:{admin:{listUsers:async args=>{requests.push(args);return {data:{users:users.slice((args.page-1)*args.perPage,args.page*args.perPage)},error:failPage&&args.page===2?new Error("page failed"):null};}}},from(table){let cursor=null,ids=[];const chain={select(){return chain;},in(_key,value){ids=value;return chain;},is(){return chain;},eq(){return chain;},gte(){return chain;},lt(){return chain;},order(){return chain;},limit(){return chain;},gt(_key,value){cursor=value;return chain;},then(yes,no){return Promise.resolve({data:table==="api_entitlements"?[]:events.filter(event=>(!cursor||event.id>cursor)&&ids.includes(event.user_id)).slice(0,73),error:failUsage&&cursor?new Error("usage page failed"):null}).then(yes,no);}};return chain;}};
class ApiError extends Error{}
const {exports:owner}=extract("supabase/functions/owner-admin/index.ts",["monthStart","listUsers"],{admin:()=>api,ApiError,readAllPages:load("supabase/functions/_shared/pagination.ts").readAllPages});
assert.equal((await owner.listUsers("user-0@"))[0].monthUsage.deepseek,1100);
assert.equal((await owner.listUsers("target@example.invalid")).length,1);
assert.equal(requests.some(args=>args.page===3),true);
failPage=true;await assert.rejects(owner.listUsers("user-0@"));failPage=false;
failUsage=true;await assert.rejects(owner.listUsers("user-0@"));
console.log("PASS R2-04/05: route saves either repeated local clock without re-querying AI; Owner finds account #1001 and counts 1100 events despite 73-row cap; any page failure refuses partial totals.");
