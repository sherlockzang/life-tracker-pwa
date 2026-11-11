import type { FlightDetails, LifeRecord, Trip } from "../types";
import { dateInZone } from "./tripDates";
import { flightTripPlacement } from "./flightTripPlacement";
import { normalizeScheduleDetails, scheduleDayEntries } from "./schedules";

export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export function validTimeZone(timeZone: string) { try { new Intl.DateTimeFormat("en", { timeZone }).format(); return true; } catch { return false; } }
export function tripToday(trip: Pick<Trip, "timezone">, now = new Date()) { return dateInZone(now.toISOString(), validTimeZone(trip.timezone) ? trip.timezone : "UTC"); }
export function tripDayNumber(trip: Pick<Trip, "start_date" | "timezone">, now = new Date()) {
  return Math.round((Date.parse(`${tripToday(trip, now)}T12:00:00Z`) - Date.parse(`${trip.start_date}T12:00:00Z`)) / 86_400_000) + 1;
}
export function activeTrip(trips: Trip[], now = new Date()) { return trips.find(trip => { const today = tripToday(trip, now); return trip.start_date <= today && trip.end_date >= today; }); }
export function plansForDay(records: LifeRecord[], trip: Trip, day: string) {
  return records.filter(record => {
    if (record.trip_id !== trip.id || record.record_type !== "trip" || record.parent_plan_id || record.plan_status === "cancelled") return false;
    if (normalizeScheduleDetails(record.schedule_details)) return scheduleDayEntries([record], day).length > 0;
    if (record.transport_type === "flight" && record.transport_details) return flightTripPlacement(record.transport_details as FlightDetails, trip).day === day;
    return dateInZone(record.event_at, validTimeZone(trip.timezone) ? trip.timezone : "UTC") === day;
  }).sort((a, b) => {
    const aAll = Boolean(normalizeScheduleDetails(a.schedule_details)), bAll = Boolean(normalizeScheduleDetails(b.schedule_details));
    return Number(bAll) - Number(aAll) || a.event_at.localeCompare(b.event_at) || a.id.localeCompare(b.id);
  });
}
export function timelineDate(record: LifeRecord, timeZone = deviceTimeZone()) {
  const schedule = normalizeScheduleDetails(record.schedule_details);
  if (schedule) return schedule.start_date;
  if (record.transport_type === "flight" && record.transport_details) return (record.transport_details as FlightDetails).departure.date;
  return dateInZone(record.event_at, timeZone);
}
export function groupTimeline(records: LifeRecord[], timeZone = deviceTimeZone()) {
  const groups = new Map<string, LifeRecord[]>();
  for (const record of records) { const date = timelineDate(record, timeZone); groups.set(date, [...(groups.get(date) || []), record]); }
  return [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([date, items]) => [date, items.sort((a, b) => b.event_at.localeCompare(a.event_at) || a.id.localeCompare(b.id))] as const);
}
