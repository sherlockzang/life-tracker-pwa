import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";

const root = process.cwd();
const secret = "local-test-only-signing-secret";
const ownId = "10000000-0000-4000-8000-000000000001";
const otherId = "10000000-0000-4000-8000-000000000002";
let currentUser = ownId;
let failStore = false;
let failCacheRead = false;
let failUsage = false;
let failUpstream = false;
let quotaCalls = 0;
let upstreamCalls = 0;
let storeCalls = 0;
let stored = null;
let upstreamMode = "normal";
let upstreamJson = null;
let lastUpstreamSignal;
const completedUsage = [];
const errorLogs = [];
const fakeSecret = "FAKE_SECRET_MUST_NOT_APPEAR";
const liveTimers = new Set();
const timedSetTimeout = (callback, ms) => {
  const timer = setTimeout(() => { liveTimers.delete(timer); callback(); }, upstreamMode === "headers" || upstreamMode === "body" ? 5 : ms);
  liveTimers.add(timer); return timer;
};
const timedClearTimeout = (timer) => { liveTimers.delete(timer); clearTimeout(timer); };
const dailyCache = new Map();
let frozenNow;
class Clock extends Date { constructor(...args){super(...(args.length?args:frozenNow==null?[]:[frozenNow]));} static now(){return frozenNow??Date.now();} }
const trip = { id: "20000000-0000-4000-8000-000000000001", name: "Tokyo", destination: "Tokyo", timezone: "Asia/Tokyo", start_date: "2020-01-01", end_date: "2030-12-31" };
const hotel = { id: "hotel", trip_id: trip.id, content: "Hotel", event_at: "2020-01-01T00:00:00Z", plan_status: "planned", transport_type: null, transport_details: null,
  schedule_details: { kind: "hotel", start_date: "2020-01-01", end_date: "2030-12-31" } };
let recordRows=[hotel], tripRows=[trip], pageCap=500, failRecordPage=false, lastRequestBody;

function query(table) {
  const filters = new Map();
  let afterId = null, pageLimit = 500;
  const chain = {
    select() { return chain; }, eq(key, value) { filters.set(key, value); return chain; },
    is() { return chain; }, in() { return chain; }, neq() { return chain; }, order() { return chain; },
    limit(value) { pageLimit = value; return chain; }, gt(key, value) { if (key === "id") afterId = value; return chain; },
    maybeSingle() { return answer(true); }, then(yes, no) { return answer(false).then(yes, no); }
  };
  async function answer(single=false) {
    if (table === "trips") return { data: single?trip:tripRows.filter(row => !afterId || row.id > afterId).slice(0,Math.min(pageCap,pageLimit)), error: null };
    if (table === "records") return { data: recordRows.filter(row => !afterId || row.id > afterId).slice(0,Math.min(pageCap,pageLimit)), error: failRecordPage&&afterId?{message:"page unavailable"}:null };
    if (table === "trip_recaps") return {data:null,error:null};
    if (table === "daily_summaries") {
      const cached=dailyCache.get(`${filters.get("user_id")}:${filters.get("context_key")}`);
      const dateMatches=!filters.has("summary_date")||cached?.summary_date===filters.get("summary_date");
      return { data: dateMatches?cached||null:null, error: failCacheRead ? { message: "cache refused" } : null };
    }
    throw new Error(`Unexpected mock query ${table}`);
  }
  return chain;
}

const client = {
  auth: { getUser: async () => ({ data: { user: { id: currentUser } }, error: null }) },
  from: query,
  async rpc(name, args) {
    if (name === "consume_api_quota") { quotaCalls += 1; return { data: { allowed: true }, error: null }; }
    if (name === "complete_api_usage") { completedUsage.push(args); return { data: null, error: failUsage ? { message: "usage refused" } : null }; }
    if (name === "store_ai_result") {
      storeCalls += 1;
      if (failStore || failUsage) return { data: null, error: { message: "store or completion refused" } };
      stored = args;
      if (args.p_feature === "daily_summary") dailyCache.set(`${args.p_user_id}:${args.p_context_key}`, { content: args.p_content, generated_at: args.p_generated_at, summary_date:args.p_summary_date });
      return { data: { saved: true, generatedAt: args.p_generated_at }, error: null };
    }
    throw new Error(`Unexpected mock RPC ${name}`);
  }
};

