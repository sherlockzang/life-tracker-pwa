import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, ApiError, authenticatedUser, completeUsage, errorResponse, json, preflight, readJson, requestOrigin, reserveQuota, stringField } from "../_shared/api.ts";

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

const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

function uuid(value: unknown) {
  const result = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) return crypto.randomUUID();
  return result;
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

function zonedDateTimeToDate(date: string, time: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !timeZone) throw new ApiError("INCOMPLETE_FLIGHT_PLAN", "请先完整填写计划到达日期、时间和时区。", 400);
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let index = 0; index < 3; index += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    const represented = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour") % 24, value("minute"), value("second"));
    guess += target - represented;
  }
  if (!Number.isFinite(guess)) throw new ApiError("INVALID_TIMEZONE", "航班到达时区无效，请重新选择。", 400);
  return new Date(guess);
}

function planFromRecord(record: Record<string, unknown>) {
  const details = record.transport_details as Record<string, unknown> | null;
  if (!details || record.transport_type !== "flight") throw new ApiError("RECORD_NOT_FOUND", "没有找到这条航班计划。", 404);
  const departure = details.departure as Record<string, unknown> | undefined;
  const arrival = details.arrival as Record<string, unknown> | undefined;
  const flightNumber = text(details.flight_number).replaceAll(" ", "").toUpperCase();
  const departureIata = departure ? iataFromStop(departure) : "";
  const arrivalIata = arrival ? iataFromStop(arrival) : "";
  if (!FLIGHT_NUMBER_PATTERN.test(flightNumber) || !departureIata || !arrivalIata) throw new ApiError("INCOMPLETE_FLIGHT_PLAN", "请先从机场补全列表选择起降机场，并填写正确的 IATA 航班号。", 400);
  const arrivalAt = zonedDateTimeToDate(text(arrival?.date), text(arrival?.time), text(arrival?.timezone));
  const eligibleAt = arrivalAt.getTime() + 60 * 60 * 1000;
  const expiresAt = arrivalAt.getTime() + 48 * 60 * 60 * 1000;
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
    && text(row.arrival?.iata).toUpperCase() === plan.arrivalIata;
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
    let usageRequestId = edgeRequestId;
    let claimedRecordId = "";
    let userId = "";
    let usageReserved = false;
    let usageFinished = false;
    try {
      const user = await authenticatedUser(request);
      userId = user.id;
      const body = await readJson(request, 4_000);
      const action = body.action === "confirm" ? "confirm" : "match";
      const recordId = stringField(body.recordId, 80);
      claimedRecordId = recordId;
      usageRequestId = uuid(body.requestId);

      if (action === "confirm") {
        const { data: preview } = await admin().from("flight_match_previews").select("actual_info").eq("request_id", usageRequestId).eq("record_id", recordId).eq("user_id", user.id).gt("expires_at", new Date().toISOString()).maybeSingle();
        if (!preview) throw new ApiError("PREVIEW_EXPIRED", "预览已过期，请重新匹配。", 410);
        const { data, error } = await admin().rpc("finish_flight_match", { p_user_id: user.id, p_record_id: recordId, p_request_id: usageRequestId, p_status: "matched", p_actual_info: preview.actual_info });
        if (error || !data?.ok) throw new ApiError("SAVE_FAILED", "实际飞行信息保存失败，请重试。", 503);
        await admin().from("flight_match_previews").delete().eq("request_id", usageRequestId);
        return json(origin, edgeRequestId, { data: { confirmed: true, record: data.record } });
      }

      const { data: record } = await admin().from("records").select("*").eq("id", recordId).eq("user_id", user.id).maybeSingle();
      if (!record) throw new ApiError("RECORD_NOT_FOUND", "没有找到这条航班计划。", 404);
      if (record.actual_match_status === "matched" && record.actual_info && body.rematch !== true) {
        return json(origin, edgeRequestId, { data: { cached: true, actualInfo: record.actual_info, matchedAt: record.actual_matched_at, requestId: record.actual_match_request_id } });
      }
      const plan = planFromRecord(record as Record<string, unknown>);

      if (body.rematch !== true) {
        const { data: staged } = await admin().from("flight_match_previews").select("request_id,actual_info").eq("record_id", recordId).eq("user_id", user.id).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (staged) return json(origin, edgeRequestId, { data: { cached: false, preview: staged.actual_info, requestId: staged.request_id, staged: true } });
      }
      const apiKey = Deno.env.get("AVIATIONSTACK_API_KEY");
      if (!apiKey) throw new ApiError("API_NOT_CONFIGURED", "航班查询暂未配置，你仍可手动填写。", 503);

      const { data: claim, error: claimError } = await admin().rpc("claim_flight_match", { p_user_id: user.id, p_record_id: recordId, p_request_id: usageRequestId, p_rematch: body.rematch === true });
      if (claimError || !claim?.ok) {
        if (claim?.code === "MATCH_IN_PROGRESS") throw new ApiError("MATCH_IN_PROGRESS", "这条航班正在匹配中，请稍后查看结果。", 409);
        throw new ApiError("RECORD_NOT_FOUND", "没有找到这条航班计划。", 404);
      }
      if (claim.cached) return json(origin, edgeRequestId, { data: { cached: true, actualInfo: claim.actual_info, matchedAt: claim.matched_at } });

      try {
        await reserveQuota({ userId: user.id, feature: "flight_actual_match", requestId: usageRequestId });
        usageReserved = true;
      } catch (error) {
        await admin().from("records").update({ actual_match_status: "eligible" }).eq("id", recordId).eq("user_id", user.id).eq("actual_match_request_id", usageRequestId);
        throw error;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const url = new URL("https://api.aviationstack.com/v1/flights");
      url.searchParams.set("access_key", apiKey);
      url.searchParams.set("flight_iata", plan.flightNumber);
      url.searchParams.set("limit", "100");
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal, headers: { "Accept": "application/json" } });
      } finally {
        clearTimeout(timeout);
      }
      const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: unknown };
      if (!response.ok || payload.error || !Array.isArray(payload.data)) {
        await completeUsage(usageRequestId, "upstream_error", { upstreamStatus: response.status });
        usageFinished = true;
        await admin().rpc("finish_flight_match", { p_user_id: user.id, p_record_id: recordId, p_request_id: usageRequestId, p_status: "failed", p_actual_info: null });
        throw new ApiError("API_UNAVAILABLE", "暂时无法获取航班信息，原计划不会被修改。", 503);
      }

      const match = (payload.data as AviationFlight[]).find((row) => exactMatch(row, plan));
      if (!match) {
        await completeUsage(usageRequestId, "not_found");
        usageFinished = true;
        await admin().rpc("finish_flight_match", { p_user_id: user.id, p_record_id: recordId, p_request_id: usageRequestId, p_status: "not_found", p_actual_info: null });
        throw new ApiError("NO_EXACT_MATCH", "未找到与该日期及航线完全一致的实际飞行信息。原计划不会被修改，你可以稍后手动重试。", 404);
      }

      const preview = actualInfo(match);
      await admin().from("flight_match_previews").upsert({ request_id: usageRequestId, record_id: recordId, user_id: user.id, actual_info: preview, expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
      await admin().from("records").update({ actual_match_status: "eligible" }).eq("id", recordId).eq("user_id", user.id).eq("actual_match_request_id", usageRequestId);
      await completeUsage(usageRequestId, "completed", { exactMatch: true });
      usageFinished = true;
      return json(origin, edgeRequestId, { data: { cached: false, preview, requestId: usageRequestId } });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (usageReserved && !usageFinished) await completeUsage(usageRequestId, "upstream_error");
        if (claimedRecordId && userId) await admin().rpc("finish_flight_match", { p_user_id: userId, p_record_id: claimedRecordId, p_request_id: usageRequestId, p_status: "failed", p_actual_info: null });
        return errorResponse(origin, edgeRequestId, new ApiError("API_TIMEOUT", "航班查询超时，原计划不会被修改。", 504));
      }
      if (usageReserved && !usageFinished) {
        await completeUsage(usageRequestId, "failed");
        if (claimedRecordId && userId) await admin().rpc("finish_flight_match", { p_user_id: userId, p_record_id: claimedRecordId, p_request_id: usageRequestId, p_status: "failed", p_actual_info: null });
      }
      return errorResponse(origin, edgeRequestId, error);
    }
  }
};
