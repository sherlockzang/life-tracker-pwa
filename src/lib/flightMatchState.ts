import type { FlightDetails, LifeRecord } from "../types";

// A match belongs to a segment, not to its mutable record UUID alone.
export function flightPlanKey(record: Pick<LifeRecord, "transport_type" | "transport_details">) {
  if (record.transport_type !== "flight" || !record.transport_details) return "";
  const flight = record.transport_details as FlightDetails;
  return JSON.stringify([
    flight.flight_number.replace(/\s/g, "").toUpperCase(),
    ...[flight.departure, flight.arrival].flatMap(stop => [
      (stop.iata || "").trim().toUpperCase(), stop.date, stop.time, stop.timezone || "", stop.utc_offset_minutes ?? null
    ])
  ]);
}

export function invalidateChangedFlight(previous: LifeRecord, next: LifeRecord): LifeRecord {
  if (flightPlanKey(previous) === flightPlanKey(next)) return next;
  return { ...next, actual_match_status: "never", actual_info_matched: false,
    actual_matched_at: null, actual_match_provider: null, actual_match_request_id: null,
    actual_match_plan_version: null, actual_confirmed_request_id: null, flight_plan_version: (previous.flight_plan_version ?? (previous.transport_type === "flight" ? 1 : 0)) + 1 };
}

export function flightMatchIsCurrent(record: LifeRecord) {
  if (!record.actual_info_matched || !record.actual_info || record.transport_type !== "flight" || !record.transport_details) return false;
  if (record.flight_plan_version != null) return record.actual_match_plan_version === record.flight_plan_version;
  const plan = record.transport_details as FlightDetails;
  const actual = record.actual_info;
  return actual.flight_number.replace(/\s/g, "").toUpperCase() === plan.flight_number.replace(/\s/g, "").toUpperCase()
    && actual.departure.iata === plan.departure.iata && actual.arrival.iata === plan.arrival.iata
    && (!actual.departure.scheduled.date || actual.departure.scheduled.date === plan.departure.date);
}
