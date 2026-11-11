import { resolveFlightInstant, type FlightLocalTime } from "./flightTime.ts";

export interface SummaryTrip {
  id: string; name: string; destination: string; timezone: string;
  start_date: string; end_date: string;
}

export interface SummaryRecord {
  id: string; trip_id: string; content: string; event_at: string; plan_status: string;
  transport_type: string | null; transport_details: unknown; schedule_details: unknown;
}

export function dateInZone(iso: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validSchedule(value: unknown): Record<string, unknown> {
  const schedule = object(value);
  if (schedule.kind !== "hotel" && schedule.kind !== "all_day") return {};
  if (!validDate(schedule.start_date) || !validDate(schedule.end_date) || schedule.end_date < schedule.start_date
    || (schedule.kind === "hotel" && schedule.end_date === schedule.start_date)
    || (schedule.kind === "hotel" && [schedule.check_in_time, schedule.check_out_time].some((time) => time && typeof time === "string" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)))) return {};
  return schedule;
}

export function activeSummaryTrips(trips: SummaryTrip[], now = new Date().toISOString()) {
  return trips.flatMap((trip) => {
    const day = dateInZone(now, trip.timezone);
    return trip.start_date <= day && trip.end_date >= day ? [{ ...trip, day }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function dailySummaryContext(trips: Array<SummaryTrip & { day: string }>) {
  return JSON.stringify(trips.map((trip) => ({ id: trip.id, day: trip.day, timezone: trip.timezone })).sort((a, b) => a.id.localeCompare(b.id)));
}

export function projectDailyPlans(records: SummaryRecord[], trips: Array<SummaryTrip & { day: string }>) {
  const byTrip = new Map(trips.map((trip) => [trip.id, trip]));
  return records.flatMap((record) => {
    const trip = byTrip.get(record.trip_id);
    if (!trip || record.plan_status === "cancelled") return [];
    const schedule = validSchedule(record.schedule_details);
    const details = object(record.transport_details);
    let phase = "timed";
    let time = "";
    let sortTime = record.event_at;
    if (schedule.kind === "hotel" || schedule.kind === "all_day") {
      if (trip.day < String(schedule.start_date) || trip.day > String(schedule.end_date)) return [];
      phase = schedule.kind === "all_day" ? "all_day" : trip.day === schedule.end_date ? "check_out" : trip.day === schedule.start_date ? "check_in" : "staying";
      time = phase === "check_out" && typeof schedule.check_out_time === "string" ? schedule.check_out_time : phase === "check_in" && typeof schedule.check_in_time === "string" ? schedule.check_in_time : "全天";
      sortTime = `${trip.day}T00:00:00Z`;
    } else if (record.transport_type === "flight") {
      const departure = object(details.departure);
      const arrival = object(details.arrival);
      let day = departure.date;
      try {
        const departureIso = new Date(resolveFlightInstant({ ...departure, timezone: departure.timezone || trip.timezone } as FlightLocalTime)).toISOString();
        const arrivalIso = new Date(resolveFlightInstant({ ...arrival, timezone: arrival.timezone || trip.timezone } as FlightLocalTime)).toISOString();
        if (Date.parse(arrivalIso) <= Date.parse(departureIso)) throw new Error("Invalid flight interval");
        const departureDay = dateInZone(departureIso, trip.timezone);
        const arrivalDay = dateInZone(arrivalIso, trip.timezone);
        if (departureDay > trip.end_date || arrivalDay < trip.start_date) return [];
        day = departureDay < trip.start_date ? trip.start_date : departureDay;
        sortTime = departureIso;
      } catch {
        // Ambiguous/nonexistent clocks cannot be safely mapped to a trip day.
        // Do not guess a UTC instant or present an inferred flight in AI text.
        return [];
      }
      if (day !== trip.day) return [];
      time = typeof departure.time === "string" ? departure.time : "";
    } else {
      if (dateInZone(record.event_at, trip.timezone) !== trip.day) return [];
      time = new Intl.DateTimeFormat("en-GB", { timeZone: trip.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(record.event_at));
    }
    return [{ id: record.id, tripId: trip.id, tripName: trip.name, date: trip.day, timezone: trip.timezone, time, title: record.content, status: record.plan_status, type: record.transport_type, phase, sortTime,
      ...(record.transport_type === "flight" ? { departure: object(details.departure), arrival: object(details.arrival) } : {}),
      ...(schedule.kind === "hotel" ? { checkInDate: schedule.start_date, checkOutDate: schedule.end_date } : {}) }];
  }).sort((a, b) => {
    const phaseOrder: Record<string, number> = { check_out: 0, check_in: 1, staying: 2, all_day: 3, timed: 4 };
    return phaseOrder[a.phase] - phaseOrder[b.phase] || a.sortTime.localeCompare(b.sortTime) || a.id.localeCompare(b.id);
  }).slice(0, 40).map(({ sortTime: _sortTime, ...plan }) => plan);
}

export function aggregateExpenseCurrencies(rows: Array<{ record_type?: unknown; amount?: unknown; currency?: unknown; expense_category?: unknown }>) {
  const totals: Record<string, number> = {};
  const categories: Record<string, Record<string, number>> = {};
  const allowedCategories = new Set(["food", "transport", "shopping", "stay", "entertainment", "other"]);
  for (const row of rows) {
    if (row.record_type !== "expense" || row.amount == null || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency)) continue;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;
    const currency = row.currency;
    const category = typeof row.expense_category === "string" && allowedCategories.has(row.expense_category) ? row.expense_category : "other";
    totals[currency] = (totals[currency] || 0) + amount;
    const group = categories[currency] ||= {};
    group[category] = (group[category] || 0) + amount;
  }
  return { expenseTotals: totals, categoryTotalsByCurrency: categories };
}
