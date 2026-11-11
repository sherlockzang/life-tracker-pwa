import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

// Actual pure modules and actual editor handler extracted from its AST.
// Synthetic records only; no React browser, network, production DB or APIs.
const root = process.env.LIFE_TRACKER_AUDIT_SOURCE || process.cwd();
const require = createRequire(resolve(root, "package.json")), ts = require("typescript");
const modules = new Map();
function load(file) {
  file = resolve(root, file); if (!/\.tsx?$/.test(file)) file += ".ts";
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Date, Intl, Error, console, require: dependency => load(resolve(dirname(file), dependency)) }, { filename: file });
  return exports;
}
const calendar = load("src/lib/calendar.ts"), dates = load("src/lib/tripDates.ts"), flightState = load("src/lib/flightMatchState.ts");
const transport = load("src/lib/transport.ts"), schedules = load("src/lib/schedules.ts");
const editorFile = resolve(root, "src/components/TransportPlanEditor.tsx");
const editorSource = readFileSync(editorFile, "utf8");
const ast = ts.createSourceFile(editorFile, editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
function walk(node) { if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node); ts.forEachChild(node, walk); }
walk(ast);
assert.ok(functions.has("submit") && functions.has("timeInZone"));
function extract(name, globals = {}) {
  const exports = {};
  const source = `export ${functions.get(name).getText(ast)}`;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, Date, Intl, Error, ...globals });
  return exports[name];
}
const timeInZone = extract("timeInZone");
async function submitGeneral({ day, trip, record, time, localOffset, kind = "general", rail, metro, schedule, storedSchedule }) {
  let output, error = "", closed = false, saving = false;
  const submit = extract("submit", { day, trip, record, time, localOffset, kind, rail, metro, schedule, storedSchedule, transportTitle: transport.transportTitle, scheduleValidation: schedules.scheduleValidation, normalizeScheduleDetails: schedules.normalizeScheduleDetails, content: record?.content || "synthetic plan", location: "", notes: "", count: 0,
    zonedDateTimeToIso: dates.zonedDateTimeToIso, invalidateChangedFlight: flightState.invalidateChangedFlight,
    setSaving: value => { saving = value; }, setError: value => { error = value; },
    onSave: async value => { output = value; }, onUpdate: async value => { output = value; }, onClose: () => { closed = true; } });
  await submit({ preventDefault() {} });
  return { output, error, closed, saving };
}
const results = [];
const trip = { id: "synthetic-trip", timezone: "Asia/Tokyo", start_date: "2026-09-29", end_date: "2026-09-30" };
const record = { id: "synthetic-record", user_id: "synthetic-owner", record_type: "trip", content: "00:30 Tokyo plan", event_at: "2026-09-28T15:30:00.000Z", trip_id: trip.id, transport_type: null, transport_details: null, schedule_details: null, plan_status: "planned", sort_order: 1000 };
// Positive control: editor date in the same business timezone preserves time.
const control = await submitGeneral({ day: calendar.timelineDate(record, trip.timezone), trip, record, time: timeInZone(record.event_at, trip.timezone) });
assert.equal(control.output.event_at, record.event_at);
results.push({ case: "control", observed: "same business timezone no-op edit preserves instant" });

// SA-03: grouping still uses device date, but editing uses business timezone.
assert.match(readFileSync(resolve(root, "src/components/Timeline.tsx"), "utf8"), /day=\{timelineDate\(editingRecord, editingTrip.timezone\)\}/);
const deviceZone = "America/Los_Angeles", deviceDay = calendar.timelineDate(record, deviceZone);
assert.equal(deviceDay, "2026-09-28");
const edited = await submitGeneral({ day: calendar.timelineDate(record, trip.timezone), trip, record, time: timeInZone(record.event_at, trip.timezone) });
assert.equal(edited.error, ""); assert.equal(edited.closed, true);
assert.equal(edited.output.event_at, record.event_at);

