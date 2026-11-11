import type { ActualFlightStop, FlightDetails, FlightStop, LifeRecord } from "../types";
import { normalizeAircraftType } from "./aircraftTypes";
import { flightMatchIsCurrent } from "./flightMatchState";
import { flightTimeOptions, isoUtcOffsetMinutes } from "./flightDuration";

export type FlightClockSource = "actual" | "estimated" | "scheduled" | "planned";
export const FLIGHT_CLOCK_LABELS: Record<FlightClockSource, string> = {
  actual: "实际", estimated: "预计（接口）", scheduled: "排定（接口）", planned: "计划值（接口未提供）"
};

export function flightStatusLabel(status: string) {
  return ({ landed: "已抵达", active: "飞行中", scheduled: "计划中", cancelled: "已取消", incident: "异常", diverted: "已备降" } as Record<string, string>)[status] || status || "已匹配";
}

function displayStop(plan: FlightStop, actual?: ActualFlightStop) {
  let source: FlightClockSource = "planned";
  if (actual) {
    source = (["actual", "estimated", "scheduled"] as const).find((key) => actual[key]?.date && actual[key]?.time) || "planned";
  }
  const clock = source !== "planned" && actual ? actual[source] : plan;
  const timezone = source === "planned" ? plan.timezone : actual?.timezone || plan.timezone;
  // Some provider clocks carry +00:00 alongside an airport-local timezone.
  // Treat the offset as proof only if it is valid for the displayed local clock;
  // a unique clock remains usable, but an ambiguous clock stays unresolved.
  const offset = source === "planned" ? plan.utc_offset_minutes : (() => {
    const value = isoUtcOffsetMinutes("iso" in clock ? clock.iso : null);
    if (value == null) return undefined;
    try { return flightTimeOptions({ date: clock.date, time: clock.time, timezone }).some(option => option.utcOffsetMinutes === value) ? value : undefined; }
    catch { return undefined; }
  })();
  return {
    source,
    stop: { ...plan, date: clock.date, time: clock.time, airport: actual?.airport || plan.airport, iata: actual?.iata || plan.iata, terminal: actual?.terminal || plan.terminal, timezone, utc_offset_minutes: offset }
  };
}

/** A derived view only: never overwrite the user's original plan with provider data. */
export function flightDisplay(record: LifeRecord) {
  if (record.transport_type !== "flight" || !record.transport_details) return null;
  const plan = record.transport_details as FlightDetails;
  const actual = flightMatchIsCurrent(record) ? record.actual_info : null;
  const departure = displayStop(plan.departure, actual?.departure);
  const arrival = displayStop(plan.arrival, actual?.arrival);
  const details: FlightDetails = {
    ...plan,
    airline: actual?.airline || plan.airline,
    flight_number: actual?.flight_number || plan.flight_number,
    departure: departure.stop,
    arrival: arrival.stop,
    gate: actual?.departure.gate || plan.gate,
    aircraft_type: normalizeAircraftType(actual?.aircraft_type || plan.aircraft_type || "") || undefined,
    registration: actual?.registration || plan.registration
  };
  const bothActual = departure.source === "actual" && arrival.source === "actual";
  const hasPlanClock = departure.source === "planned" || arrival.source === "planned";
  return {
    details, plan, actual, matched: Boolean(actual),
    departureSource: departure.source, arrivalSource: arrival.source,
    durationLabel: !actual ? "计划飞行时长" : bothActual ? "实际起降用时" : hasPlanClock ? "参考起降用时（含计划值）" : "匹配起降用时",
    durationDescription: !actual ? undefined : "按下方两地时间及其时区换算；接口缺失项使用标注的计划值。起降用时不等于纯空中飞行时间。"
  };
}
