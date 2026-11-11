import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, ApiError, authenticatedUser, completeUsage, errorResponse, json, preflight, readJson, requestOrigin, reserveQuota, stringField } from "../_shared/api.ts";
import { signRecoveryToken, verifyRecoveryToken } from "../_shared/recovery.ts";
import { fetchJsonWithTimeout } from "../_shared/upstream.ts";
import { FlightTimeError, flightTimeOptions, isoUtcOffsetMinutes, resolveFlightInstant } from "../_shared/flightTime.ts";

const REQUEST_TIMEOUT_MS = 14_000;
const FLIGHT_NUMBER_PATTERN = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;

interface AviationStop {
  airport?: unknown; iata?: unknown; terminal?: unknown; gate?: unknown; timezone?: unknown;
  scheduled?: unknown; estimated?: unknown; actual?: unknown; delay?: unknown;
}
interface AviationFlight {
  flight_status?: unknown;
  departure?: AviationStop;
  arrival?: AviationStop;
  airline?: { name?: unknown };
  flight?: { iata?: unknown; number?: unknown };
  aircraft?: { registration?: unknown; iata?: unknown; icao?: unknown } | null;
}

const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, 300) : "";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function aviationFlight(value: unknown): value is AviationFlight {
  if (!object(value) || !object(value.departure) || !object(value.arrival) || !object(value.flight)) return false;
  for (const stop of [value.departure, value.arrival]) {
    if (!/^[A-Z]{3}$/i.test(text(stop.iata)) || typeof stop.scheduled !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stop.scheduled)) return false;
    for (const field of ["airport", "iata", "terminal", "gate", "timezone", "scheduled", "estimated", "actual", "delay"]) {
      if (stop[field] != null && typeof stop[field] !== "string" && typeof stop[field] !== "number") return false;
    }
  }
  if (!text(value.flight.iata) && !text(value.flight.number)) return false;
  for (const field of ["airline", "aircraft"]) if (value[field] != null && !object(value[field])) return false;
  return true;
}

function uuid(value: unknown) {
  const result = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new ApiError("INVALID_INPUT", "请求标识无效，请重新打开航班详情。", 400);
  return result;
}

function planVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ApiError("PLAN_VERSION_REQUIRED", "请刷新页面，载入最新航班计划后再匹配。", 409);
  return value;
}

function rpcFailure(result: { code?: string } | null, fallback = "实际飞行信息保存失败。预览仍已保留，可直接重试保存，不会再次查询或扣除航班额度。") {
  if (result?.code === "FLIGHT_CANCELLED") return new ApiError("FLIGHT_CANCELLED", "这条航班计划已取消。恢复为计划中后才能匹配或确认实际信息。", 409);
  if (result?.code === "PLAN_CHANGED") return new ApiError("PLAN_CHANGED", "航班计划已修改，这份匹配结果不再适用。请先核对并保存最新计划。", 409);
  if (result?.code === "MATCH_IN_PROGRESS") return new ApiError("MATCH_IN_PROGRESS", "这条航班正在匹配中，请稍后查看结果。", 409);
  if (result?.code === "RECORD_NOT_FOUND") return new ApiError("RECORD_NOT_FOUND", "没有找到这条航班计划。", 404);
  if (result?.code === "PREVIEW_EXPIRED") return new ApiError("PREVIEW_EXPIRED", "这份预览已过期，原计划未改变。", 410);
  return new ApiError("SAVE_FAILED", fallback, 503);
}

interface FlightRecovery extends Record<string, unknown> {
  userId: string; recordId: string; requestId: string; planVersion: number;
  actualInfo: Record<string, unknown>;
}

async function finishUsageSafely(requestId: string, status: "completed" | "upstream_error" | "not_found" | "failed", meta?: Record<string, unknown>) {
  try { await completeUsage(requestId, status, meta); return true; }
  catch { console.error("Flight usage completion pending", { requestId }); return false; }
}

