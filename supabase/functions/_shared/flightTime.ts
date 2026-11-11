// Pure Intl resolver shared by browser and Edge. A repeated local clock never
// silently picks a UTC instant: the caller must select one of the valid offsets.
export interface FlightLocalTime {
  date: string;
  time: string;
  timezone?: string;
  utc_offset_minutes?: number;
}
export interface FlightTimeOption { instant: number; utcOffsetMinutes: number; }
export class FlightTimeError extends Error {
  constructor(public code: "INCOMPLETE_FLIGHT_PLAN" | "INVALID_TIMEZONE" | "INVALID_FLIGHT_TIME" | "AMBIGUOUS_FLIGHT_TIME" | "INVALID_FLIGHT_OFFSET", message: string) { super(message); }
}
const cache = new Map<string, FlightTimeOption[]>();

export function utcOffsetLabel(minutes: number) {
  return `UTC${minutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
}

export function isoUtcOffsetMinutes(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  if (/Z$/i.test(value)) return 0;
  const match = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (!match || Number(match[2]) > 14 || Number(match[3]) > 59) return undefined;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

export function flightTimeOptions(stop: FlightLocalTime): FlightTimeOption[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stop.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(stop.time) || !stop.timezone) throw new FlightTimeError("INCOMPLETE_FLIGHT_PLAN", "请完整填写有效的起降日期、时间及当地时区。");
  const key = `${stop.timezone}|${stop.date}|${stop.time}`;
  const saved = cache.get(key);
  if (saved) return saved.map(option => ({ ...option }));
  const [year, month, day] = stop.date.split("-").map(Number);
  const [hour, minute] = stop.time.split(":").map(Number);
  const targetDate = new Date(0);
  targetDate.setUTCFullYear(year, month - 1, day); targetDate.setUTCHours(hour, minute, 0, 0);
  const target = targetDate.getTime();
  if (targetDate.toISOString().slice(0, 10) !== stop.date) throw new FlightTimeError("INVALID_FLIGHT_TIME", "起降日期无效，请检查月份和日期。");
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: stop.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); }
  catch { throw new FlightTimeError("INVALID_TIMEZONE", "航班时区无效，请重新选择。"); }
  const represented = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value || 0);
    const date = new Date(0);
    date.setUTCFullYear(get("year"), get("month") - 1, get("day")); date.setUTCHours(get("hour"), get("minute"), get("second"), 0);
    return date.getTime();
  };
  // Collect both sides of nearby transitions, including half-hour DST. The
  // round-trip below accepts only actual instants of the exact requested clock.
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 1) {
    const sample = target + hours * 3_600_000;
    offsets.add((represented(sample) - sample) / 60_000);
  }
  const options = [...offsets].map(utcOffsetMinutes => ({ instant: target - utcOffsetMinutes * 60_000, utcOffsetMinutes }))
    .filter(option => represented(option.instant) === target).sort((a, b) => a.instant - b.instant);
  if (!options.length) throw new FlightTimeError("INVALID_FLIGHT_TIME", "该当地时间不存在，请检查日期及夏令时切换。");
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(key, options);
  return options.map(option => ({ ...option }));
}

export function resolveFlightInstant(stop: FlightLocalTime): number {
  const options = flightTimeOptions(stop);
  if (stop.utc_offset_minutes != null) {
    const selected = Number.isInteger(stop.utc_offset_minutes) ? options.find(option => option.utcOffsetMinutes === stop.utc_offset_minutes) : undefined;
    if (!selected) throw new FlightTimeError("INVALID_FLIGHT_OFFSET", "所选 UTC 偏移不适用于这一天，请重新选择当地时间的第一次或第二次。");
    return selected.instant;
  }
  if (options.length > 1) throw new FlightTimeError("AMBIGUOUS_FLIGHT_TIME", "该当地时间因夏令时结束出现两次，请选择第一次或第二次（UTC 偏移）后再保存或匹配。");
  return options[0].instant;
}
