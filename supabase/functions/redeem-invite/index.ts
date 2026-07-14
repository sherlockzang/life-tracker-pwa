import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, authenticatedUser, errorResponse, json, preflight, readJson, requestOrigin, sha256, stringField, ApiError } from "../_shared/api.ts";

export default {
  async fetch(request: Request) {
    const requestId = crypto.randomUUID();
    const origin = requestOrigin(request);
    const early = preflight(request, requestId);
    if (early) return early;
    try {
      const user = await authenticatedUser(request);
      const body = await readJson(request, 2_000);
      const code = stringField(body.code, 80).toUpperCase().replace(/\s+/g, "");
      const codeHash = await sha256(code);
      const { data, error } = await admin().rpc("redeem_friend_invite", { p_user_id: user.id, p_code_hash: codeHash });
      if (error) throw new ApiError("INTERNAL_ERROR", "邀请码暂时无法验证", 503);
      const result = data as { ok?: boolean; code?: string; tier?: string };
      if (!result.ok) {
        if (result.code === "TOO_MANY_ATTEMPTS") throw new ApiError(result.code, "尝试次数较多，请一小时后再试。", 429);
        throw new ApiError("INVALID_INVITE", "邀请码无效或已停用，请检查后重试。", 400);
      }
      return json(origin, requestId, { data: { tier: result.tier || "friend" } });
    } catch (error) {
      return errorResponse(origin, requestId, error);
    }
  }
};

