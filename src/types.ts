export type RecordType = "expense" | "trip" | "note";
export type ExpenseCategory = "food" | "transport" | "shopping" | "stay" | "entertainment" | "other";
export type PlanStatus = "planned" | "completed" | "cancelled";
export type TransportType = "flight" | "rail" | "metro";
export type RailSystemType = "china_hsr" | "japan_shinkansen" | "germany_db" | "taiwan_hsr" | "other";
export type Currency = "USD" | "JPY" | "EUR" | "GBP" | "CNY" | "HKD" | "SGD" | "KRW" | "AUD" | "NZD" | "CHF" | "CAD" | "THB";
export type ThemeMode = "system" | "dark" | "light";

export interface FlightDetails {
  airline: string;
  flight_number: string;
  departure: { date: string; time: string; airport: string; terminal: string };
  arrival: { date: string; time: string; airport: string; terminal: string };
  gate?: string;
  registration?: string;
  seat?: string;
  aircraft_type?: string;
  notes?: string;
}

export interface RailDetails {
  system_type: RailSystemType;
  custom_system?: string;
  train_number: string;
  departure: { date: string; time: string; station: string };
  arrival: { date: string; time: string; station: string };
  seat_carriage?: string;
  notes?: string;
}

export interface MetroDetails {
  origin: string;
  destination: string;
  estimated_departure_time?: string;
  estimated_arrival_time?: string;
  route_description?: string;
  notes?: string;
}

export type TransportDetails = FlightDetails | RailDetails | MetroDetails;

export interface UserSettings {
  user_id: string;
  base_currency: Currency;
  theme: ThemeMode;
  created_at: string;
  updated_at: string;
}

export interface UserProfile {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  avatar_color: string;
  has_seen_onboarding: boolean;
  last_seen_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface Changelog {
  id: string;
  version: string;
  summary: string[];
  created_at: string;
}

export interface Trip {
  id: string;
  user_id: string;
  name: string;
  destination: string;
  start_date: string;
  end_date: string;
  timezone: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LifeRecord {
  id: string;
  user_id: string;
  record_type: RecordType;
  content: string;
  notes: string | null;
  amount: number | null;
  currency: Currency | null;
  expense_category: ExpenseCategory | null;
  location: string | null;
  event_at: string;
  trip_id: string | null;
  plan_status: PlanStatus | null;
  sort_order: number | null;
  parent_plan_id: string | null;
  transport_type: TransportType | null;
  transport_details: TransportDetails | null;
  image_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExchangeRate {
  id: string;
  user_id: string;
  base_currency: Currency;
  quote_currency: Currency;
  rate: number;
  rate_date: string;
  source: "api" | "manual";
  created_at: string;
  updated_at: string;
}

export interface RecordDraft {
  record_type: RecordType;
  content: string;
  notes?: string;
  amount?: number;
  currency?: Currency;
  expense_category?: ExpenseCategory;
  location?: string;
  event_at?: string;
  trip_id?: string;
  plan_status?: PlanStatus;
  sort_order?: number;
  parent_plan_id?: string;
  transport_type?: TransportType;
  transport_details?: TransportDetails;
}

export interface TripDraft {
  name: string;
  destination: string;
  start_date: string;
  end_date: string;
  timezone: string;
}

export const CURRENCIES: { code: Currency; label: string; symbol: string }[] = [
  { code: "USD", label: "美元", symbol: "$" },
  { code: "JPY", label: "日元", symbol: "¥" },
  { code: "EUR", label: "欧元", symbol: "€" },
  { code: "GBP", label: "英镑", symbol: "£" },
  { code: "CNY", label: "人民币", symbol: "¥" },
  { code: "HKD", label: "港币", symbol: "HK$" },
  { code: "SGD", label: "新加坡元", symbol: "S$" },
  { code: "KRW", label: "韩元", symbol: "₩" },
  { code: "AUD", label: "澳元", symbol: "A$" },
  { code: "NZD", label: "新西兰元", symbol: "NZ$" },
  { code: "CHF", label: "瑞士法郎", symbol: "CHF" },
  { code: "CAD", label: "加元", symbol: "C$" },
  { code: "THB", label: "泰铢", symbol: "฿" }
];

export const CATEGORY_META: Record<ExpenseCategory, { label: string; color: string }> = {
  food: { label: "餐饮", color: "#0A84FF" },
  transport: { label: "交通", color: "#8E8E93" },
  shopping: { label: "购物", color: "#636366" },
  stay: { label: "住宿", color: "#AEAEB2" },
  entertainment: { label: "娱乐", color: "#48484A" },
  other: { label: "其他", color: "#C7C7CC" }
};

export const nowLocalInput = () => {
  const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
};

export const toIso = (value: string) => new Date(value).toISOString();

export const formatMoney = (amount: number, currency: Currency) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "JPY" || currency === "KRW" ? 0 : 2
  }).format(amount);

export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short"
  }).format(new Date(iso));
