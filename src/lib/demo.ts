import type { User } from "@supabase/supabase-js";
import type { AppData } from "./data";
import type { LifeRecord, Trip } from "../types";
import { mergeBundledReleaseNotes } from "./releaseNotes";
import { APP_VERSION } from "../version";

const KEY = "life-tracker-demo-data-v1";
export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000130";
export const DEMO_USER = { id: DEMO_USER_ID, email: "demo@lifetracker.local", user_metadata: { display_name: "演示用户" }, app_metadata: {}, aud: "authenticated", created_at: new Date(0).toISOString() } as User;

function day(offset: number) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function timestamp(date: string, time: string) {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function record(input: Partial<LifeRecord> & Pick<LifeRecord, "id" | "record_type" | "content" | "event_at">): LifeRecord {
  const created = new Date().toISOString();
  return {
    user_id: DEMO_USER_ID, notes: null, amount: null, currency: null, expense_category: null, location: null,
    trip_id: null, plan_status: null, sort_order: null, parent_plan_id: null, transport_type: null, transport_details: null,
    actual_match_status: "never", actual_info: null, actual_info_matched: false, actual_matched_at: null, actual_match_provider: null, actual_match_request_id: null,
    image_path: null, created_at: created, updated_at: created, ...input
  };
}

export function createDemoData(): AppData {
  const now = new Date().toISOString();
  const trip: Trip = {
    id: "10000000-0000-4000-8000-000000000130", user_id: DEMO_USER_ID, name: "东京慢游示例", destination: "东京",
    start_date: day(-1), end_date: day(2), timezone: "Asia/Tokyo", archived_at: null, created_at: now, updated_at: now
  };
  const flight = record({
    id: "20000000-0000-4000-8000-000000000130", record_type: "trip", content: "NH105 · LAX→HND", trip_id: trip.id, plan_status: "planned", sort_order: 0,
    event_at: timestamp(day(-1), "16:30"), transport_type: "flight",
    transport_details: {
      airline: "全日空 ANA", flight_number: "NH105",
      departure: { date: day(-2), time: "00:50", airport: "洛杉矶国际机场 (LAX)", iata: "LAX", terminal: "B", timezone: "America/Los_Angeles" },
      arrival: { date: day(-1), time: "05:00", airport: "东京羽田国际机场 (HND)", iata: "HND", terminal: "3", timezone: "Asia/Tokyo" },
      seat: "22A", notes: "演示航班可使用模拟数据体验匹配流程"
    }
  });
  const records = [
    flight,
    record({ id: "20000000-0000-4000-8000-000000000131", record_type: "trip", content: "浅草寺与隅田川散步", trip_id: trip.id, plan_status: "planned", sort_order: 1, event_at: timestamp(day(0), "09:30"), location: "浅草" }),
    record({ id: "20000000-0000-4000-8000-000000000132", record_type: "expense", content: "羽田机场咖啡", notes: "冷萃咖啡", amount: 1100, currency: "JPY", expense_category: "food", location: "羽田机场", trip_id: trip.id, event_at: timestamp(day(-1), "07:20") }),
    record({ id: "20000000-0000-4000-8000-000000000133", record_type: "note", content: "落地后第一眼看到的东京，天空比想象中更亮。", trip_id: trip.id, event_at: timestamp(day(-1), "06:10") })
  ];
  return {
    records,
    trips: [trip],
    rates: [],
    settings: { user_id: DEMO_USER_ID, base_currency: "JPY", theme: "system", created_at: now, updated_at: now },
    profile: { user_id: DEMO_USER_ID, display_name: "演示用户", avatar_url: null, avatar_color: "#0A84FF", has_seen_onboarding: true, last_seen_version: APP_VERSION, created_at: now, updated_at: now },
    changelogs: mergeBundledReleaseNotes([])
  };
}

export function loadDemoData() {
  try {
    const stored = localStorage.getItem(KEY);
    return stored ? JSON.parse(stored) as AppData : createDemoData();
  } catch {
    return createDemoData();
  }
}

export function saveDemoData(data: AppData) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function resetDemoData() {
  const data = createDemoData();
  saveDemoData(data);
  return data;
}
