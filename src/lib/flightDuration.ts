import type { FlightStop } from "../types";
import { FlightTimeError, resolveFlightInstant } from "../../supabase/functions/_shared/flightTime";
export { flightTimeOptions, resolveFlightInstant, utcOffsetLabel, isoUtcOffsetMinutes } from "../../supabase/functions/_shared/flightTime";

type FlightTime = Pick<FlightStop, "date" | "time" | "timezone" | "utc_offset_minutes">;
export type FlightDuration =
  | { status: "ready"; minutes: number; label: string }
  | { status: "incomplete" | "invalid"; message: string };

// Derived display only: never persists a duration or calls an external service.
export function calculateFlightDuration(departure: FlightTime, arrival: FlightTime): FlightDuration {
  if (![departure, arrival].every(stop => stop.date && stop.time && stop.timezone)) return { status: "incomplete", message: "填写起降日期、时间及当地时区后自动计算。" };
  try {
    const minutes = Math.round((resolveFlightInstant(arrival) - resolveFlightInstant(departure)) / 60_000);
    if (minutes <= 0) return { status: "invalid", message: "降落时间须晚于起飞时间，请检查日期和两地时区。" };
    const hours = Math.floor(minutes / 60), remainder = minutes % 60;
    return { status: "ready", minutes, label: [hours > 0 ? `${hours} 小时` : "", remainder > 0 ? `${remainder} 分钟` : ""].filter(Boolean).join(" ") };
  } catch (error) {
    if (error instanceof FlightTimeError) return { status: "invalid", message: error.message };
    return { status: "invalid", message: "无法计算时长，请检查日期、当地时间和时区（包括夏令时切换）。" };
  }
}