const sandbox = {
  crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob, Intl, Date:Clock, Request, Response, AbortController, DOMException, setTimeout: timedSetTimeout, clearTimeout: timedClearTimeout,
  console: { error(...args) { errorLogs.push(args); } }, Deno: { env: { get: (name) => name === "SUPABASE_SERVICE_ROLE_KEY" ? secret : name === "DEEPSEEK_API_KEY" ? "mock-not-a-real-key" : "http://localhost" } },
  fetch: async (_input, init) => {
    upstreamCalls += 1; lastUpstreamSignal = init.signal; lastRequestBody=JSON.parse(init.body);
    // Deliberately ignore AbortSignal, so the explicit deadline must settle.
    if (upstreamMode === "headers") return new Promise(() => {});
    if (upstreamMode === "body") return { ok: true, status: 200, json: () => new Promise(() => {}) };
    if (upstreamMode === "network") throw new TypeError(`Fetch failed URL=https://example.test?access_key=${fakeSecret} Authorization=Bearer ${fakeSecret}`);
    if (upstreamMode === "malformed") return new Response("{invalid");
    if (upstreamMode === "json") return new Response(JSON.stringify(upstreamJson));
    return new Response(JSON.stringify({ choices: [{ message: { content: "今日酒店续住，慢慢开始新的一天。" } }], usage: { total_tokens: 50 } }), { status: failUpstream ? 502 : 200 });
  }
};
const modules = new Map();
function load(path) {
  path = resolve(root, path);
  if (modules.has(path)) return modules.get(path);
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  modules.set(path, exports);
  runInNewContext(code, { ...sandbox, exports, require: (name) => name.startsWith("jsr:") ? { createClient: () => client } : load(resolve(dirname(path), name)) }, { filename: path });
  return exports;
}
const ai = load("supabase/functions/_shared/aiData.ts");
const recovery = load("supabase/functions/_shared/recovery.ts");
const edge = load("supabase/functions/deepseek-assist/index.ts").default;
const plain = (value) => JSON.parse(JSON.stringify(value));

const money = ai.aggregateExpenseCurrencies([
  { record_type: "expense", amount: 1, currency: "USD", expense_category: "food" },
  { record_type: "expense", amount: 100, currency: "JPY", expense_category: "food" },
  { record_type: "expense", amount: "2.5", currency: "USD", expense_category: "transport" },
  { record_type: "expense", amount: null, currency: "USD" },
  { record_type: "expense", amount: "invalid", currency: "JPY" },
  { record_type: "expense", amount: -1, currency: "USD" },
  { record_type: "note", amount: 1000, currency: "USD" },
  { record_type: "expense", amount: 3, currency: "CNY", expense_category: "__proto__" }
]);
assert.deepEqual(plain(money), { expenseTotals: { USD: 3.5, JPY: 100, CNY: 3 }, categoryTotalsByCurrency: { USD: { food: 1, transport: 2.5 }, JPY: { food: 100 }, CNY: { other: 3 } } });
assert.equal(money.categoryTotalsByCurrency.food, undefined, "No cross-currency category total");

const instant = "2026-09-29T23:30:00Z";
assert.equal(ai.dateInZone(instant, "Asia/Tokyo"), "2026-09-30");
assert.equal(ai.dateInZone(instant, "America/Los_Angeles"), "2026-09-29");
const laTrip = { ...trip, id: "la", start_date: "2026-09-29", end_date: "2026-09-29", timezone: "America/Los_Angeles" };
const tokyoTrip = { ...trip, id: "tokyo", start_date: "2026-09-30", end_date: "2026-10-02" };
const active = ai.activeSummaryTrips([tokyoTrip, laTrip], instant);
assert.deepEqual(plain(active.map(({ id, day }) => ({ id, day }))), [{ id: "la", day: "2026-09-29" }, { id: "tokyo", day: "2026-09-30" }]);
assert.equal(ai.dailySummaryContext(active), ai.dailySummaryContext([...active].reverse()));
assert.notEqual(ai.dailySummaryContext(active), ai.dailySummaryContext(ai.activeSummaryTrips([tokyoTrip, laTrip], "2026-09-30T15:30:00Z")), "Context rotates at trip-local midnight independently of quota day");