async function cleanupMatch(userId: string, recordId: string, requestId: string, status: "not_found" | "failed") {
  try {
    const { error } = await admin().rpc("finish_flight_match", { p_user_id: userId, p_record_id: recordId, p_request_id: requestId, p_status: status, p_actual_info: null });
    if (error) console.error("Flight match cleanup pending", { requestId });
  } catch { console.error("Flight match cleanup pending", { requestId }); }
}

function localDateTime(value: unknown) {
  const raw = text(value);
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return { iso: raw || null, date: match?.[1] || "", time: match?.[2] || "" };
}

function iataFromStop(stop: Record<string, unknown>) {
  const direct = text(stop.iata).toUpperCase();
  if (/^[A-Z]{3}$/.test(direct)) return direct;
  const label = text(stop.airport).toUpperCase();
  return label.match(/\(([A-Z]{3})\)/)?.[1] || label.match(/(?:^|\s)([A-Z]{3})$/)?.[1] || "";
}

function localFlightStop(stop: Record<string, unknown> | undefined) {
  return { date: text(stop?.date), time: text(stop?.time), timezone: text(stop?.timezone), utc_offset_minutes: stop?.utc_offset_minutes as number | undefined };
}

function flightStopInstant(stop: Record<string, unknown> | undefined) {
  try { return resolveFlightInstant(localFlightStop(stop)); }
  catch (error) {
    if (error instanceof FlightTimeError) throw new ApiError(error.code, error.message, 400);
    throw error;
  }
}

function planFromRecord(record: Record<string, unknown>) {
  if (record.plan_status === "cancelled") throw rpcFailure({ code: "FLIGHT_CANCELLED" });
  const details = record.transport_details as Record<string, unknown> | null;
  if (!details || record.transport_type !== "flight") throw new ApiError("RECORD_NOT_FOUND", "没有找到这条航班计划。", 404);
  const departure = details.departure as Record<string, unknown> | undefined;
  const arrival = details.arrival as Record<string, unknown> | undefined;
  const flightNumber = text(details.flight_number).replaceAll(" ", "").toUpperCase();
  const departureIata = departure ? iataFromStop(departure) : "";
  const arrivalIata = arrival ? iataFromStop(arrival) : "";
  if (!FLIGHT_NUMBER_PATTERN.test(flightNumber) || !departureIata || !arrivalIata) throw new ApiError("INCOMPLETE_FLIGHT_PLAN", "请先从机场补全列表选择起降机场，并填写正确的 IATA 航班号。", 400);
  const arrivalAt = flightStopInstant(arrival);
  const departureAt = flightStopInstant(departure);
  if (arrivalAt <= departureAt) throw new ApiError("INVALID_FLIGHT_TIME", "降落时间须晚于起飞时间，请检查日期和两地时区。", 400);
  const eligibleAt = arrivalAt + 60 * 60 * 1000;
  const expiresAt = arrivalAt + 48 * 60 * 60 * 1000;
  if (Date.now() < eligibleAt) throw new ApiError("FLIGHT_NOT_COMPLETED", "该航班尚未进入实际信息匹配范围。请先保留计划信息；航班结束约一小时后，可回来匹配实际飞行数据。", 400, { eligibleAt: new Date(eligibleAt).toISOString() });
  if (Date.now() > expiresAt) throw new ApiError("MATCH_WINDOW_EXPIRED", "该航班已超过自动匹配时间范围，原计划不会被修改，你仍可手动补充实际信息。", 400);
  return { details, departure, arrival, flightNumber, departureIata, arrivalIata, departureDate: text(departure?.date) };
}

function stopActual(stop: AviationStop | undefined) {
  return {
    airport: text(stop?.airport),
    iata: text(stop?.iata).toUpperCase(),
    timezone: text(stop?.timezone),
    scheduled: localDateTime(stop?.scheduled),
    estimated: localDateTime(stop?.estimated),
    actual: localDateTime(stop?.actual),
    delay_minutes: Number(stop?.delay) || 0,
    terminal: text(stop?.terminal),
    gate: text(stop?.gate)
  };
}

