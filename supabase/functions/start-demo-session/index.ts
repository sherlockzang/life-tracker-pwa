import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, ApiError, errorResponse, json, preflight, readJson, requestOrigin, sha256, stringField } from "../_shared/api.ts";

export default {
  async fetch(request: Request) {
    const requestId = crypto.randomUUID();
    const origin = requestOrigin(request);
    const early = preflight(request, requestId);
    if (early) return early;
    try {
      const body = await readJson(request, 2_000);
      const deviceHash = stringField(body.deviceHash, 128);
      if (!/^[a-f0-9]{32,128}$/i.test(deviceHash)) throw new ApiError("INVALID_INPUT", "设备标识格式不正确", 400);

      const rawToken = `${crypto.randomUUID()}.${crypto.randomUUID()}`;
      const tokenHash = await sha256(rawToken);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: existing } = await admin().from("demo_sessions").select("id").eq("device_hash", deviceHash).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const query = existing?.id
        ? admin().from("demo_sessions").update({ token_hash: tokenHash, expires_at: expiresAt, last_seen_at: new Date().toISOString() }).eq("id", existing.id)
        : admin().from("demo_sessions").insert({ token_hash: tokenHash, device_hash: deviceHash, expires_at: expiresAt });
      const { error } = await query;
      if (error) throw new ApiError("INTERNAL_ERROR", "暂时无法进入演示模式", 503);
      return json(origin, requestId, { data: { token: rawToken, expiresAt } });
    } catch (error) {
      return errorResponse(origin, requestId, error);
    }
  }
};
