import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(path, require = () => { throw new Error("Unexpected import"); }) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require });
  return exports;
}
const flightTime = load("supabase/functions/_shared/flightTime.ts");
const { calculateFlightDuration } = load("src/lib/flightDuration.ts", name => {
  assert.equal(name, "../../supabase/functions/_shared/flightTime");
  return flightTime;
});
const stop = (date, time, timezone) => ({ date, time, timezone });
const examples = [
  [stop("2026-09-27", "00:50", "America/Los_Angeles"), stop("2026-09-28", "05:00", "Asia/Tokyo"), 730, "12 小时 10 分钟"],
  [stop("2026-01-27", "00:50", "America/Los_Angeles"), stop("2026-01-28", "05:00", "Asia/Tokyo"), 670, "11 小时 10 分钟"],
  [stop("2026-09-28", "10:00", "Asia/Tokyo"), stop("2026-09-28", "04:00", "America/Los_Angeles"), 600, "10 小时"],
  [stop("2026-09-27", "23:00", "Asia/Shanghai"), stop("2026-09-28", "01:00", "Asia/Shanghai"), 120, "2 小时"],
  [stop("2026-03-08", "01:30", "America/Los_Angeles"), stop("2026-03-08", "03:30", "America/Los_Angeles"), 60, "1 小时"],
  [stop("2026-11-01", "00:30", "America/Los_Angeles"), stop("2026-11-01", "02:30", "America/Los_Angeles"), 180, "3 小时"],
  [stop("2026-09-27", "10:00", "Asia/Kathmandu"), stop("2026-09-27", "10:00", "Asia/Kolkata"), 15, "15 分钟"]
];
for (const [departure, arrival, minutes, label] of examples) {
  const result = calculateFlightDuration(departure, arrival);
  assert.equal(result.status, "ready");
  assert.equal(result.minutes, minutes);
  assert.equal(result.label, label);
}
const valid = stop("2026-09-28", "05:00", "Asia/Tokyo");
for (const invalid of [stop("2026-02-30", "05:00", "Asia/Tokyo"), stop("2026-09-27", "25:00", "Asia/Tokyo"), stop("2026-09-27", "05:00", "Invalid/Zone"), stop("2026-03-08", "02:30", "America/Los_Angeles")]) assert.equal(calculateFlightDuration(invalid, valid).status, "invalid");
assert.equal(calculateFlightDuration(valid, valid).status, "invalid");
assert.equal(calculateFlightDuration(valid, stop("2026-09-27", "05:00", "Asia/Tokyo")).status, "invalid");
assert.equal(calculateFlightDuration({ ...valid, timezone: "" }, valid).status, "incomplete");
assert.equal(calculateFlightDuration({ ...valid, time: "" }, valid).status, "incomplete");
const repeated = stop("2026-11-01", "01:30", "America/Los_Angeles");
assert.deepEqual(Array.from(flightTime.flightTimeOptions(repeated), option => [new Date(option.instant).toISOString(), option.utcOffsetMinutes]), [["2026-11-01T08:30:00.000Z", -420], ["2026-11-01T09:30:00.000Z", -480]]);
assert.equal(calculateFlightDuration(repeated, stop("2026-11-01", "02:30", "America/Los_Angeles")).status, "invalid", "Repeated clocks require an explicit choice");
for (const [offset, minutes] of [[-420,120],[-480,60]]) assert.equal(calculateFlightDuration({...repeated,utc_offset_minutes:offset},stop("2026-11-01","02:30","America/Los_Angeles")).minutes,minutes);
assert.equal(calculateFlightDuration({...repeated,utc_offset_minutes:-450},valid).status,"invalid");
assert.equal(calculateFlightDuration({...repeated,utc_offset_minutes:"-420"},valid).status,"invalid", "Offsets are numeric, not coercible strings");
assert.equal(calculateFlightDuration({...repeated,utc_offset_minutes:-420},{...repeated,utc_offset_minutes:-480}).minutes,60, "Both ends may be the same local clock with different occurrences");
const ny=stop("2026-11-01","01:30","America/New_York");
assert.deepEqual(Array.from(flightTime.flightTimeOptions(ny),option=>option.utcOffsetMinutes),[-240,-300]);
const lordHowe=stop("2026-04-05","01:45","Australia/Lord_Howe");
assert.deepEqual(Array.from(flightTime.flightTimeOptions(lordHowe),option=>option.utcOffsetMinutes),[660,630]);
assert.equal(calculateFlightDuration({...lordHowe,utc_offset_minutes:660},{...lordHowe,utc_offset_minutes:630}).minutes,30);
assert.equal(flightTime.utcOffsetLabel(-420),"UTC-07:00"); assert.equal(flightTime.utcOffsetLabel(630),"UTC+10:30");
assert.equal(flightTime.isoUtcOffsetMinutes("2026-11-01T01:30:00-08:00"),-480); assert.equal(flightTime.isoUtcOffsetMinutes("2026-11-01T01:30:00"),undefined);
const original = JSON.stringify(examples);
for (const [departure, arrival] of examples) calculateFlightDuration(departure, arrival);
assert.equal(JSON.stringify(examples), original, "Derived display must not mutate flight data");
console.log("PASS: cross-zone/date-line flights, summer/winter offsets, explicit first/second DST occurrences, both ambiguous ends, half-hour DST, fractional zones, incomplete/invalid/negative times and immutable data.");