function exactMatch(row: AviationFlight, plan: ReturnType<typeof planFromRecord>) {
  const number = (text(row.flight?.iata) || text(row.flight?.number)).replaceAll(" ", "").toUpperCase();
  const departureDate = localDateTime(row.departure?.scheduled).date;
  return number === plan.flightNumber
    && departureDate === plan.departureDate
    && text(row.departure?.iata).toUpperCase() === plan.departureIata
    && text(row.arrival?.iata).toUpperCase() === plan.arrivalIata
    && matchesSelectedOccurrence(row.departure, plan.departure)
    && matchesSelectedOccurrence(row.arrival, plan.arrival);
}

function matchesSelectedOccurrence(actual: AviationStop | undefined, planned: Record<string, unknown> | undefined) {
  const stop = localFlightStop(planned);
  if (flightTimeOptions(stop).length === 1) return true;
  const offset = isoUtcOffsetMinutes(actual?.scheduled);
  if (offset == null || offset !== stop.utc_offset_minutes) return false;
  const clock = localDateTime(actual?.scheduled);
  try { resolveFlightInstant({ date: clock.date, time: clock.time, timezone: stop.timezone, utc_offset_minutes: offset }); return true; }
  catch { return false; }
}

function actualInfo(row: AviationFlight) {
  return {
    status: text(row.flight_status),
    airline: text(row.airline?.name),
    flight_number: text(row.flight?.iata) || text(row.flight?.number),
    departure: stopActual(row.departure),
    arrival: stopActual(row.arrival),
    aircraft_type: text(row.aircraft?.iata) || text(row.aircraft?.icao),
    registration: text(row.aircraft?.registration),
    source: "aviationstack",
    matched_at: new Date().toISOString()
  };
}

