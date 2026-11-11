import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { randomUUID, webcrypto } from "node:crypto";
import ts from "typescript";

const NOW = Date.parse("2026-10-01T12:00:00Z");
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
const crypto = { randomUUID, subtle: webcrypto.subtle };
function load(path, require) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require, crypto, Date: Clock, Intl, TextEncoder, TextDecoder, btoa, atob, Response, Request, DOMException, AbortController, setTimeout, clearTimeout, console: { error() {} }, Deno: { env: { get: name => name === "AVIATIONSTACK_API_KEY" ? "local-mocked-key" : "local-test-only-secret" } } });
  return exports;
}
const recovery = load("supabase/functions/_shared/recovery.ts", () => { throw new Error("unexpected import"); });
const flightTime = load("supabase/functions/_shared/flightTime.ts", () => { throw new Error("unexpected import"); });
const state = load("src/lib/flightMatchState.ts", () => { throw new Error("unexpected import"); });
const user = randomUUID(), recordId = randomUUID();
const flight = { airline: "ANA", flight_number: "NH105", departure: { date: "2026-09-30", time: "15:00", airport: "Los Angeles", iata: "LAX", timezone: "America/Los_Angeles" }, arrival: { date: "2026-10-01", time: "19:00", airport: "Haneda", iata: "HND", timezone: "Asia/Tokyo" } };
const record = { id: recordId, user_id: user, transport_type: "flight", transport_details: flight, flight_plan_version: 7, actual_match_plan_version: 7, actual_confirmed_request_id: randomUUID(), actual_info_matched: true, actual_info: { flight_number: "NH105", departure: { iata: "LAX", scheduled: { date: flight.departure.date } }, arrival: { iata: "HND" } } };
assert.equal(state.flightMatchIsCurrent(record), true);
assert.equal(state.flightMatchIsCurrent({ ...record, actual_match_plan_version: 6 }), false);
for (const [side, field, value] of [["departure", "date", "2026-09-29"], ["arrival", "time", "20:00"], ["departure", "timezone", "America/New_York"], ["arrival", "iata", "NRT"], ["departure", "utc_offset_minutes", -420], ["arrival", "utc_offset_minutes", 540]]) {
  const next = { ...record, transport_details: { ...flight, [side]: { ...flight[side], [field]: value } } };
  const invalidated = state.invalidateChangedFlight(record, next);
  assert.equal(invalidated.flight_plan_version, 8);
  assert.equal(invalidated.actual_info_matched, false);
  assert.equal(invalidated.actual_match_plan_version, null);
  assert.equal(invalidated.actual_confirmed_request_id, null);
  assert.equal(invalidated.actual_info, record.actual_info, "historical payload retained");
}
assert.equal(state.invalidateChangedFlight(record, { ...record, transport_details: { ...flight, gate: "62", seat: "22A" } }).flight_plan_version, 7);
assert.equal(state.invalidateChangedFlight(record, { ...record, transport_details: { ...flight, flight_number: "NH106" } }).actual_info_matched, false);
assert.equal(state.invalidateChangedFlight(record, { ...record, transport_type: "rail" }).actual_info_matched, false);