// SA-04: valid calendar date but nonexistent DST local clock must be rejected.
const gapTrip = { ...trip, timezone: "America/Los_Angeles", start_date: "2026-03-08", end_date: "2026-03-09" };
const gap = await submitGeneral({ day: "2026-03-08", trip: gapTrip, time: "02:30" });
assert.match(gap.error, /不存在/); assert.equal(gap.closed, false); assert.equal(gap.output, undefined); assert.equal(gap.saving, false);
const repeat = { ...gapTrip, start_date: "2026-11-01", end_date: "2026-11-02" };
const ambiguous = await submitGeneral({ day: "2026-11-01", trip: repeat, time: "01:30" });
assert.match(ambiguous.error, /两次/); assert.equal(ambiguous.output, undefined);
const first = await submitGeneral({ day: "2026-11-01", trip: repeat, time: "01:30", localOffset: -420 });
const second = await submitGeneral({ day: "2026-11-01", trip: repeat, time: "01:30", localOffset: -480 });
assert.equal(Date.parse(second.output.event_at) - Date.parse(first.output.event_at), 3_600_000);
const existingRepeat = { ...record, event_at: second.output.event_at.replace(":00.000Z", ":27.000Z") };
const unchanged = await submitGeneral({ day: "2026-11-01", trip: repeat, record: existingRepeat, time: "01:30" });
assert.equal(unchanged.output.event_at, existingRepeat.event_at, "No-op edit preserves original repeated occurrence and seconds");
assert.match(editorSource, /重复当地时间 · 必选/);
for (const zone of ["Asia/Tokyo", "America/Los_Angeles", "Pacific/Auckland", "Asia/Kathmandu"]) {
  const instant = dates.zonedDateTimeToIso("2026-10-02", "09:30", zone);
  assert.equal(timeInZone(instant, zone), "09:30");
}
assert.throws(() => dates.zonedDateTimeToIso("2026-02-30", "09:30", "UTC"));
for (const kind of ["rail", "metro"]) {
  const rail = { system_type: "china_hsr", train_number: "G1", departure: { date: "2026-03-08", time: "02:30", station: "A" }, arrival: { date: "2026-03-08", time: "04:00", station: "B" } };
  const metro = { origin: "A", destination: "B", estimated_departure_time: "02:30" };
  const bad = await submitGeneral({ day: "2026-03-08", trip: gapTrip, kind, rail, metro });
  assert.match(bad.error, /不存在/); assert.equal(bad.closed, false); assert.equal(bad.output, undefined);
  rail.departure = { ...rail.departure, date: "2026-11-01", time: "01:30" }; metro.estimated_departure_time = "01:30";
  const good = await submitGeneral({ day: "2026-11-01", trip: repeat, kind, rail, metro, localOffset: -480 });
  assert.equal(good.error, ""); assert.equal(good.output.event_at, second.output.event_at);
}
const allDay = { kind: "all_day", start_date: "2026-03-08", end_date: "2026-03-08" };
const dateOnly = await submitGeneral({ day: "2026-03-08", trip: gapTrip, kind: "all_day", schedule: allDay });
assert.equal(dateOnly.error, ""); assert.equal(timeInZone(dateOnly.output.event_at, gapTrip.timezone), "12:00");
const oldDateOnly = await submitGeneral({ day: "2026-03-08", trip: gapTrip, kind: "all_day", schedule: allDay, storedSchedule: allDay, record });
assert.equal(oldDateOnly.output.event_at, record.event_at, "Existing date-only anchor is not rewritten");
// Execute the actual planner drop handler, not a duplicated date conversion.
const plannerFile = resolve(root, "src/components/Planner.tsx"), plannerSource = readFileSync(plannerFile, "utf8");
const plannerAst = ts.createSourceFile(plannerFile, plannerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const plannerFunctions = new Map();
function findDrag(node) { if (ts.isFunctionDeclaration(node) && node.name) plannerFunctions.set(node.name.text, node); ts.forEachChild(node, findDrag); }
findDrag(plannerAst); assert.ok(plannerFunctions.has("handleDragEnd"));
for (const [sourceDay, targetDay, clock] of [["2026-03-07", "2026-03-08", "02:30"], ["2026-10-31", "2026-11-01", "01:30"]]) {
  const original = { ...record, event_at: dates.zonedDateTimeToIso(sourceDay, clock, gapTrip.timezone) };
  let updated = false, pending;
  const exports = {};
  const dragCode = ["planDate", "chronological", "handleDragEnd"].map(name => `export ${plannerFunctions.get(name).getText(plannerAst)}`).join("\n");
  runInNewContext(ts.transpileModule(dragCode, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Date, Intl, plans: [original], trip: gapTrip, dateInZone: dates.dateInZone, normalizeScheduleDetails: schedules.normalizeScheduleDetails, zonedDateTimeToIso: dates.zonedDateTimeToIso, invalidateChangedFlight: flightState.invalidateChangedFlight,
      onUpdateRecord: async () => { updated = true; }, setPendingFlightMove: value => { pending = value; } });
  await exports.handleDragEnd({ active: { id: original.id }, over: { id: `day:${targetDay}` } });
  assert.equal(updated, false); assert.equal(pending.day, targetDay); assert.equal(pending.original.event_at, original.event_at);
}
console.log("PASS SA-03/04: business-date no-op editing, general/rail/metro DST gap and repeat choices, exact occurrence/seconds, date-only anchor preservation, and actual planner gap/repeat drag keeps original for confirmation.");