export default {
  async fetch(request: Request) {
    const edgeRequestId = crypto.randomUUID();
    const origin = requestOrigin(request);
    const early = preflight(request, edgeRequestId);
    if (early) return early;
    let usageRequestId: string = edgeRequestId;
    let claimedRecordId = "";
    let userId = "";
    let usageReserved = false;
    let usageFinished = false;
    try {
      const user = await authenticatedUser(request);
      userId = user.id;
      const body = await readJson(request, 20_000);
      if (body.action !== "confirm" && body.action !== "match") throw new ApiError("INVALID_INPUT", "航班操作无效。", 400);
      const action = body.action;
      const recordId = uuid(stringField(body.recordId, 80));
      claimedRecordId = recordId;
      usageRequestId = uuid(body.requestId);
      // Only an omitted key is legacy. Explicit malformed/stale versions must
      // never silently become the record's newer version.
      let version = body.planVersion === undefined ? null : planVersion(body.planVersion);

      if (action === "confirm") {
        if (version === null) {
          const { data: legacyPreview, error: legacyPreviewError } = await admin().from("flight_match_previews").select("plan_version").eq("request_id", usageRequestId).eq("record_id", recordId).eq("user_id", user.id).gt("expires_at", new Date().toISOString()).maybeSingle();
          if (legacyPreviewError) throw new ApiError("READ_FAILED", "暂时无法核对这份预览，内容已保留，请直接重试保存。", 503);
          if (legacyPreview) version = planVersion(legacyPreview.plan_version);
          else {
            const { data: confirmed, error: confirmedError } = await admin().from("records").select("flight_plan_version,actual_match_plan_version,actual_confirmed_request_id,actual_info_matched").eq("id", recordId).eq("user_id", user.id).eq("actual_confirmed_request_id", usageRequestId).eq("actual_info_matched", true).maybeSingle();
            if (confirmedError) throw new ApiError("READ_FAILED", "暂时无法核对已保存的信息，请直接重试保存。", 503);
            if (!confirmed || !confirmed.actual_info_matched || confirmed.actual_confirmed_request_id !== usageRequestId || confirmed.actual_match_plan_version !== confirmed.flight_plan_version) throw new ApiError("PREVIEW_EXPIRED", "没有可验证的航班预览，原计划未改变。请刷新后查看当前记录。", 410);
            version = planVersion(confirmed.flight_plan_version);
          }
        }
        let recovered: Record<string, unknown> | null = null;
        if (body.recoveryToken != null) {
          let payload: FlightRecovery;
          try { payload = await verifyRecoveryToken<FlightRecovery>(stringField(body.recoveryToken, 18_000), "flight-preview", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""); }
          catch { throw new ApiError("INVALID_RECOVERY", "预览保存凭证已过期或无效，原计划未改变。", 410); }
          if (payload.userId !== user.id || payload.recordId !== recordId || payload.requestId !== usageRequestId || payload.planVersion !== version) throw new ApiError("INVALID_RECOVERY", "这份预览不属于当前账号或航班计划。", 403);
          recovered = payload.actualInfo;
        }
        const { data, error } = await admin().rpc("confirm_flight_match_v2", { p_user_id: user.id, p_record_id: recordId, p_request_id: usageRequestId, p_plan_version: version, p_actual_info: recovered });
        if (error || !data?.ok) throw rpcFailure(data);
        const usageLogPending = !await finishUsageSafely(usageRequestId, "completed", { exactMatch: true });
        return json(origin, edgeRequestId, { data: { confirmed: true, record: data.record, usageLogPending } });
      }

      const { data: record, error: recordError } = await admin().from("records").select("*").eq("id", recordId).eq("user_id", user.id).maybeSingle();
      if (recordError) throw new ApiError("READ_FAILED", "暂时无法核对航班计划。请稍后再试，本次不会调用航班接口。", 503);
      if (!record) throw new ApiError("RECORD_NOT_FOUND", "没有找到这条航班计划。", 404);
      if (version === null) version = planVersion(record.flight_plan_version);
      if (record.flight_plan_version !== version) throw rpcFailure({ code: "PLAN_CHANGED" });
      let plan = planFromRecord(record as Record<string, unknown>);
      if (record.actual_info_matched && record.actual_match_plan_version === version && record.actual_confirmed_request_id && record.actual_info && body.rematch !== true) return json(origin, edgeRequestId, { data: { cached: true, actualInfo: record.actual_info, matchedAt: record.actual_matched_at, requestId: record.actual_confirmed_request_id, planVersion: version, record } });

      if (body.rematch !== true) {
        const { data: staged, error: stagedError } = await admin().from("flight_match_previews").select("request_id,actual_info,expires_at").eq("record_id", recordId).eq("user_id", user.id).eq("plan_version", version).eq("request_id", record.actual_match_request_id || "00000000-0000-4000-8000-000000000000").gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (stagedError) throw new ApiError("READ_FAILED", "暂时无法核对已有预览。请稍后再试，本次不会调用航班接口。", 503);
        if (staged) {
          const remaining = Math.min(30 * 60_000, new Date(staged.expires_at).getTime() - Date.now());
          const recoveryToken = await signRecoveryToken({ userId: user.id, recordId, requestId: staged.request_id, planVersion: version, actualInfo: staged.actual_info }, "flight-preview", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", Date.now(), remaining);
          return json(origin, edgeRequestId, { data: { cached: false, preview: staged.actual_info, requestId: staged.request_id, planVersion: version, recoveryToken, expiresAt: staged.expires_at, staged: true } });
        }
      }
      const apiKey = Deno.env.get("AVIATIONSTACK_API_KEY");
      if (!apiKey) throw new ApiError("API_NOT_CONFIGURED", "航班查询暂未配置，你仍可手动填写。", 503);

      const { data: claim, error: claimError } = await admin().rpc("claim_flight_match_v2", { p_user_id: user.id, p_record_id: recordId, p_request_id: usageRequestId, p_plan_version: version, p_rematch: body.rematch === true });
      if (claimError || !claim?.ok) throw rpcFailure(claim, "暂时无法锁定航班计划。请稍后再试，本次不会调用航班接口。");
      if (claim.cached) return json(origin, edgeRequestId, { data: { cached: true, actualInfo: claim.record.actual_info, matchedAt: claim.record.actual_matched_at, requestId: claim.record.actual_confirmed_request_id, planVersion: version, record: claim.record } });
      plan = planFromRecord(claim.record as Record<string, unknown>);

      try {
        await reserveQuota({ userId: user.id, feature: "flight_actual_match", requestId: usageRequestId });
        usageReserved = true;
      } catch (error) {
        await cleanupMatch(user.id, recordId, usageRequestId, "failed");
        throw error;
      }

      const url = new URL("https://api.aviationstack.com/v1/flights");
      url.searchParams.set("access_key", apiKey);
      url.searchParams.set("flight_iata", plan.flightNumber);
      url.searchParams.set("limit", "100");
      const { response, payload } = await fetchJsonWithTimeout<{ data?: unknown; error?: unknown }>(url, { headers: { "Accept": "application/json" } }, REQUEST_TIMEOUT_MS);
      if (!response.ok || payload.error || !Array.isArray(payload.data)) {
        usageFinished = await finishUsageSafely(usageRequestId, "upstream_error", { upstreamStatus: response.status });
        await cleanupMatch(user.id, recordId, usageRequestId, "failed");
        throw new ApiError("API_UNAVAILABLE", "暂时无法获取航班信息，原计划不会被修改。", 503);
      }

      const flights = payload.data.filter(aviationFlight);
      if (payload.data.length && !flights.length) throw new ApiError("API_UNAVAILABLE", "航班服务返回的信息格式不可用，原计划不会被修改。", 503);
      const match = flights.find((row) => exactMatch(row, plan));
      if (!match) {
        usageFinished = await finishUsageSafely(usageRequestId, "not_found");
        await cleanupMatch(user.id, recordId, usageRequestId, "not_found");
        throw new ApiError("NO_EXACT_MATCH", "未找到与该日期及航线完全一致的实际飞行信息。原计划不会被修改，你可以稍后手动重试。", 404);
      }

      const preview = actualInfo(match);
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      const recoveryToken = await signRecoveryToken({ userId: user.id, recordId, requestId: usageRequestId, planVersion: version, actualInfo: preview }, "flight-preview", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
      let stage: { ok?: boolean; code?: string } | null = null;
      let stageError: unknown = null;
      try {
        const staged = await admin().rpc("stage_flight_match_v2", { p_user_id: user.id, p_record_id: recordId, p_request_id: usageRequestId, p_plan_version: version, p_actual_info: preview });
        stage = staged.data; stageError = staged.error;
      } catch (error) { stageError = error; }
      usageFinished = await finishUsageSafely(usageRequestId, "completed", { exactMatch: true });
      if (!stageError && stage?.ok === false) throw rpcFailure(stage);
      const persisted = !stageError && stage?.ok === true;
      const warning = !persisted ? "已获取实际信息，但云端预览暂未保存。请直接点击确认保存；重试保存不会再次查询或扣除航班额度。" : !usageFinished ? "已获取实际信息，使用记录稍后同步。确认保存不会再次查询或扣除航班额度。" : undefined;
      return json(origin, edgeRequestId, { data: { cached: false, preview, requestId: usageRequestId, planVersion: version, recoveryToken, expiresAt, persisted, usageLogPending: !usageFinished, warning } });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (usageReserved && !usageFinished) await finishUsageSafely(usageRequestId, "upstream_error");
        if (claimedRecordId && userId) await cleanupMatch(userId, claimedRecordId, usageRequestId, "failed");
        return errorResponse(origin, edgeRequestId, new ApiError("API_TIMEOUT", "航班查询超时，原计划不会被修改。", 504));
      }
      if (usageReserved && !usageFinished) {
        await finishUsageSafely(usageRequestId, "failed");
        if (claimedRecordId && userId) await cleanupMatch(userId, claimedRecordId, usageRequestId, "failed");
      }
      return errorResponse(origin, edgeRequestId, error);
    }
  }
};
