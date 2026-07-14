import { createClient, type SupabaseClient, type User } from "jsr:@supabase/supabase-js@2";

export const ALLOWED_ORIGINS = new Set([
  "https://sherlockzang.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);

let adminClient: SupabaseClient | null = null;

export function admin() {
  if (adminClient) return adminClient;
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRole) throw new Error("Supabase service configuration is missing");
  adminClient = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  return adminClient;
}

export function requestOrigin(request: Request) {
  return request.headers.get("origin") || "https://sherlockzang.github.io";
}

export function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://sherlockzang.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin"
  };
}

export function json(origin: string, requestId: string, body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ ...body, requestId }), { status, headers: corsHeaders(origin) });
}

export function fail(origin: string, requestId: string, code: string, message: string, status: number, extra: Record<string, unknown> = {}) {
  return json(origin, requestId, { error: { code, message, ...extra } }, status);
}

export function preflight(request: Request, requestId: string) {
  const origin = requestOrigin(request);
  if (!ALLOWED_ORIGINS.has(origin)) return fail(origin, requestId, "INVALID_ORIGIN", "请求来源不受支持", 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return fail(origin, requestId, "METHOD_NOT_ALLOWED", "只支持 POST 请求", 405);
  return null;
}

export async function readJson(request: Request, maxBytes = 12_000) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new ApiError("INVALID_INPUT", "提交内容过长", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("INVALID_INPUT", "提交内容格式不正确", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError("INVALID_INPUT", "提交内容格式不正确", 400);
  return parsed as Record<string, unknown>;
}

export async function authenticatedUser(request: Request): Promise<User> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new ApiError("UNAUTHORIZED", "请先登录", 401);
  const { data, error } = await admin().auth.getUser(token);
  if (error || !data.user) throw new ApiError("UNAUTHORIZED", "登录状态已失效，请重新登录", 401);
  return data.user;
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function demoSession(rawToken: string) {
  if (!rawToken || rawToken.length > 200) throw new ApiError("DEMO_SESSION_EXPIRED", "演示会话已失效，请重新进入演示模式", 401);
  const tokenHash = await sha256(rawToken);
  const { data, error } = await admin().from("demo_sessions").select("id, expires_at").eq("token_hash", tokenHash).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error || !data) throw new ApiError("DEMO_SESSION_EXPIRED", "演示会话已失效，请重新进入演示模式", 401);
  await admin().from("demo_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
  return data as { id: string; expires_at: string };
}

export async function reserveQuota(args: { userId?: string; demoSessionId?: string; feature: string; requestId: string }) {
  const { data, error } = await admin().rpc("consume_api_quota", {
    p_user_id: args.userId || null,
    p_demo_session_id: args.demoSessionId || null,
    p_feature: args.feature,
    p_request_id: args.requestId
  });
  if (error) throw new ApiError("INTERNAL_ERROR", "智能服务暂时不可用", 503);
  const result = data as { allowed?: boolean; code?: string; tier?: string; reset_at?: string; retry_at?: string; duplicate?: boolean };
  if (!result.allowed) throw quotaError(result);
  return result;
}

export async function completeUsage(requestId: string, status: "completed" | "upstream_error" | "not_found" | "failed", responseMeta?: Record<string, unknown>) {
  await admin().rpc("complete_api_usage", { p_request_id: requestId, p_status: status, p_response_meta: responseMeta || null });
}

function quotaError(result: { code?: string; reset_at?: string; retry_at?: string }) {
  const code = result.code || "QUOTA_EXCEEDED";
  if (code === "COOLDOWN") return new ApiError(code, "操作有些频繁，为保护智能服务，查询功能已暂时暂停，请约 5 分钟后再试。", 429, { retryAt: result.retry_at });
  if (code === "AVIATION_QUOTA_EXCEEDED") return new ApiError(code, "本月航班查询额度已用完。你仍可以手动填写航班信息，并在下个额度周期继续匹配。", 429, { resetAt: result.reset_at });
  if (code === "AI_MONTHLY_QUOTA_EXCEEDED") return new ApiError(code, "本月共享 AI 查询额度已用完，手动填写和其他记录功能仍可正常使用。", 429, { resetAt: result.reset_at });
  if (code === "AI_QUOTA_EXCEEDED") return new ApiError(code, "当前 AI 额度已用完，手动填写和其他功能不受影响。", 429, { resetAt: result.reset_at });
  if (code === "DUPLICATE_REQUEST") return new ApiError(code, "这个请求已经处理过，请查看现有结果。", 409);
  if (code === "DEMO_SESSION_EXPIRED") return new ApiError(code, "演示会话已失效，请重新进入演示模式。", 401);
  if (code === "DEMO_MOCK_ONLY") return new ApiError(code, "演示模式下此功能使用预置示例，不会调用外部服务。", 400);
  return new ApiError(code, "智能服务暂时不可用", 503);
}

export class ApiError extends Error {
  code: string;
  status: number;
  extra: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export function errorResponse(origin: string, requestId: string, error: unknown) {
  if (error instanceof ApiError) return fail(origin, requestId, error.code, error.message, error.status, error.extra);
  console.error("Unhandled edge function error", { requestId, error: error instanceof Error ? error.message : String(error) });
  return fail(origin, requestId, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试", 503);
}

export function stringField(value: unknown, maxLength: number, required = true) {
  const result = typeof value === "string" ? value.trim() : "";
  if ((required && !result) || result.length > maxLength) throw new ApiError("INVALID_INPUT", "提交内容不完整或过长", 400);
  return result;
}

