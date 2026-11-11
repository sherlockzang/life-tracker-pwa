import { flightTimeOptions, resolveFlightInstant } from "../../supabase/functions/_shared/flightTime";

export function dateInZone(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function zonedDateTimeToIso(date: string, time: string, timeZone: string, utcOffsetMinutes?: number, previousIso?: string) {
  const stop = { date, time: time || "09:00", timezone: timeZone };
  const options = flightTimeOptions(stop);
  const previous = previousIso ? Date.parse(previousIso) : NaN;
  const original = options.find(option => option.instant === Math.floor(previous / 60_000) * 60_000);
  const instant = resolveFlightInstant({ ...stop, utc_offset_minutes: utcOffsetMinutes ?? original?.utcOffsetMinutes });
  // A no-op edit keeps seconds and the occurrence of a repeated local clock.
  return original?.instant === instant ? new Date(previous).toISOString() : new Date(instant).toISOString();
}
