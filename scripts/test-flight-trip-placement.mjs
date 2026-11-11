import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const loaded = new Map();
function load(name) {
  if (loaded.has(name)) return loaded.get(name);
  const code = ts.transpileModule(readFileSync(name === "flightTime" ? "supabase/functions/_shared/flightTime.ts" : `src/lib/${name}.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require: path => { if(path.endsWith("_shared/flightTime")) return load("flightTime"); assert.match(path, /^\.\/(tripDates|flightDuration)$/); return load(path.slice(2)); } });
  loaded.set(name, exports);
  return exports;
}
const { flightTripPlacement: place, flightMoveOffset: offset } = load("flightTripPlacement");
const trip = { start_date: "2026-09-29", end_date: "2026-10-05", timezone: "Asia/Tokyo" };
const stop = (date, time, timezone) => ({ date, time, timezone, airport: "", terminal: "" });
const flight = (departure, arrival) => ({ departure, arrival, airline: "ANA", flight_number: "NH105" });
const incoming = flight(stop("2026-09-28", "00:50", "America/Los_Angeles"), stop("2026-09-29", "05:00", "Asia/Tokyo"));
const before = JSON.stringify(incoming);
assert.equal(place(incoming, trip).day, "2026-09-29");
assert.equal(place(incoming, trip).overlapsTrip, true);
assert.equal(place(incoming, trip).startsBeforeTrip, true);
assert.equal(place(incoming, { ...trip, start_date: "2026-09-28" }).day, "2026-09-28");
assert.equal(place(incoming, { ...trip, start_date: "2026-09-30" }).overlapsTrip, false);
// Landing date in Tokyo cannot be used blindly for a trip in Los Angeles.
assert.equal(place(incoming, { ...trip, timezone: "America/Los_Angeles" }).overlapsTrip, false);
const converted = flight(stop("2026-09-28", "17:00", "America/Los_Angeles"), stop("2026-09-29", "20:00", "Asia/Tokyo"));
assert.equal(place(converted, trip).day, "2026-09-29");
assert.equal(place(converted, trip).startsBeforeTrip, false);
const westbound = flight(stop("2026-09-30", "00:00", "Asia/Tokyo"), stop("2026-09-29", "18:00", "America/Los_Angeles"));
assert.equal(place(westbound, { ...trip, start_date: "2026-09-30" }).day, "2026-09-30");
assert.equal(place(westbound, { ...trip, start_date: "2026-09-30" }).overlapsTrip, true);
assert.equal(place(flight(stop("2026-09-27", "00:50", "America/Los_Angeles"), stop("2026-09-28", "05:00", "Asia/Tokyo")), trip).overlapsTrip, false);
assert.equal(place(flight(stop("2026-10-06", "00:50", "America/Los_Angeles"), stop("2026-10-07", "05:00", "Asia/Tokyo")), trip).overlapsTrip, false);
assert.equal(place(flight(incoming.departure, stop("2026-10-01", "05:00", "Asia/Tokyo")), { ...trip, end_date: trip.start_date }).day, trip.start_date);
const midnight = flight(stop("2026-09-28", "03:00", "America/Los_Angeles"), stop("2026-09-29", "00:00", "Asia/Tokyo"));
assert.equal(place(midnight, trip).overlapsTrip, true);
assert.equal(place({ ...incoming, arrival: { ...incoming.arrival, date: "" } }, trip).day, incoming.departure.date);
assert.equal(place(incoming, { ...trip, timezone: "Invalid/Zone" }).day, incoming.departure.date);
assert.equal(offset(incoming, trip, "2026-09-29"), 0, "Same-day reorder must not move airport-local dates");
assert.equal(offset(incoming, trip, "2026-09-30"), 2, "Moving a carry-in aligns its departure with the target trip day");
assert.equal(offset(converted, trip, "2026-09-30"), 1, "Use trip-zone departure day, not airport-local departure date");
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
for (const source of [incoming, converted]) {
  const days = offset(source, trip, "2026-09-30");
  const moved = { ...source, departure: { ...source.departure, date: shift(source.departure.date, days) }, arrival: { ...source.arrival, date: shift(source.arrival.date, days) } };
  assert.equal(place(moved, trip).day, "2026-09-30");
  const duration = load("flightDuration").calculateFlightDuration;
  assert.equal(duration(moved.departure, moved.arrival).minutes, duration(source.departure, source.arrival).minutes);
}
assert.equal(JSON.stringify(incoming), before, "Placement must not modify the saved flight");
// On the fallback day, the selected instant can land on different trip days.
const repeated=stop("2026-11-01","01:30","America/Los_Angeles");
const choiceTrip={start_date:"2026-10-31",end_date:"2026-11-02",timezone:"Pacific/Gambier"};
const choiceArrival=stop("2026-11-01","12:00","America/Los_Angeles");
assert.equal(place(flight({...repeated,utc_offset_minutes:-420},choiceArrival),choiceTrip).departureDay,"2026-10-31");
assert.equal(place(flight({...repeated,utc_offset_minutes:-480},choiceArrival),choiceTrip).departureDay,"2026-11-01");
console.log("PASS: cross-date/zone trip overlap, first-day carry-in, date-line reversal, boundaries, edited trip ranges, fallback and safe flight movement.");
