import { supabase } from "./supabase";
import { zonedDateTimeToIso } from "./tripDates";
import type { ActualFlightInfo, FlightDetails, LifeRecord } from "../types";
import { edgeFunctionMessage } from "./functionError";
import { normalizeAircraftType } from "./aircraftTypes";

export interface FlightMatchPreview {
  preview: ActualFlightInfo;
  requestId: string;
  cached?: boolean;
}

export const FLIGHT_LOOKUP_ERROR = "暂时无法获取航班信息，原计划不会被修改。";

function normalizeActualInfo(info: ActualFlightInfo): ActualFlightInfo {
  return { ...info, aircraft_type: normalizeAircraftType(info.aircraft_type) };
}

export function flightMatchEligibility(record: LifeRecord, now = Date.now()) {
  if (record.transport_type !== "flight" || !record.transport_details) return { eligible: false, reason: "这不是航班计划。" };
  const flight = record.transport_details as FlightDetails;
  if (!flight.arrival.date || !flight.arrival.time || !flight.arrival.timezone) return { eligible: false, reason: "请先完整填写计划到达日期、时间和时区。" };
  try {
    const arrival = new Date(zonedDateTimeToIso(flight.arrival.date, flight.arrival.time, flight.arrival.timezone)).getTime();
    const starts = arrival + 60 * 60 * 1000;
    const ends = arrival + 48 * 60 * 60 * 1000;
    if (now < starts) return { eligible: false, reason: "该航班尚未进入实际信息匹配范围。请先保留计划信息；航班结束约一小时后，可回来匹配实际飞行数据。", eligibleAt: new Date(starts).toISOString() };
    if (now > ends) return { eligible: false, reason: "该航班已超过自动匹配时间范围，你仍可手动补充实际信息。" };
    return { eligible: true, reason: "可以匹配实际飞行信息。", eligibleAt: new Date(starts).toISOString() };
  } catch {
    return { eligible: false, reason: "到达时区无效，请重新选择。" };
  }
}

export async function matchFlightActual(record: LifeRecord, rematch = false) {
  const requestId = crypto.randomUUID();
  const { data, error } = await supabase.functions.invoke("lookup-flight", { body: { action: "match", recordId: record.id, requestId, rematch } });
  if (error) throw new Error(await edgeFunctionMessage(error, FLIGHT_LOOKUP_ERROR));
  if (data?.error) throw new Error(data.error.message || FLIGHT_LOOKUP_ERROR);
  if (data?.data?.cached) return { preview: normalizeActualInfo(data.data.actualInfo as ActualFlightInfo), requestId: data.data.requestId || requestId, cached: true };
  if (!data?.data?.preview || !data?.data?.requestId) throw new Error(FLIGHT_LOOKUP_ERROR);
  return { preview: normalizeActualInfo(data.data.preview as ActualFlightInfo), requestId: data.data.requestId as string, cached: false };
}

export async function confirmFlightActual(recordId: string, requestId: string) {
  const { data, error } = await supabase.functions.invoke("lookup-flight", { body: { action: "confirm", recordId, requestId } });
  if (error) throw new Error(await edgeFunctionMessage(error, "实际飞行信息保存失败，请重试。"));
  if (data?.error) throw new Error(data.error.message || "实际飞行信息保存失败，请重试。");
  const record = data.data.record as LifeRecord;
  return record.actual_info ? { ...record, actual_info: normalizeActualInfo(record.actual_info) } : record;
}

export function demoFlightPreview(record: LifeRecord): FlightMatchPreview {
  const flight = record.transport_details as FlightDetails;
  const departureScheduled = `${flight.departure.date}T${flight.departure.time}:00`;
  const arrivalScheduled = `${flight.arrival.date}T${flight.arrival.time}:00`;
  const preview: ActualFlightInfo = {
    status: "landed",
    airline: flight.airline || "示例航空",
    flight_number: flight.flight_number || "LT130",
    departure: {
      airport: flight.departure.airport, iata: flight.departure.iata || "HND", timezone: flight.departure.timezone || "Asia/Tokyo",
      scheduled: { iso: departureScheduled, date: flight.departure.date, time: flight.departure.time },
      estimated: { iso: departureScheduled, date: flight.departure.date, time: flight.departure.time },
      actual: { iso: departureScheduled, date: flight.departure.date, time: addMinutes(flight.departure.time, 8) }, delay_minutes: 8, terminal: flight.departure.terminal || "2", gate: flight.gate || "62"
    },
    arrival: {
      airport: flight.arrival.airport, iata: flight.arrival.iata || "HND", timezone: flight.arrival.timezone || "Asia/Tokyo",
      scheduled: { iso: arrivalScheduled, date: flight.arrival.date, time: flight.arrival.time },
      estimated: { iso: arrivalScheduled, date: flight.arrival.date, time: addMinutes(flight.arrival.time, 4) },
      actual: { iso: arrivalScheduled, date: flight.arrival.date, time: addMinutes(flight.arrival.time, 4) }, delay_minutes: 4, terminal: flight.arrival.terminal || "3", gate: "108"
    },
    aircraft_type: normalizeAircraftType(flight.aircraft_type || "B789"),
    registration: flight.registration || "JA-demo",
    source: "aviationstack",
    matched_at: new Date().toISOString()
  };
  return { preview, requestId: `demo-${crypto.randomUUID()}` };
}

function addMinutes(time: string, minutes: number) {
  const [hour, minute] = time.split(":").map(Number);
  const total = ((hour || 0) * 60 + (minute || 0) + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
