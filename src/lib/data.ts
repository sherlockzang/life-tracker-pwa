import type { User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { listMutations, loadSnapshot, queueMutation, removeMutation, saveSnapshot } from "./offline";
import type { Currency, ExchangeRate, LifeRecord, RecordDraft, Trip, TripDraft, UserSettings } from "../types";

export interface AppData {
  records: LifeRecord[];
  trips: Trip[];
  rates: ExchangeRate[];
  settings: UserSettings;
}

const now = () => new Date().toISOString();

export function defaultSettings(userId: string): UserSettings {
  const timestamp = now();
  return {
    user_id: userId,
    base_currency: "USD",
    theme: "system",
    created_at: timestamp,
    updated_at: timestamp
  };
}

const normalizeRecord = (row: Record<string, unknown>): LifeRecord => ({
  ...(row as unknown as LifeRecord),
  amount: row.amount == null ? null : Number(row.amount),
  sort_order: row.sort_order == null ? null : Number(row.sort_order)
});

const normalizeRate = (row: Record<string, unknown>): ExchangeRate => ({
  ...(row as unknown as ExchangeRate),
  rate: Number(row.rate)
});

export async function fetchAppData(user: User): Promise<AppData> {
  const [recordsResult, tripsResult, settingsResult, ratesResult] = await Promise.all([
    supabase.from("records").select("*").order("event_at", { ascending: false }),
    supabase.from("trips").select("*").is("archived_at", null).order("start_date", { ascending: false }),
    supabase.from("user_settings").select("*").eq("user_id", user.id).maybeSingle(),
    supabase.from("exchange_rates").select("*").order("rate_date", { ascending: false })
  ]);

  const firstError = recordsResult.error || tripsResult.error || settingsResult.error || ratesResult.error;
  if (firstError) throw firstError;

  const settings = (settingsResult.data as UserSettings | null) || defaultSettings(user.id);
  if (!settingsResult.data) await supabase.from("user_settings").upsert(settings);

  const data: AppData = {
    records: (recordsResult.data || []).map((row) => normalizeRecord(row)),
    trips: (tripsResult.data || []) as Trip[],
    settings,
    rates: (ratesResult.data || []).map((row) => normalizeRate(row))
  };
  await saveSnapshot({ userId: user.id, ...data, savedAt: now() });
  return data;
}

export async function cachedAppData(user: User): Promise<AppData | null> {
  const cached = await loadSnapshot(user.id);
  if (!cached) return null;
  return { records: cached.records, trips: cached.trips, rates: cached.rates, settings: cached.settings };
}

async function upsertOrQueue(table: "records" | "trips" | "user_settings" | "exchange_rates", payload: Record<string, unknown>) {
  if (navigator.onLine) {
    const { error } = await supabase.from(table).upsert(payload);
    if (!error) return;
  }
  await queueMutation({ table, operation: "upsert", payload });
}

export async function syncOutbox() {
  if (!navigator.onLine) return 0;
  let synced = 0;
  for (const item of await listMutations()) {
    const query = item.operation === "delete"
      ? supabase.from(item.table).delete().eq("id", String(item.payload.id))
      : supabase.from(item.table).upsert(item.payload);
    const { error } = await query;
    if (error) break;
    await removeMutation(item.id);
    synced += 1;
  }
  return synced;
}

export function makeRecord(user: User, draft: RecordDraft): LifeRecord {
  const timestamp = now();
  return {
    id: crypto.randomUUID(),
    user_id: user.id,
    record_type: draft.record_type,
    content: draft.content.trim(),
    notes: draft.notes?.trim() || null,
    amount: draft.amount ?? null,
    currency: draft.currency ?? null,
    expense_category: draft.expense_category ?? null,
    location: draft.location?.trim() || null,
    event_at: draft.event_at || timestamp,
    trip_id: draft.trip_id || null,
    plan_status: draft.plan_status || null,
    sort_order: draft.sort_order ?? null,
    parent_plan_id: draft.parent_plan_id || null,
    image_path: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function makeTrip(user: User, draft: TripDraft): Trip {
  const timestamp = now();
  return {
    id: crypto.randomUUID(),
    user_id: user.id,
    name: draft.name.trim(),
    destination: draft.destination.trim(),
    start_date: draft.start_date,
    end_date: draft.end_date,
    timezone: draft.timezone,
    archived_at: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

export async function persistRecord(record: LifeRecord) {
  await upsertOrQueue("records", record as unknown as Record<string, unknown>);
}

export async function persistTrip(trip: Trip) {
  await upsertOrQueue("trips", trip as unknown as Record<string, unknown>);
}

export async function persistSettings(settings: UserSettings) {
  await upsertOrQueue("user_settings", settings as unknown as Record<string, unknown>);
}

export async function persistRates(rates: ExchangeRate[]) {
  for (const rate of rates) {
    await upsertOrQueue("exchange_rates", rate as unknown as Record<string, unknown>);
  }
}

export async function refreshRates(user: User, quote: Currency, currencies: Currency[]) {
  const unique = [...new Set(currencies.filter((currency) => currency !== quote))];
  const fetched = await Promise.all(unique.map(async (base) => {
    const response = await fetch(`https://api.frankfurter.dev/v2/rate/${base}/${quote}`);
    if (!response.ok) throw new Error(`无法获取 ${base}/${quote} 汇率`);
    const body = await response.json() as { date: string; base: Currency; quote: Currency; rate: number };
    const timestamp = now();
    return {
      id: crypto.randomUUID(),
      user_id: user.id,
      base_currency: base,
      quote_currency: quote,
      rate: Number(body.rate),
      rate_date: body.date,
      source: "api" as const,
      created_at: timestamp,
      updated_at: timestamp
    } satisfies ExchangeRate;
  }));
  await persistRates(fetched);
  return fetched;
}

export async function updateCachedData(userId: string, data: AppData) {
  await saveSnapshot({ userId, ...data, savedAt: now() });
}