const summaryRecord = (id, details) => ({ ...hotel, id, trip_id: "tokyo", content: id, schedule_details: details });
const plans = ai.projectDailyPlans([
  summaryRecord("old", { kind: "hotel", start_date: "2026-09-28", end_date: "2026-09-30", check_out_time: "10:00" }),
  summaryRecord("new", { kind: "hotel", start_date: "2026-09-30", end_date: "2026-10-02", check_in_time: "15:00" }),
  summaryRecord("all", { kind: "all_day", start_date: "2026-09-29", end_date: "2026-10-01" }),
  { ...summaryRecord("cancel", { kind: "all_day", start_date: "2026-09-29", end_date: "2026-10-01" }), plan_status: "cancelled" },
  { ...summaryRecord("timed", null), event_at: "2026-09-30T01:00:00Z" }
], active);
assert.deepEqual(plain(plans.map(({ id, phase, time }) => ({ id, phase, time }))), [{ id: "old", phase: "check_out", time: "10:00" }, { id: "new", phase: "check_in", time: "15:00" }, { id: "all", phase: "all_day", time: "全天" }, { id: "timed", phase: "timed", time: "10:00" }]);
const firstDayTrip = { ...tokyoTrip, start_date: "2026-09-29", day: "2026-09-29" };
const flight = { ...summaryRecord("flight", null), transport_type: "flight", transport_details: { departure: { date: "2026-09-28", time: "00:50", timezone: "America/Los_Angeles" }, arrival: { date: "2026-09-29", time: "05:00", timezone: "Asia/Tokyo" } } };
assert.equal(ai.projectDailyPlans([flight], [firstDayTrip])[0].date, "2026-09-29", "Inbound flight is visible on first overlapping trip day");
assert.equal(ai.projectDailyPlans([summaryRecord("stay", { kind: "hotel", start_date: "2026-09-28", end_date: "2026-10-02" })], active)[0].phase, "staying");
const malformedHotel = { ...summaryRecord("legacy-invalid", { kind: "hotel", start_date: "2026-09-28", end_date: "2026-10-02", check_in_time: "25:00" }), event_at: "2026-09-30T01:00:00Z" };
assert.equal(ai.projectDailyPlans([malformedHotel], active)[0].phase, "timed", "Malformed legacy schedule follows the same generic-event fallback as frontend normalization");
const dstTrip = { ...laTrip, start_date: "2026-11-01", end_date: "2026-11-01", day: "2026-11-01" };
const dstPlans = ai.projectDailyPlans([
  { ...hotel, id: "second", trip_id: "la", schedule_details: null, event_at: "2026-11-01T09:30:00Z" },
  { ...hotel, id: "first", trip_id: "la", schedule_details: null, event_at: "2026-11-01T08:30:00Z" }
], [dstTrip]);
assert.deepEqual(plain(dstPlans.map(({ id, time }) => ({ id, time }))), [{ id: "first", time: "01:30" }, { id: "second", time: "01:30" }], "Fall-back repeated wall-clock hour stays on the same local day and sorts by actual instant");

// The two occurrences of LA 01:30 land on different calendar days in Gambier.
// Both departure and arrival must use the selected UTC offset, never a guess.
const gambierTrip = { ...laTrip, id: "gambier", timezone: "Pacific/Gambier", start_date: "2026-10-31", end_date: "2026-11-02" };
const gambierFlight = (id, offset) => ({ ...hotel, id, trip_id: "gambier", schedule_details: null, transport_type: "flight", transport_details: {
  departure: { date: "2026-11-01", time: "01:30", timezone: "America/Los_Angeles", ...(offset == null ? {} : { utc_offset_minutes: offset }) },
  arrival: { date: "2026-11-01", time: "03:30", timezone: "America/Los_Angeles", utc_offset_minutes: -480 }
} });
const occurrenceRecords = [gambierFlight("first", -420), gambierFlight("second", -480), gambierFlight("ambiguous", undefined)];
for (const [day, expected] of [["2026-10-31", ["first"]], ["2026-11-01", ["second"]]]) {
  assert.deepEqual(plain(ai.projectDailyPlans(occurrenceRecords, [{ ...gambierTrip, day }]).map(plan => plan.id)), expected, "Selected LA departure occurrence crosses Gambier midnight correctly; unselected ambiguity is omitted");
}
const arrivalBoundaryTrip = { ...gambierTrip, start_date: "2026-11-01", day: "2026-11-01" };
const arrivalOccurrence = (id, offset) => ({ ...gambierFlight(id, -420), transport_details: {
  departure: { date: "2026-10-31", time: "22:30", timezone: "Pacific/Gambier", utc_offset_minutes: -540 },
  arrival: { date: "2026-11-01", time: "01:30", timezone: "America/Los_Angeles", ...(offset == null ? {} : { utc_offset_minutes: offset }) }
} });
assert.deepEqual(plain(ai.projectDailyPlans([arrivalOccurrence("first-arrival", -420), arrivalOccurrence("second-arrival", -480), arrivalOccurrence("ambiguous-arrival", undefined)], [arrivalBoundaryTrip]).map(plan => plan.id)), ["second-arrival"], "Only the second arrival occurrence overlaps the first Gambier trip day; missing choice is not guessed");

