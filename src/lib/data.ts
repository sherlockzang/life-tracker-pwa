import type { User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { claimMutation, failMutation, finishMutation, listMutations, loadSnapshot, queueMutation, reconcileMutations, saveSnapshot, type PendingMutation } from "./offline";
import { replayMutation, type SaveResult } from "./syncEngine";
import { invalidateChangedFlight } from "./flightMatchState";
import type { Changelog, Currency, ExchangeRate, LifeRecord, RecordDraft, Trip, TripDraft, UserProfile, UserSettings } from "../types";
import { APP_VERSION } from "../version";
import { normalizeTransport } from "./transport";
import { mergeBundledReleaseNotes } from "./releaseNotes";
import { normalizeAircraftType } from "./aircraftTypes";
import { normalizeScheduleDetails } from "./schedules";
import { readAllPages } from "../../supabase/functions/_shared/pagination";

export interface AppData {
  records: LifeRecord[];
  trips: Trip[];
  rates: ExchangeRate[];
  settings: UserSettings;
  profile: UserProfile;
  changelogs: Changelog[];
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

export function defaultProfile(user: User): UserProfile {
  const timestamp = now();
  const metadataName = user.user_metadata?.display_name || user.user_metadata?.full_name || user.user_metadata?.name;
  return {
    user_id: user.id,
    display_name: String(metadataName || user.email?.split("@")[0] || "Life Tracker 用户").slice(0, 40),
    avatar_url: null,
    avatar_color: "#0A84FF",
    has_seen_onboarding: false,
    last_seen_version: APP_VERSION,
    created_at: timestamp,
    updated_at: timestamp
  };
}

export const normalizeRecord = (row: Record<string, unknown>): LifeRecord => {
  const transport = normalizeTransport(row.transport_type, row.transport_details);
  const actualInfo = row.actual_info as NonNullable<LifeRecord["actual_info"]> | null;
  return {
    ...(row as unknown as LifeRecord),
    amount: row.amount == null ? null : Number(row.amount),
    sort_order: row.sort_order == null ? null : Number(row.sort_order),
    ...(row.schedule_details !== undefined ? { schedule_details: normalizeScheduleDetails(row.schedule_details) } : {}),
    actual_match_status: (row.actual_match_status || "never") as LifeRecord["actual_match_status"],
    actual_info: actualInfo ? { ...actualInfo, aircraft_type: normalizeAircraftType(actualInfo.aircraft_type) } : null,
    actual_info_matched: Boolean(row.actual_info_matched),
    actual_matched_at: typeof row.actual_matched_at === "string" ? row.actual_matched_at : null,
    actual_match_provider: typeof row.actual_match_provider === "string" ? row.actual_match_provider : null,
    actual_match_request_id: typeof row.actual_match_request_id === "string" ? row.actual_match_request_id : null,
    ...transport
  };
};

const normalizeRate = (row: Record<string, unknown>): ExchangeRate => ({
  ...(row as unknown as ExchangeRate),
  rate: Number(row.rate)
});

export async function fetchAppData(user: User): Promise<AppData> {
  const authBefore = (await supabase.auth.getSession()).data.session;
  if (authBefore?.user.id !== user.id) throw new Error("账号已切换，请在原账号中读取数据");
  const collection = (table: "records" | "trips" | "exchange_rates" | "changelogs") => readAllPages((cursor) => {
    let query = supabase.from(table).select("*").order("id", { ascending: true }).limit(500);
    if (table !== "changelogs") query = query.eq("user_id", user.id);
    if (table === "trips") query = query.is("archived_at", null);
    if (cursor) query = query.gt("id", cursor);
    return query;
  });
  const [recordRows, tripRows, settingsResult, rateRows, profileResult, changelogRows] = await Promise.all([
    collection("records"),
    collection("trips"),
    supabase.from("user_settings").select("*").eq("user_id", user.id).maybeSingle(),
    collection("exchange_rates"),
    supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle(),
    collection("changelogs")
  ]);

  const firstError = settingsResult.error || profileResult.error;
  if (firstError) throw firstError;
  const authAfter = (await supabase.auth.getSession()).data.session;
  if (authAfter?.user.id !== user.id || authAfter.access_token !== authBefore.access_token) throw new Error("登录会话已更新，请重新读取云端数据");

  let settings = (settingsResult.data as UserSettings | null) || defaultSettings(user.id);
  if (!settingsResult.data) {
    const inserted = await supabase.from("user_settings").upsert(settings, { onConflict: "user_id", ignoreDuplicates: true });
    if (inserted.error) throw inserted.error;
    const saved = await supabase.from("user_settings").select().eq("user_id", user.id).single();
    if (saved.error) throw saved.error;
    settings = saved.data as UserSettings;
  }
  const profile = (profileResult.data as UserProfile | null) || defaultProfile(user);
  if (!profileResult.data) {
    const inserted = await supabase.from("profiles").upsert(profile, { onConflict: "user_id", ignoreDuplicates: true });
    if (inserted.error) throw inserted.error;
    const saved = await supabase.from("profiles").select().eq("user_id", user.id).single();
    if (saved.error) throw saved.error;
    Object.assign(profile, saved.data);
  }

  const data: AppData = {
    records: recordRows.map((row) => normalizeRecord(row)).sort((a, b) => b.event_at.localeCompare(a.event_at) || a.id.localeCompare(b.id)),
    trips: (tripRows as Trip[]).sort((a, b) => b.start_date.localeCompare(a.start_date) || a.id.localeCompare(b.id)),
    settings,
    rates: rateRows.map((row) => normalizeRate(row)).sort((a, b) => b.rate_date.localeCompare(a.rate_date) || a.id.localeCompare(b.id)),
    profile,
    changelogs: mergeBundledReleaseNotes(changelogRows as Changelog[])
  };
  for (const item of await listMutations(user.id)) {
    // Rejected/conflicting drafts remain visible and exportable, never silently
    // replaced by an older cloud row. Legacy unproven queue entries stay isolated.
    if (item.legacy || item.supersededBy) continue;
    if (item.table === "records") data.records = [normalizeRecord(item.payload), ...data.records.filter((row) => row.id !== item.entityId)];
    if (item.table === "trips") data.trips = [item.payload as unknown as Trip, ...data.trips.filter((row) => row.id !== item.entityId)];
    if (item.table === "user_settings") data.settings = item.payload as unknown as UserSettings;
    if (item.table === "profiles") data.profile = item.payload as unknown as UserProfile;
    if (item.table === "exchange_rates") data.rates = [normalizeRate(item.payload), ...data.rates.filter((row) => row.id !== item.entityId)];
  }
  await saveSnapshot({ userId: user.id, ...data, savedAt: now() });
  return data;
}

export async function cachedAppData(user: User): Promise<AppData | null> {
  const cached = await loadSnapshot(user.id);
  if (!cached) return null;
  return {
    records: cached.records.map((record) => normalizeRecord(record as unknown as Record<string, unknown>)),
    trips: cached.trips,
    rates: cached.rates,
    settings: cached.settings,
    profile: cached.profile || defaultProfile(user),
    changelogs: mergeBundledReleaseNotes(cached.changelogs || [])
  };
}

const editableFields: Record<string, string[]> = {
  records: ["id", "user_id", "record_type", "content", "notes", "amount", "currency", "expense_category", "location", "event_at", "trip_id", "plan_status", "sort_order", "parent_plan_id", "transport_type", "transport_details", "schedule_details", "image_path"],
  trips: ["id", "user_id", "name", "destination", "start_date", "end_date", "timezone", "archived_at"],
  user_settings: ["user_id", "base_currency", "theme"],
  profiles: ["user_id", "display_name", "avatar_url", "avatar_color", "has_seen_onboarding", "last_seen_version"],
  exchange_rates: ["id", "user_id", "base_currency", "quote_currency", "rate", "rate_date", "source"]
};
const syncAdapter = {
  currentOwner: async () => (await supabase.auth.getSession()).data.session?.user.id,
  claim: claimMutation, finish: finishMutation, fail: failMutation,
  write: async (item: Awaited<ReturnType<typeof queueMutation>>) => {
    const payload = Object.fromEntries(Object.entries(item.payload).filter(([key]) => editableFields[item.table].includes(key)));
    return await supabase.rpc("save_user_mutation", { p_table: item.table, p_payload: payload, p_expected_updated_at: item.expectedUpdatedAt, p_request_id: item.id });
  }
};

export async function inspectSyncConflict(item: PendingMutation) {
  if (await syncAdapter.currentOwner() !== item.ownerId) throw new Error("账号已切换");
  const inspected = (await listMutations(item.ownerId)).filter(old => !old.supersededBy && old.table === item.table && old.entityId === item.entityId);
  const key = item.table === "profiles" || item.table === "user_settings" ? "user_id" : "id";
  const { data: cloud, error } = await supabase.from(item.table).select("*").eq("user_id", item.ownerId).eq(key, item.entityId).maybeSingle();
  if (error) throw error;
  if (await syncAdapter.currentOwner() !== item.ownerId) throw new Error("账号已切换");
  return { inspected, cloud: cloud as Record<string, unknown> | null };
}

export async function resolveSyncConflict(review: Awaited<ReturnType<typeof inspectSyncConflict>>, choice: "cloud" | "local") {
  const owner = review.inspected[0]?.ownerId;
  if (!owner || await syncAdapter.currentOwner() !== owner) throw new Error("账号已切换");
  const queued = await reconcileMutations(review.inspected, review.cloud, choice);
  if (queued) {
    const result = await replayMutation(queued, syncAdapter);
    if (result?.state !== "confirmed") throw new Error("尚未确认保存；若云端再次变化，请重新比较冲突。本机副本已保留。");
  }
}
async function upsertOrQueue(table: Awaited<ReturnType<typeof queueMutation>>["table"], payload: Record<string, unknown>, previous?: { updated_at: string }): Promise<SaveResult> {
  const item = await queueMutation({ ownerId: String(payload.user_id), table, operation: "upsert", payload, expectedUpdatedAt: previous?.updated_at || null });
  if (navigator.onLine) return await replayMutation(item, syncAdapter) || { state: "pending", row: payload };
  return { state: "pending", row: payload };
}

export async function syncOutbox(ownerId: string) {
  if (!navigator.onLine) return 0;
  let synced = 0;
  for (const item of await listMutations(ownerId)) {
    const result = await replayMutation(item, syncAdapter);
    if (result?.state === "confirmed") synced += 1;
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
    transport_type: draft.transport_type ?? null,
    transport_details: draft.transport_details ?? null,
    ...(draft.schedule_details ? { schedule_details: normalizeScheduleDetails(draft.schedule_details) } : {}),
    actual_match_status: "never",
    actual_info: null,
    actual_info_matched: false,
    actual_matched_at: null,
    actual_match_provider: null,
    actual_match_request_id: null,
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

export async function persistRecord(record: LifeRecord, previous?: LifeRecord) {
  const safe = previous ? invalidateChangedFlight(previous, record) : record;
  const result = await upsertOrQueue("records", safe as unknown as Record<string, unknown>, previous);
  return { ...result, row: normalizeRecord(result.row) as unknown as Record<string, unknown> };
}

export async function persistTrip(trip: Trip, previous?: Trip) {
  return upsertOrQueue("trips", trip as unknown as Record<string, unknown>, previous);
}

export async function persistSettings(settings: UserSettings, previous?: UserSettings) {
  return upsertOrQueue("user_settings", settings as unknown as Record<string, unknown>, previous);
}

export async function persistProfile(profile: UserProfile, previous?: UserProfile) {
  return upsertOrQueue("profiles", profile as unknown as Record<string, unknown>, previous);
}

export async function uploadAvatar(user: User, avatar: Blob) {
  if (!navigator.onLine) throw new Error("上传头像时需要连接网络");
  const path = `${user.id}/avatar.webp`;
  const { error } = await supabase.storage.from("avatars").upload(path, avatar, {
    contentType: "image/webp",
    cacheControl: "3600",
    upsert: true
  });
  if (error) throw error;
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}

export async function persistRates(rates: ExchangeRate[]) {
  for (const rate of rates) {
    const result = await upsertOrQueue("exchange_rates", rate as unknown as Record<string, unknown>);
    if (result.state === "failed" || result.state === "conflict") throw new Error(result.error);
  }
}

export async function refreshRates(user: User, quote: Currency, currencies: Currency[], persist = true) {
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
  if (persist) await persistRates(fetched);
  return fetched;
}

export async function updateCachedData(userId: string, data: AppData) {
  await saveSnapshot({ userId, ...data, savedAt: now() });
}
