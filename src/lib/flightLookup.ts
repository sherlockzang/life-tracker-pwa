import { supabase } from "./supabase";
import type { ActualFlightInfo, FlightDetails, LifeRecord } from "../types";
import { edgeFunctionMessage } from "./functionError";
import { normalizeAircraftType } from "./aircraftTypes";
import { flightPlanKey } from "./flightMatchState";
import { calculateFlightDuration, flightTimeOptions, resolveFlightInstant, utcOffsetLabel } from "./flightDuration";

export interface FlightMatchPreview {
  preview: ActualFlightInfo;
  requestId: string;
  planVersion: number;
  planKey: string;
  recoveryToken?: string;
  expiresAt?: string;
  warning?: string;
  record?: LifeRecord;
  cached?: boolean;
}

export const FLIGHT_LOOKUP_ERROR = "暂时无法获取航班信息，原计划不会被修改。";

function normalizeActualInfo(info: ActualFlightInfo): ActualFlightInfo {
  return { ...info, aircraft_type: normalizeAircraftType(info.aircraft_type) };
}

export function flightMatchEligibility(record: LifeRecord, now = Date.now()) {
  if (record.transport_type !== "flight" || !record.transport_details) return { eligible: false, reason: "这不是航班计划。" };
  if (record.plan_status === "cancelled") return { eligible: false, reason: "这条航班计划已取消。恢复为计划中后才能匹配实际信息；手动记录不受影响。" };
  const flight = record.transport_details as FlightDetails;
  if (!/^[A-Z]{3}$/.test(flight.departure.iata || "") || !/^[A-Z]{3}$/.test(flight.arrival.iata || "")) return { eligible: false, reason: "这是手动机场记录。若要匹配实际航班，请先从补全列表选择正确的起降机场；基础计划不受影响。" };
  if (!flight.arrival.date || !flight.arrival.time || !flight.arrival.timezone) return { eligible: false, reason: "请先完整填写计划到达日期、时间和时区。" };
  const duration = calculateFlightDuration(flight.departure, flight.arrival);
  if (duration.status !== "ready") return { eligible: false, reason: duration.message };
  try {
    const arrival = resolveFlightInstant(flight.arrival);
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
  const eligibility = flightMatchEligibility(record);
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  if (record.flight_plan_version == null) throw new Error("请先将这条航班计划同步到云端，再匹配实际信息。当前不会调用航班接口。");
  const planVersion = record.flight_plan_version;
  const planKey = flightPlanKey(record);
  const { data: session } = await supabase.auth.getSession();
  const storageKey = session.session?.user.id ? `life-tracker-flight-preview:${session.session.user.id}:${record.id}` : null;
  if (!rematch && storageKey) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null") as { expiresAt?: number; value?: FlightMatchPreview } | null;
      if (saved?.expiresAt && saved.expiresAt > Date.now() && saved.value?.planKey === planKey && saved.value.planVersion === planVersion) return saved.value;
    } catch { /* An unavailable local cache never blocks ordinary matching. */ }
  }
  const requestId = crypto.randomUUID();
  const { data, error } = await supabase.functions.invoke("lookup-flight", { body: { action: "match", recordId: record.id, requestId, planVersion, rematch } });
  if (error) throw new Error(await edgeFunctionMessage(error, FLIGHT_LOOKUP_ERROR));
  if (data?.error) throw new Error(data.error.message || FLIGHT_LOOKUP_ERROR);
  if (data?.data?.cached) return { preview: normalizeActualInfo(data.data.actualInfo as ActualFlightInfo), requestId: data.data.requestId || requestId, planVersion, planKey, record: data.data.record as LifeRecord, cached: true };
  if (!data?.data?.preview || !data?.data?.requestId) throw new Error(FLIGHT_LOOKUP_ERROR);
  const value: FlightMatchPreview = { preview: normalizeActualInfo(data.data.preview as ActualFlightInfo), requestId: data.data.requestId as string, planVersion, planKey, recoveryToken: data.data.recoveryToken, expiresAt: data.data.expiresAt, warning: data.data.warning, cached: false };
  if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify({ expiresAt: Math.min(Date.now() + 29 * 60_000, Date.parse(value.expiresAt || "") || 0), value })); } catch { /* The in-memory preview remains usable. */ } }
  return value;
}

export async function confirmFlightActual(recordId: string, requestId: string, planVersion: number, recoveryToken?: string) {
  const { data, error } = await supabase.functions.invoke("lookup-flight", { body: { action: "confirm", recordId, requestId, planVersion, recoveryToken } });
  if (error) throw new Error(await edgeFunctionMessage(error, "实际飞行信息保存失败，请重试。"));
  if (data?.error) throw new Error(data.error.message || "实际飞行信息保存失败，请重试。");
  const record = data.data.record as LifeRecord;
  return record.actual_info ? { ...record, actual_info: normalizeActualInfo(record.actual_info) } : record;
}

export function demoFlightPreview(record: LifeRecord): FlightMatchPreview {
  const flight = record.transport_details as FlightDetails;
  const departureScheduled = demoClock(flight.departure);
  const arrivalScheduled = demoClock(flight.arrival);
  const departureActual = demoClock(flight.departure, 8);
  const arrivalActual = demoClock(flight.arrival, 4);
  const preview: ActualFlightInfo = {
    status: "landed",
    airline: flight.airline || "示例航空",
    flight_number: flight.flight_number || "LT130",
    departure: {
      airport: flight.departure.airport, iata: flight.departure.iata || "HND", timezone: flight.departure.timezone || "Asia/Tokyo",
      scheduled: departureScheduled,
      estimated: departureScheduled,
      actual: departureActual, delay_minutes: 8, terminal: flight.departure.terminal || "2", gate: flight.gate || "62"
    },
    arrival: {
      airport: flight.arrival.airport, iata: flight.arrival.iata || "HND", timezone: flight.arrival.timezone || "Asia/Tokyo",
      scheduled: arrivalScheduled,
      estimated: arrivalActual,
      actual: arrivalActual, delay_minutes: 4, terminal: flight.arrival.terminal || "3", gate: "108"
    },
    aircraft_type: normalizeAircraftType(flight.aircraft_type || "B789"),
    registration: flight.registration || "JA-demo",
    source: "aviationstack",
    matched_at: new Date().toISOString()
  };
  return { preview, requestId: `demo-${crypto.randomUUID()}`, planVersion: record.flight_plan_version ?? 1, planKey: flightPlanKey(record) };
}

function demoClock(stop: FlightDetails["departure"], delay = 0) {
  const instant = resolveFlightInstant(stop) + delay * 60_000;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: stop.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  const date = `${get("year")}-${get("month")}-${get("day")}`, time = `${get("hour")}:${get("minute")}`;
  const offset = flightTimeOptions({ date, time, timezone: stop.timezone }).find(option => option.instant === instant)!.utcOffsetMinutes;
  return { date, time, iso: `${date}T${time}:00${utcOffsetLabel(offset).slice(3)}` };
}
