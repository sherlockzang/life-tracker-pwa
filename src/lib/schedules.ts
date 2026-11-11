import type { LifeRecord, ScheduleDetails, Trip } from "../types";

export type SchedulePhase = "all_day" | "check_in" | "staying" | "check_out";
export interface ScheduleDayEntry { record: LifeRecord; details: ScheduleDetails; phase: SchedulePhase }

export function validScheduleDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function shiftScheduleDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function scheduleNights(details: ScheduleDetails) {
  return Math.round((Date.parse(`${details.end_date}T12:00:00Z`) - Date.parse(`${details.start_date}T12:00:00Z`)) / 86_400_000);
}

export function scheduleValidation(details: ScheduleDetails) {
  if (!validScheduleDate(details.start_date) || !validScheduleDate(details.end_date)) return "请填写有效的开始和结束日期";
  if (details.kind === "hotel" && details.end_date <= details.start_date) return "退房日期应晚于入住日期；当天的短时安排请使用全天事项";
  if (details.kind === "all_day" && details.end_date < details.start_date) return "结束日期不能早于开始日期";
  if ([details.check_in_time, details.check_out_time].some((value) => value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) return "请填写有效的入住或退房时间";
  return "";
}

export function normalizeScheduleDetails(value: unknown): ScheduleDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.kind !== "all_day" && input.kind !== "hotel") return null;
  const details: ScheduleDetails = {
    kind: input.kind,
    start_date: typeof input.start_date === "string" ? input.start_date : "",
    end_date: typeof input.end_date === "string" ? input.end_date : "",
    ...(input.kind === "hotel" ? {
      check_in_time: typeof input.check_in_time === "string" ? input.check_in_time : undefined,
      check_out_time: typeof input.check_out_time === "string" ? input.check_out_time : undefined,
      booking_reference: typeof input.booking_reference === "string" ? input.booking_reference.trim() || undefined : undefined
    } : {})
  };
  return scheduleValidation(details) ? null : details;
}

export function scheduleTripDate(details: ScheduleDetails, trip: Pick<Trip, "start_date" | "end_date">) {
  const overlaps = details.start_date <= trip.end_date && details.end_date >= trip.start_date;
  return overlaps && details.start_date < trip.start_date ? trip.start_date : details.start_date;
}

export function scheduleDayEntries(records: LifeRecord[], day: string): ScheduleDayEntry[] {
  return records.flatMap((record): ScheduleDayEntry[] => {
    const details = normalizeScheduleDetails(record.schedule_details);
    if (!details || day < details.start_date || day > details.end_date) return [];
    const phase: SchedulePhase = details.kind === "all_day" ? "all_day" : day === details.end_date ? "check_out" : day === details.start_date ? "check_in" : "staying";
    return [{ record, details, phase }];
  }).sort((a, b) => {
    const order: Record<SchedulePhase, number> = { check_out: 0, check_in: 1, staying: 2, all_day: 3 };
    return order[a.phase] - order[b.phase] || a.details.start_date.localeCompare(b.details.start_date) || a.record.created_at.localeCompare(b.record.created_at) || a.record.id.localeCompare(b.record.id);
  });
}

export function scheduleDayNotice(entries: ScheduleDayEntry[]) {
  const active = entries.filter((entry) => entry.record.plan_status !== "cancelled");
  const leaving = active.filter((entry) => entry.phase === "check_out");
  const arriving = active.filter((entry) => entry.phase === "check_in");
  const overnight = active.filter((entry) => entry.phase === "staying" || entry.phase === "check_in");
  return {
    change: leaving.length && arriving.length ? `今日换酒店：从${leaving.map((entry) => entry.record.content).join("、")}退房，入住${arriving.map((entry) => entry.record.content).join("、")}。` : "",
    conflict: overnight.length > 1 ? "本晚有多条住宿安排，请核对是否重复预订或日期重叠。" : ""
  };
}

export function schedulePresentation(record: LifeRecord) {
  const details = normalizeScheduleDetails(record.schedule_details);
  if (!details) return null;
  return {
    title: record.content,
    label: details.kind === "hotel" ? "酒店住宿" : "全天事项",
    subtitle: details.kind === "hotel"
      ? `${details.start_date} 入住 → ${details.end_date} 退房 · ${scheduleNights(details)} 晚`
      : details.start_date === details.end_date ? `${details.start_date} · 全天` : `${details.start_date} — ${details.end_date} · 跨日全天`
  };
}