class ApiError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }
const providerRow = { flight_status: "landed", airline: { name: "ANA" }, flight: { iata: "NH105" }, departure: { ...flight.departure, scheduled: "2026-09-30T15:00:00-07:00", actual: "2026-09-30T15:08:00-07:00" }, arrival: { ...flight.arrival, scheduled: "2026-10-01T19:00:00+09:00", actual: "2026-10-01T19:04:00+09:00" } };
function server(options = {}) {
  const counts = { upstream: 0, reserve: 0, stage: 0, confirm: 0, complete: 0, cleanup: 0 };
  let lastConfirm;
  let lastUsageStatus, lastCleanupStatus, lastUpstreamSignal;
  const errorLogs = [];
  const fakeSecret = "FAKE_SECRET_MUST_NOT_APPEAR";
  const liveTimers = new Set();
  const timedSetTimeout = (callback, ms) => {
    const timer = setTimeout(() => { liveTimers.delete(timer); callback(); }, options.hang ? 5 : ms);
    liveTimers.add(timer); return timer;
  };
  const timedClearTimeout = timer => { liveTimers.delete(timer); clearTimeout(timer); };
  const actualRecord = { ...record, actual_info_matched: options.cached === true, actual_match_request_id: options.staged?.request_id || null, ...(options.record || {}) };
  class ServerClock extends Date { constructor(...args) { super(...(args.length ? args : [options.now ?? NOW])); } static now() { return options.now ?? NOW; } }
  const admin = { from(table) {
    const filters = {};
    const query = { select() { return this; }, eq(key, value) { filters[key] = value; return this; }, gt() { return this; }, order() { return this; }, limit() { return this; }, async maybeSingle() {
      if (table === "records") return { data: actualRecord, error: options.readError ? {} : null };
      assert.equal(table, "flight_match_previews");
      if (filters.plan_version !== undefined) assert.equal(filters.plan_version, 7);
      return { data: options.staged || null, error: options.previewReadError ? {} : null };
    } }; return query;
  }, async rpc(name, args) {
    if (name === "claim_flight_match_v2") return { data: options.claimCancelled ? { ok: false, code: "FLIGHT_CANCELLED" } : options.claimChanged ? { ok: false, code: "PLAN_CHANGED" } : { ok: true, record: actualRecord, cached: false }, error: null };
    if (name === "stage_flight_match_v2") { counts.stage++; if (options.stageThrow) throw new TypeError("mock network loss"); return { data: options.stageCancelled ? { ok: false, code: "FLIGHT_CANCELLED" } : options.stageChanged ? { ok: false, code: "PLAN_CHANGED" } : { ok: true }, error: options.stageError ? {} : null }; }
    if (name === "confirm_flight_match_v2") { counts.confirm++; lastConfirm = args; return { data: options.confirmCancelled ? { ok: false, code: "FLIGHT_CANCELLED" } : options.confirmChanged ? { ok: false, code: "PLAN_CHANGED" } : { ok: true, record }, error: options.confirmError ? {} : null }; }
    assert.equal(name, "finish_flight_match"); counts.cleanup++; lastCleanupStatus = args.p_status; return { data: { ok: true }, error: null };
  } };
  const api = { admin: () => admin, ApiError, authenticatedUser: async () => ({ id: options.userId || user }), completeUsage: async (_requestId, status) => { counts.complete++; lastUsageStatus = status; if (options.usageError) throw new Error("usage persistence failed"); }, errorResponse: (_origin, _id, error) => { errorLogs.push(error.message); return new Response(JSON.stringify({ error: { code: error.code || "INTERNAL_ERROR", message: error.message } }), { status: error.status || 503 }); }, json: (_origin, _id, body) => new Response(JSON.stringify(body)), preflight: () => null, readJson: request => request.json(), requestOrigin: () => "http://localhost:3000", reserveQuota: async () => { counts.reserve++; }, stringField: value => value };
  const mockedFetch = async (_input, init) => {
    counts.upstream++; lastUpstreamSignal = init.signal;
    // Ignore abort on purpose: a deadline must settle both these transports.
    if (options.hang === "headers") return new Promise(() => {});
    if (options.hang === "body") return { ok: true, status: 200, json: () => new Promise(() => {}) };
    if (options.networkError) throw new TypeError(`Fetch failed URL=https://example.test?access_key=${fakeSecret} Authorization=Bearer ${fakeSecret}`);
    if (options.malformed) return new Response("{invalid");
    if ("json" in options) return new Response(JSON.stringify(options.json));
    return new Response(JSON.stringify({ data: options.noMatch ? [] : options.providerRows || [providerRow] }));
  };
  const upstream = {};
  const upstreamCode = ts.transpileModule(readFileSync("supabase/functions/_shared/upstream.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(upstreamCode, { exports: upstream, fetch: mockedFetch, AbortController, DOMException, setTimeout: timedSetTimeout, clearTimeout: timedClearTimeout });
  const code = ts.transpileModule(readFileSync("supabase/functions/lookup-flight/index.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require: path => path.includes("_shared/api") ? api : path.includes("_shared/recovery") ? recovery : path.includes("_shared/flightTime") ? flightTime : path.includes("_shared/upstream") ? upstream : {}, crypto, Date: ServerClock, Intl, URL, Response, Request, DOMException, AbortController, setTimeout: timedSetTimeout, clearTimeout: timedClearTimeout, console: { error(...args) { errorLogs.push(args); } }, Deno: { env: { get: name => name === "AVIATIONSTACK_API_KEY" ? "local-mocked-key" : "local-test-only-secret" } } });
  return { counts, lastConfirm: () => lastConfirm, lastUsageStatus: () => lastUsageStatus, lastCleanupStatus: () => lastCleanupStatus, lastUpstreamSignal: () => lastUpstreamSignal, liveTimers, errorLogs, request: async (body) => {
    const response = await exports.default.fetch(new Request("http://localhost/lookup-flight", { method: "POST", body: JSON.stringify({ action: "match", recordId, requestId: randomUUID(), planVersion: 7, ...body }) }));
    return { status: response.status, body: await response.json() };
  } };
}
for (const failure of [{ readError: true }, { previewReadError: true }, { claimChanged: true }]) {
  const fixture = server(failure); const result = await fixture.request({});
  assert.ok(result.status >= 400); assert.equal(fixture.counts.upstream, 0); assert.equal(fixture.counts.reserve, 0);
}
// F04: skip malformed inner rows while preserving one valid exact match.
const mixedRows=server({providerRows:[null,[],true,{departure:null},{...providerRow,arrival:[]},providerRow]});
const mixedResult=await mixedRows.request({});assert.equal(mixedResult.status,200);assert.equal(mixedResult.body.data.preview.flight_number,"NH105");
assert.equal(mixedRows.counts.upstream,1);assert.equal(mixedRows.counts.reserve,1);assert.equal(mixedRows.counts.stage,1);
const invalidRows=server({providerRows:[null,[],true,{departure:null}]});
assert.equal((await invalidRows.request({})).body.error.code,"API_UNAVAILABLE");assert.equal(invalidRows.counts.complete,1);assert.equal(invalidRows.counts.cleanup,1);assert.equal(invalidRows.counts.stage,0);
const stale = server();
assert.equal((await stale.request({ planVersion: 6 })).body.error.code, "PLAN_CHANGED");
assert.equal(stale.counts.upstream, 0);
assert.equal((await stale.request({ planVersion: null })).body.error.code, "PLAN_VERSION_REQUIRED");
const legacyMatch=server();
const legacyResult=await legacyMatch.request({planVersion:undefined});
assert.equal(legacyResult.status,200); assert.equal(legacyResult.body.data.planVersion,7);
assert.equal(legacyMatch.counts.upstream,1); assert.equal(legacyMatch.counts.reserve,1);
const legacyPreviewId=randomUUID();
const legacyConfirm=server({staged:{request_id:legacyPreviewId,plan_version:7}});
assert.equal((await legacyConfirm.request({action:"confirm",requestId:legacyPreviewId,planVersion:undefined})).status,200);
assert.equal(legacyConfirm.lastConfirm().p_plan_version,7); assert.equal(legacyConfirm.counts.upstream,0); assert.equal(legacyConfirm.counts.reserve,0);
const staleLegacyConfirm=server({staged:{request_id:legacyPreviewId,plan_version:6},confirmChanged:true});
assert.equal((await staleLegacyConfirm.request({action:"confirm",requestId:legacyPreviewId,planVersion:undefined})).body.error.code,"PLAN_CHANGED");
assert.equal(staleLegacyConfirm.lastConfirm().p_plan_version,6,"Legacy preview retains its old version instead of acquiring the current version");
const legacyConfirmed=server({cached:true});
assert.equal((await legacyConfirmed.request({action:"confirm",requestId:record.actual_confirmed_request_id,planVersion:undefined})).status,200);
assert.equal(legacyConfirmed.lastConfirm().p_plan_version,7);
const unprovedLegacy=server({cached:true});
assert.equal((await unprovedLegacy.request({action:"confirm",requestId:randomUUID(),planVersion:undefined})).body.error.code,"PREVIEW_EXPIRED");
assert.equal(unprovedLegacy.counts.confirm,0); assert.equal(unprovedLegacy.counts.upstream,0);
const cache = server({ cached: true });
const cached = await cache.request({});
assert.equal(cached.body.data.cached, true);
assert.equal(cached.body.data.requestId, record.actual_confirmed_request_id);
assert.equal(cache.counts.upstream, 0);
for(const options of [{record:{plan_status:"cancelled"}},{record:{plan_status:"cancelled"},cached:true},{claimCancelled:true}]) {
  const fixture=server(options),result=await fixture.request({});
  assert.equal(result.body.error.code,"FLIGHT_CANCELLED"); assert.equal(result.status,409); assert.equal(fixture.counts.reserve,0); assert.equal(fixture.counts.upstream,0);
}
const cancelledConfirm=server({confirmCancelled:true});
assert.equal((await cancelledConfirm.request({action:"confirm"})).body.error.code,"FLIGHT_CANCELLED");assert.equal(cancelledConfirm.counts.upstream,0);assert.equal(cancelledConfirm.counts.reserve,0);
const cancelledDuringUpstream=server({stageCancelled:true});
assert.equal((await cancelledDuringUpstream.request({})).body.error.code,"FLIGHT_CANCELLED");assert.equal(cancelledDuringUpstream.counts.stage,1);assert.equal(cancelledDuringUpstream.counts.confirm,0);
for (const [arrival, expected] of [[{ date: "2026-10-02" }, "FLIGHT_NOT_COMPLETED"], [{ date: "2026-09-28" }, "MATCH_WINDOW_EXPIRED"], [{ time: "25:00" }, "INCOMPLETE_FLIGHT_PLAN"], [{ date: "2026-02-30" }, "INVALID_FLIGHT_TIME"], [{ timezone: "Invalid/Zone" }, "INVALID_TIMEZONE"]]) {
  const fixture = server({ record: { transport_details: { ...flight, departure: { ...flight.departure, date: "2026-02-01" }, arrival: { ...flight.arrival, ...arrival } } } });
  assert.equal((await fixture.request({})).body.error.code, expected);
  assert.equal(fixture.counts.upstream, 0); assert.equal(fixture.counts.reserve, 0);
}

for (const failure of [{ stageError: true }, { stageThrow: true }, { usageError: true }, { stageError: true, usageError: true }]) {
  const fixture = server(failure); const result = await fixture.request({});
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.ok(result.body.data.preview); assert.ok(result.body.data.warning); assert.ok(result.body.data.recoveryToken);
  const preview = result.body.data;
  const confirmed = await fixture.request({ action: "confirm", requestId: preview.requestId, recoveryToken: preview.recoveryToken });
  assert.equal(confirmed.status, 200); assert.equal(fixture.counts.upstream, 1); assert.equal(fixture.counts.reserve, 1);
  assert.equal(fixture.lastConfirm().p_actual_info.flight_number, "NH105");
  const anotherAccount = server({ userId: randomUUID() });
  assert.equal((await anotherAccount.request({ action: "confirm", requestId: preview.requestId, recoveryToken: preview.recoveryToken })).status, 403);
  assert.equal(anotherAccount.counts.confirm, 0);
  assert.equal(anotherAccount.counts.reserve, 0);
  const changed = server({ confirmChanged: true });
  assert.equal((await changed.request({ action: "confirm", requestId: preview.requestId, recoveryToken: preview.recoveryToken })).body.error.code, "PLAN_CHANGED");
  assert.equal(changed.counts.upstream, 0);
}
const editedDuringLookup = server({ stageChanged: true });
assert.equal((await editedDuringLookup.request({})).body.error.code, "PLAN_CHANGED");
assert.equal(editedDuringLookup.counts.upstream, 1);

for (const hang of ["headers", "body"]) {
  const fixture = server({ hang });
  const result = await fixture.request({});
  assert.equal(result.status, 504);
  assert.equal(result.body.error.code, "API_TIMEOUT");
  assert.equal(fixture.counts.reserve, 1, "The timed-out call retains one reserved attempt, without retry or refund");
  assert.equal(fixture.counts.upstream, 1);
  assert.equal(fixture.counts.complete, 1);
  assert.equal(fixture.lastUsageStatus(), "upstream_error");
  assert.equal(fixture.counts.cleanup, 1, "The pending flight claim is released after deadline");
  assert.equal(fixture.lastCleanupStatus(), "failed");
  assert.equal(fixture.counts.stage, 0);
  assert.equal(fixture.counts.confirm, 0);
  assert.equal(fixture.lastUpstreamSignal().aborted, true);
  assert.equal(fixture.liveTimers.size, 0, "Hard-deadline timers are cleared even when transport ignores abort");
}
for (const options of [{ malformed: true }, ...[null, 7, "wrong envelope", [], true].map(json => ({ json }))]) {
  const fixture = server(options);
  const result = await fixture.request({});
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "API_UNAVAILABLE", "Non-object or malformed provider JSON remains a provider error, not an internal TypeError or timeout");
  assert.equal(fixture.counts.reserve, 1);
  assert.equal(fixture.counts.upstream, 1);
  assert.equal(fixture.counts.stage, 0);
  assert.equal(fixture.counts.confirm, 0);
  assert.equal(fixture.liveTimers.size, 0);
}
const networkFailure = server({ networkError: true });
const networkResponse = await networkFailure.request({});
assert.equal(networkResponse.status, 503);
assert.equal(JSON.stringify(networkResponse).includes("FAKE_SECRET_MUST_NOT_APPEAR"), false);
assert.equal(JSON.stringify(networkFailure.errorLogs).includes("FAKE_SECRET_MUST_NOT_APPEAR"), false, "Transport URLs and Authorization diagnostics never reach response or console logs");
assert.equal(networkFailure.counts.stage, 0);
assert.equal(networkFailure.liveTimers.size, 0);

const repeatedPlan = { ...flight, departure: { ...flight.departure, date: "2026-11-01", time: "01:30" }, arrival: { ...flight.arrival, date: "2026-11-02", time: "03:30" } };
const repeatedNow = Date.parse("2026-11-02T00:00:00Z");
for(const [offset,expected] of [[undefined,"AMBIGUOUS_FLIGHT_TIME"],[-450,"INVALID_FLIGHT_OFFSET"],["-420","INVALID_FLIGHT_OFFSET"]]) {
  const fixture=server({now:repeatedNow,record:{transport_details:{...repeatedPlan,departure:{...repeatedPlan.departure,utc_offset_minutes:offset}}}});
  assert.equal((await fixture.request({planVersion:undefined})).body.error.code,expected); assert.equal(fixture.counts.reserve,0); assert.equal(fixture.counts.upstream,0);
}
const repeatedRows=[-420,-480].map(offset=>({...providerRow,registration:`offset-${offset}`,departure:{...providerRow.departure,scheduled:`2026-11-01T01:30:00${offset===-420?"-07:00":"-08:00"}`},arrival:{...providerRow.arrival,scheduled:"2026-11-02T03:30:00+09:00"},aircraft:{registration:`offset-${offset}`}}));
for(const offset of [-420,-480]) {
  const fixture=server({now:repeatedNow,record:{transport_details:{...repeatedPlan,departure:{...repeatedPlan.departure,utc_offset_minutes:offset}}},providerRows:repeatedRows});
  const result=await fixture.request({}); assert.equal(result.status,200,JSON.stringify(result.body)); assert.equal(result.body.data.preview.registration,`offset-${offset}`);
}
const wrongProvider=server({now:repeatedNow,record:{transport_details:{...repeatedPlan,departure:{...repeatedPlan.departure,utc_offset_minutes:-480}}},providerRows:[repeatedRows[0]]});
assert.equal((await wrongProvider.request({})).body.error.code,"NO_EXACT_MATCH");
const noOffsetProvider=server({now:repeatedNow,record:{transport_details:{...repeatedPlan,departure:{...repeatedPlan.departure,utc_offset_minutes:-480}}},providerRows:[{...repeatedRows[1],departure:{...repeatedRows[1].departure,scheduled:"2026-11-01T01:30:00"}}]});
assert.equal((await noOffsetProvider.request({})).body.error.code,"NO_EXACT_MATCH");
const arrivalPlan={...flight,departure:{...flight.departure,date:"2026-11-01",time:"00:30"},arrival:{...flight.arrival,date:"2026-11-01",time:"01:30",timezone:"America/Los_Angeles",iata:"SFO"}};
const arrivalNow=Date.parse("2026-11-01T09:45:00Z");
const arrivalRows=[-420,-480].map(offset=>({...providerRow,departure:{...providerRow.departure,scheduled:"2026-11-01T00:30:00-07:00"},arrival:{...providerRow.arrival,iata:"SFO",timezone:"America/Los_Angeles",scheduled:`2026-11-01T01:30:00${offset===-420?"-07:00":"-08:00"}`}}));
for(const [offset,status] of [[-420,200],[-480,400]]) {
  const fixture=server({now:arrivalNow,record:{transport_details:{...arrivalPlan,arrival:{...arrivalPlan.arrival,utc_offset_minutes:offset}}},providerRows:arrivalRows});
  const result=await fixture.request({}); assert.equal(result.status,status,JSON.stringify(result.body));
  assert.equal(fixture.counts.reserve,status===200?1:0);assert.equal(fixture.counts.upstream,status===200?1:0);
  if(status===400)assert.equal(result.body.error.code,"FLIGHT_NOT_COMPLETED");
}

// Client retry uses the per-account short-lived preview, not another lookup.
const storage = new Map(); let invokes = 0; let account = user;
const tripDates = load("src/lib/tripDates.ts", () => ({}));
const duration = load("src/lib/flightDuration.ts", () => flightTime);
const modules = { "./flightMatchState": state, "./tripDates": tripDates, "./flightDuration": duration, "./aircraftTypes": { normalizeAircraftType: value => value }, "./functionError": { edgeFunctionMessage: async () => "mock error" }, "./supabase": { supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: account } } } }) }, functions: { invoke: async () => { invokes++; return { data: { data: { preview: { ...record.actual_info, aircraft_type: "B789" }, requestId: randomUUID(), recoveryToken: "mock", expiresAt: new Clock(NOW + 20 * 60_000).toISOString() } }, error: null }; } } } } };
const lookupCode = ts.transpileModule(readFileSync("src/lib/flightLookup.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const lookup = {};
runInNewContext(lookupCode, { exports: lookup, require: name => modules[name], crypto, Date: Clock, Intl, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } });
await lookup.matchFlightActual(record); await lookup.matchFlightActual(record); assert.equal(invokes, 1);
account = randomUUID(); await lookup.matchFlightActual(record); assert.equal(invokes, 2);
await lookup.matchFlightActual({ ...record, flight_plan_version: 8 }); assert.equal(invokes, 3);
await assert.rejects(() => lookup.matchFlightActual({ ...record, flight_plan_version: undefined }), /同步到云端/);
await assert.rejects(() => lookup.matchFlightActual({ ...record, transport_details: { ...flight, departure: { ...flight.departure, iata: "" } } }), /手动机场/);
assert.equal(lookup.flightMatchEligibility({...record,plan_status:"cancelled"}).eligible,false);
await assert.rejects(() => lookup.matchFlightActual({...record,plan_status:"cancelled"}),/已取消/);
assert.equal(lookup.flightMatchEligibility({...record,plan_status:"planned"}).eligible,true);
assert.equal(invokes, 3);
const repeatedArrival = { ...record, transport_details: { ...flight, departure: { ...flight.departure, date:"2026-10-31",time:"22:00",timezone:"America/Los_Angeles" }, arrival: { ...flight.arrival, date:"2026-11-01",time:"01:30",timezone:"America/Los_Angeles" } } };
assert.equal(lookup.flightMatchEligibility(repeatedArrival,Date.parse("2026-11-01T09:00:00Z")).eligible,false);
assert.equal(lookup.flightMatchEligibility({...repeatedArrival,transport_details:{...repeatedArrival.transport_details,arrival:{...repeatedArrival.transport_details.arrival,utc_offset_minutes:-420}}},Date.parse("2026-11-01T09:45:00Z")).eligible,true);
assert.equal(lookup.flightMatchEligibility({...repeatedArrival,transport_details:{...repeatedArrival.transport_details,arrival:{...repeatedArrival.transport_details.arrival,utc_offset_minutes:-480}}},Date.parse("2026-11-01T09:45:00Z")).eligible,false);
const editor = readFileSync("src/components/TransportPlanEditor.tsx", "utf8");
assert.ok(editor.includes("confirmFlightActual(record.id, preview.requestId, preview.planVersion, preview.recoveryToken)"));
assert.ok(!editor.includes("onUpdate(preview.record"), "Even an existing matched cache must be revalidated on explicit confirmation, since another window may edit the plan while the dialog is open");
const migration = readFileSync("supabase/migrations/20261111172354_flight_integrity.sql", "utf8");
assert.ok(migration.includes("create trigger flight_previews_legacy_version before insert"));
assert.ok(migration.includes("r.actual_match_request_id is distinct from new.request_id"));
assert.ok(migration.includes("public.flight_plan_signature('flight', actual_plan) is distinct from public.flight_plan_signature(r.transport_type, r.transport_details)"));
assert.ok(migration.includes("return public.confirm_flight_match_v2(p_user_id, p_record_id, p_request_id, preview_version, null)"));
assert.ok(migration.includes("actual_confirmed_request_id = p_request_id"), "Rematch confirmations distinguish confirmed payload from the pending claim");
assert.ok(migration.includes("coalesce(p_details->'departure'->'utc_offset_minutes', 'null'::jsonb)"));
assert.ok(migration.includes("coalesce(p_details->'arrival'->'utc_offset_minutes', 'null'::jsonb)"));
assert.ok(migration.includes("public.flight_iso_offset_minutes(new.actual_info->'departure'->'scheduled'->>'iso')"),"Legacy proofs also bind explicit UTC occurrence");
assert.ok(migration.includes("when selected = 'null'::jsonb then cardinality(offsets) = 1"),"Legacy omitted choices are valid only for unique local clocks");
assert.equal((migration.match(/if r\.plan_status = 'cancelled' then/g)||[]).length,5,"New/legacy claim, stage, confirm and legacy finish must fail closed while cancelled");
console.log("PASS: flight semantic edits invalidate match; gate/seat preserve; stale/malformed plans and read failures cost no quota; version-bound confirmation; old PWA match and provable confirm compatibility; signed preview persistence retry with no new upstream; account-bound recovery and preview cache; usage-write failures retain results; slow headers/body settle as API_TIMEOUT with one charged attempt, released claim, no preview, and cleared timers; malformed/non-object JSON stays API_UNAVAILABLE.");
