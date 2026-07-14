import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "npm:@supabase/server@^1";

const ALLOWED_ORIGINS = new Set([
  "https://sherlockzang.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);
const REQUEST_TIMEOUT_MS = 12_000;
const FLIGHT_NUMBER_PATTERN = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;

type ErrorCode = "INVALID_INPUT" | "API_NOT_CONFIGURED" | "API_UNAVAILABLE" | "API_TIMEOUT" | "METHOD_NOT_ALLOWED";

interface AviationStop {
  airport?: unknown;
  iata?: unknown;
  terminal?: unknown;
  gate?: unknown;
  scheduled?: unknown;
  timezone?: unknown;
}

interface AviationFlight {
  flight_status?: unknown;
  departure?: AviationStop;
  arrival?: AviationStop;
  airline?: { name?: unknown };
  flight?: { iata?: unknown; number?: unknown };
  aircraft?: { registration?: unknown; iata?: unknown; icao?: unknown } | null;
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin"
  };
}

function json(origin: string, requestId: string, body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ ...body, requestId }), { status, headers: corsHeaders(origin) });
}

function fail(origin: string, requestId: string, code: ErrorCode, message: string, status: number) {
  return json(origin, requestId, { error: { code, message } }, status);
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function localDateTime(value: unknown) {
  const raw = text(value);
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return { date: match?.[1] || "", time: match?.[2] || "" };
}

function airportLabel(stop: AviationStop | undefined) {
  const name = text(stop?.airport);
  const iata = text(stop?.iata);
  return name && iata ? `${name} (${iata})` : name || iata;
}

function mapStop(stop: AviationStop | undefined) {
  const schedule = localDateTime(stop?.scheduled);
  return {
    airport: airportLabel(stop),
    date: schedule.date,
    time: schedule.time,
    timezone: text(stop?.timezone),
    terminal: text(stop?.terminal),
    gate: text(stop?.gate)
  };
}

function mapFlight(row: AviationFlight, index: number) {
  const flightNumber = text(row.flight?.iata) || text(row.flight?.number);
  const departure = mapStop(row.departure);
  const arrival = mapStop(row.arrival);
  return {
    id: `${flightNumber || "flight"}-${departure.date || "date"}-${departure.time || index}-${index}`,
    airline: text(row.airline?.name),
    flight_number: flightNumber,
    status: text(row.flight_status),
    departure,
    arrival,
    registration: text(row.aircraft?.registration),
    aircraft_type: text(row.aircraft?.iata) || text(row.aircraft?.icao)
  };
}

export default {
  fetch: withSupabase({ auth: "user" }, async (request, context) => {
    const requestId = crypto.randomUUID();
    const origin = request.headers.get("origin") || "https://sherlockzang.github.io";
    if (!ALLOWED_ORIGINS.has(origin)) return fail(origin, requestId, "INVALID_INPUT", "请求来源不受支持", 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "POST") return fail(origin, requestId, "METHOD_NOT_ALLOWED", "只支持 POST 请求", 405);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return fail(origin, requestId, "INVALID_INPUT", "查询内容格式不正确", 400);
    }

    const flightNumber = text(body.flightNumber).replaceAll(" ", "").toUpperCase();
    const departureDate = text(body.departureDate);
    if (!FLIGHT_NUMBER_PATTERN.test(flightNumber)) return fail(origin, requestId, "INVALID_INPUT", "请输入正确的 IATA 航班号", 400);
    if (departureDate && !/^\d{4}-\d{2}-\d{2}$/.test(departureDate)) return fail(origin, requestId, "INVALID_INPUT", "出发日期格式不正确", 400);

    const apiKey = Deno.env.get("AVIATIONSTACK_API_KEY");
    if (!apiKey) return fail(origin, requestId, "API_NOT_CONFIGURED", "航班查询暂未配置", 503);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const url = new URL("https://api.aviationstack.com/v1/flights");
    url.searchParams.set("access_key", apiKey);
    url.searchParams.set("flight_iata", flightNumber);
    url.searchParams.set("limit", "10");

    try {
      const response = await fetch(url, { signal: controller.signal, headers: { "Accept": "application/json" } });
      const payload = await response.json() as { data?: unknown; error?: unknown };
      if (!response.ok || payload.error || !Array.isArray(payload.data)) {
        console.error("Aviationstack upstream error", { requestId, status: response.status, user: text(context.userClaims?.id).slice(0, 8) });
        return fail(origin, requestId, "API_UNAVAILABLE", "暂时无法获取航班信息", 503);
      }

      const flights = (payload.data as AviationFlight[])
        .map(mapFlight)
        .filter((flight) => flight.flight_number && flight.departure.airport && flight.arrival.airport)
        .sort((left, right) => {
          if (!departureDate) return 0;
          return Number(right.departure.date === departureDate) - Number(left.departure.date === departureDate);
        })
        .slice(0, 6);
      return json(origin, requestId, { data: { flights } });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return fail(origin, requestId, "API_TIMEOUT", "航班查询超时", 504);
      console.error("Aviationstack request failed", { requestId, user: text(context.userClaims?.id).slice(0, 8) });
      return fail(origin, requestId, "API_UNAVAILABLE", "暂时无法获取航班信息", 503);
    } finally {
      clearTimeout(timeout);
    }
  })
};