const token = await recovery.signRecoveryToken({ userId: ownId, result: "中文内容" }, "test", secret, 1000, 1000);
assert.deepEqual(plain(await recovery.verifyRecoveryToken(token, "test", secret, 1500)), { userId: ownId, result: "中文内容" });
await assert.rejects(recovery.verifyRecoveryToken(token, "other", secret, 1500));
await assert.rejects(recovery.verifyRecoveryToken(token, "test", "wrong", 1500));
await assert.rejects(recovery.verifyRecoveryToken(token, "test", secret, 2000));
await assert.rejects(recovery.verifyRecoveryToken(token.replace(/.$/, token.endsWith("A") ? "B" : "A"), "test", secret, 1500));
await assert.rejects(recovery.signRecoveryToken({}, "test", "", 1000));

async function request(body) {
  const response = await edge.fetch(new Request("http://localhost/deepseek-assist", { method: "POST", headers: { origin: "http://localhost:3000", authorization: "Bearer mock" }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
}
failStore = true;
const generated = await request({ action: "daily_summary" });
assert.equal(generated.status, 200);
assert.equal(generated.body.data.persisted, false);
assert.ok(generated.body.data.result.includes("酒店续住"));
assert.ok(generated.body.data.recoveryToken);
assert.equal(upstreamCalls, 1);
assert.equal(quotaCalls, 1);
currentUser = otherId;
const forbidden = await request({ action: "retry_save", recoveryToken: generated.body.data.recoveryToken });
assert.equal(forbidden.status, 403);
assert.equal(storeCalls, 1, "Other account cannot replay saved result");
currentUser = ownId;
failStore = false;
const retried = await request({ action: "retry_save", recoveryToken: generated.body.data.recoveryToken });
assert.equal(retried.status, 200);
assert.equal(retried.body.data.persisted, true);
assert.equal(stored.p_user_id, ownId);
assert.equal(stored.p_content, generated.body.data.result);
assert.equal(upstreamCalls, 1, "Retry save never calls model");
assert.equal(quotaCalls, 1, "Retry save never consumes quota");
const cached = await request({ action: "daily_summary" });
assert.equal(cached.body.data.cached, true);
assert.equal(cached.body.data.persisted, true);
assert.equal(upstreamCalls, 1);
trip.timezone="America/Los_Angeles";
frozenNow=Date.parse("2026-09-30T15:59:00Z");
const laBefore=await request({action:"daily_summary"});
assert.equal(laBefore.body.data.cached,false);
const midnightCounts={upstreamCalls,quotaCalls,storeCalls};
frozenNow=Date.parse("2026-09-30T16:01:00Z");
const laAfter=await request({action:"daily_summary"});
assert.equal(laAfter.body.data.contextKey,laBefore.body.data.contextKey);
assert.equal(laAfter.body.data.cached,true,"Shanghai midnight does not create a new LA business day cache");
assert.deepEqual({upstreamCalls,quotaCalls,storeCalls},midnightCounts,"Same trip-local context across Shanghai midnight consumes zero extra upstream/quota/store");
frozenNow=undefined; trip.timezone="Asia/Tokyo";
failCacheRead = true;
const unreadable = await request({ action: "daily_summary" });
assert.equal(unreadable.status, 503);
assert.equal(unreadable.body.error.code, "CACHE_UNAVAILABLE");
assert.equal(upstreamCalls, midnightCounts.upstreamCalls, "Unknown cache state must not trigger new generation");
failCacheRead = false;
failUsage = true;
const sharedApi = load("supabase/functions/_shared/api.ts");
await assert.rejects(sharedApi.completeUsage("30000000-0000-4000-8000-000000000001", "completed"), (error) => error.code === "USAGE_LOG_FAILED");
const usageFailed = await request({ action: "note_polish", text: "一个晴朗的日子" });
assert.equal(usageFailed.status, 200);
assert.equal(usageFailed.body.data.persisted, false);
assert.ok(usageFailed.body.data.recoveryToken, "Completion failure can retry without another generation");
const beforeInvalid = { upstreamCalls, quotaCalls, storeCalls };
const invalidRetry = await request({ action: "retry_save", recoveryToken: "invalid.token" });
assert.equal(invalidRetry.status, 400);
assert.deepEqual({ upstreamCalls, quotaCalls, storeCalls }, beforeInvalid);
failUpstream = true;
const upstreamFailed = await request({ action: "note_polish", text: "无法响应" });
assert.equal(upstreamFailed.status, 503);
assert.equal(upstreamFailed.body.error.code, "AI_UNAVAILABLE", "A usage log failure must not mask the original upstream error");
currentUser = otherId;
const callsBeforeOwnerRace = { upstreamCalls, quotaCalls, storeCalls };
const changedOwner = await request({ action: "note_polish", text: "原账号草稿", expectedOwner: ownId });
assert.equal(changedOwner.status, 409);
assert.equal(changedOwner.body.error.code, "ACCOUNT_CHANGED");
assert.deepEqual({ upstreamCalls, quotaCalls, storeCalls }, callsBeforeOwnerRace, "Changed JWT owner is rejected before quota, cache or upstream use");
currentUser = ownId;

failUsage = false; failStore = false; failUpstream = false;
for (const mode of ["headers", "body"]) {
  upstreamMode = mode;
  const before = { upstreamCalls, quotaCalls, storeCalls, completions: completedUsage.length };
  const deadlineResponse = await request({ action: "note_polish", text: "完整响应必须限时" });
  assert.equal(deadlineResponse.status, 504);
  assert.equal(deadlineResponse.body.error.code, "AI_TIMEOUT");
  assert.equal(upstreamCalls - before.upstreamCalls, 1);
  assert.equal(quotaCalls - before.quotaCalls, 1, "Timeout consumes its one reserved attempt, without re-reserving or refunding");
  assert.equal(storeCalls, before.storeCalls, "A timeout never writes AI content or cache");
  assert.equal(completedUsage.length - before.completions, 1);
  assert.equal(completedUsage.at(-1).p_status, "upstream_error");
  assert.equal(lastUpstreamSignal.aborted, true);
  assert.equal(liveTimers.size, 0, "Deadline timer is cleared even when the transport ignores abort");
}
for (const value of [null, 7, "wrong envelope", [], true]) {
  upstreamMode = "json"; upstreamJson = value;
  const invalidEnvelope = await request({ action: "note_polish", text: "上游格式异常" });
  assert.equal(invalidEnvelope.status, 503);
  assert.equal(invalidEnvelope.body.error.code, "AI_UNAVAILABLE");
  assert.equal(liveTimers.size, 0);
}
upstreamMode = "malformed";
assert.equal((await request({ action: "note_polish", text: "非 JSON 响应" })).body.error.code, "AI_UNAVAILABLE");
assert.equal(liveTimers.size, 0);
upstreamMode = "network";
const logsBeforeNetwork = errorLogs.length;
const networkFailure = await request({ action: "note_polish", text: "网络故障不暴露密钥" });
assert.equal(networkFailure.status, 503);
assert.equal(JSON.stringify(networkFailure).includes(fakeSecret), false);
assert.equal(JSON.stringify(errorLogs.slice(logsBeforeNetwork)).includes(fakeSecret), false, "Provider transport messages are sanitized before shared API logging");
assert.equal(liveTimers.size, 0);
upstreamMode = "normal";

// Independent audit F04: validate the model's inner JSON, not just its envelope.
for(const value of [null,[],true,42,"text"]) {
  upstreamMode="json";upstreamJson={choices:[{message:{content:JSON.stringify(value)}}]};
  const before={upstreamCalls,quotaCalls,storeCalls,completions:completedUsage.length};
  const invalid=await request({action:"expense_parse",text:"午饭十美元"});
  assert.equal(invalid.status,502);assert.equal(invalid.body.error.code,"AI_INVALID_OUTPUT");
  assert.equal(storeCalls,before.storeCalls);assert.equal(upstreamCalls-before.upstreamCalls,1);assert.equal(quotaCalls-before.quotaCalls,1);
  assert.equal(completedUsage.length-before.completions,1);assert.equal(completedUsage.at(-1).p_status,"failed");
}
upstreamMode="json";upstreamJson={choices:[{message:{content:JSON.stringify({amount:10,currency:"USD",category:"food"})}}]};
assert.equal((await request({action:"expense_parse",text:"午饭十美元"})).body.data.result.amount,10);
upstreamMode="normal";
// F07: both documented route inputs work; malformed partial inputs cost nothing.
for(const body of [{query:"从UCSB去LAX怎么走"},{origin:"UCSB",destination:"LAX"},{origin:"UCSB",destination:"LAX",query:"公共交通路线"}]) assert.equal((await request({action:"route",...body})).status,200);
for(const body of [{},{origin:"UCSB"},{destination:"LAX",query:"怎么走"},{query:"x".repeat(501)},{origin:"x".repeat(121),destination:"LAX"},{query:"怎么走",departureTime:"x".repeat(81)}]) {
  const before={upstreamCalls,quotaCalls};assert.equal((await request({action:"route",...body})).status,400);assert.deepEqual({upstreamCalls,quotaCalls},before);
}
// F01: incomplete plan after a server cap cannot accidentally authorize recap.
pageCap=137;
recordRows=Array.from({length:1001},(_,index)=>({id:String(index).padStart(6,"0"),trip_id:trip.id,record_type:"trip",plan_status:index===1000?"planned":"completed",event_at:"2026-10-01T00:00:00Z"}));
const beforeRecap={upstreamCalls,quotaCalls};
assert.equal((await request({action:"trip_recap",tripId:trip.id})).body.error.code,"TRIP_NOT_FINISHED");assert.deepEqual({upstreamCalls,quotaCalls},beforeRecap);
recordRows=recordRows.map(row=>({...row,plan_status:"completed",record_type:"expense",amount:1,currency:"USD",expense_category:"food"}));
trip.end_date="2020-01-02"; // A finished trip may legitimately contain only expenses.
const completeRecap=await request({action:"trip_recap",tripId:trip.id});assert.equal(completeRecap.status,200);
const aggregate=JSON.parse(lastRequestBody.messages[1].content);assert.equal(aggregate.recordCount,1001);assert.equal(aggregate.expenseTotals.USD,1001);
trip.end_date="2030-12-31";
recordRows=recordRows.map(row=>({...row,record_type:"trip",content:row.id,plan_status:"planned",transport_type:null,transport_details:null,schedule_details:null,event_at:new Date().toISOString()}));
dailyCache.clear();failRecordPage=true;
const beforePageFailure={upstreamCalls,quotaCalls,storeCalls};
assert.equal((await request({action:"daily_summary"})).body.error.code,"DATA_UNAVAILABLE");assert.deepEqual({upstreamCalls,quotaCalls,storeCalls},beforePageFailure);
recordRows=[hotel];pageCap=500;failRecordPage=false;

// Browser helper tests use an isolated storage map and function stub. They do
// not read a real session, local browser cache, or invoke a cloud function.
const browserStorage = new Map();
let browserOwner = ownId;
let browserCalls = 0;
let browserRetryFails = false;
let storageFails = false;
let switchBeforeJwt = false;
let switchWhileInflight = false;
let switchAfterSessionRead = false;
const browserClient = {
  auth: { getSession: async () => {
    const id = browserOwner;
    if (switchAfterSessionRead) { switchAfterSessionRead = false; browserOwner = otherId; }
    return { data: { session: { user: { id } } } };
  } },
  functions: { invoke: async (_name, { body }) => {
    browserCalls += 1;
    if (body.action === "retry_save") return browserRetryFails ? { data: { error: { message: "save refused" } }, error: null } : { data: { data: { persisted: true } }, error: null };
    if (switchBeforeJwt) { switchBeforeJwt = false; browserOwner = otherId; }
    if (body.expectedOwner !== browserOwner) return { data: { error: { message: "账号已切换" } }, error: null };
    if (switchWhileInflight) { switchWhileInflight = false; browserOwner = otherId; }
    return { data: { data: { action: body.action, result: "保留的内容", persisted: false, warning: "待保存", recoveryToken: "mock.token", generatedAt: new Date().toISOString() } }, error: null };
  } }
};
const browserExports = {};
const browserCode = ts.transpileModule(readFileSync("src/lib/ai.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
runInNewContext(browserCode, { ...sandbox, exports: browserExports,
  localStorage: { getItem: (key) => browserStorage.get(key) || null, setItem: (key, value) => { if (storageFails) throw new Error("quota full"); browserStorage.set(key, value); } },
  window: { dispatchEvent() {} }, CustomEvent: class { constructor(type) { this.type = type; } },
  require: (name) => name === "./supabase" ? { supabase: browserClient } : { edgeFunctionMessage: async (_error, fallback) => fallback }
});
const firstLocal = await browserExports.generateTripRecap("trip-a");
assert.equal(firstLocal.result, "保留的内容");
assert.equal(browserExports.pendingAiRecoveries(ownId).length, 1);
assert.equal(browserExports.pendingAiRecoveries(otherId).length, 0);
await browserExports.generateTripRecap("trip-a");
assert.equal(browserCalls, 1, "Viewing a pending recap does not generate/charge again");
browserOwner = otherId;
await assert.rejects(browserExports.retryAiPersistence(ownId));
assert.equal(browserCalls, 1);
browserOwner = ownId;
browserRetryFails = true;
const failedRetry = await browserExports.retryAiPersistence(ownId);
assert.equal(failedRetry.remaining, 1);
assert.equal(browserExports.pendingAiRecoveries(ownId)[0].result, "保留的内容");
browserRetryFails = false;
const localSaved = await browserExports.retryAiPersistence(ownId);
assert.equal(localSaved.saved, 1);
assert.equal(localSaved.remaining, 0);
frozenNow=Date.parse("2026-09-30T15:59:00Z");
await browserExports.generateDailySummary("la:2026-09-30");
const callsAfterOneDay = browserCalls;
frozenNow=Date.parse("2026-09-30T16:01:00Z");
await browserExports.generateDailySummary("la:2026-09-30");
assert.equal(browserCalls, callsAfterOneDay);
await browserExports.generateDailySummary("la:2026-10-01");
assert.equal(browserCalls, callsAfterOneDay + 1, "A new trip-local day does not reuse the earlier local copy");
frozenNow=undefined;
storageFails = true;
const unsavedLocal = await browserExports.polishNote("原文");
assert.equal(unsavedLocal.result, "保留的内容");
assert.ok(unsavedLocal.warning.includes("立即复制"));
storageFails = false;
browserOwner = ownId;
switchAfterSessionRead = true;
const callsBeforeSessionRace = browserCalls;
await assert.rejects(browserExports.polishNote("切换前"), /账号已切换/);
assert.equal(browserCalls, callsBeforeSessionRace, "A switch noticed before invoke does not send the request");
browserOwner = ownId;
switchBeforeJwt = true;
const ownerCopiesBefore = browserExports.pendingAiRecoveries(ownId).length;
await assert.rejects(browserExports.polishNote("JWT切换"), /账号已切换/);
assert.equal(browserExports.pendingAiRecoveries(ownId).length, ownerCopiesBefore, "A newer JWT response is never backed up under the previous user");
browserOwner = ownId;
switchWhileInflight = true;
await assert.rejects(browserExports.polishNote("请求期间切换"), /账号已切换/);
assert.equal(browserExports.pendingAiRecoveries(ownId).length, ownerCopiesBefore + 1, "A previously validated owner's failed cloud save remains isolated under that owner");
assert.equal(browserExports.pendingAiRecoveries(otherId).length, 0, "Old-account content is neither returned nor stored under the new account");
console.log("PASS: mixed-currency statistics; trip-local midnight/DST/calendar context; hotel checkout/checkin/staying/all-day and inbound flight projection; Gambier midnight respects both LA DST occurrence choices and omits unselected ambiguity; slow headers/body settle as AI_TIMEOUT with one charged attempt and cleared timers; malformed/non-object JSON stays AI_UNAVAILABLE; scoped signed recovery validation; Edge cache failure preserves content; authenticated save-only retry consumes zero additional quota/upstream; cache-read failure avoids duplicate generation; usage completion failures are checked; owner switches before JWT/in-flight never consume or expose a different account's result.");
