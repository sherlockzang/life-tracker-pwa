import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, ApiError, authenticatedUser, errorResponse, json, preflight, readJson, requestOrigin, stringField } from "../_shared/api.ts";

type ManagedTier = "standard" | "friend" | "owner";

async function requireOwner(userId: string) {
  const { data, error } = await admin()
    .from("api_entitlements")
    .select("tier")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error || data?.tier !== "owner") throw new ApiError("FORBIDDEN", "仅 Owner 可以使用账号管理后台", 403);
}

function monthStart() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}-01T00:00:00+08:00`;
}

async function listUsers(query: string) {
  const { data: authData, error: authError } = await admin().auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (authError) throw new ApiError("INTERNAL_ERROR", "暂时无法读取账号列表", 503);

  const normalized = query.trim().toLowerCase();
  const matched = authData.users
    .filter((candidate) => !normalized || candidate.email?.toLowerCase().includes(normalized))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    .slice(0, 50);
  const ids = matched.map((candidate) => candidate.id);

  if (!ids.length) return [];

  const [{ data: entitlements, error: entitlementError }, { data: usage, error: usageError }] = await Promise.all([
    admin().from("api_entitlements").select("user_id, tier, source, granted_at, updated_at").in("user_id", ids).is("revoked_at", null),
    admin().from("api_usage_events").select("user_id, service, feature").in("user_id", ids).eq("counted", true).gte("created_at", monthStart())
  ]);
  if (entitlementError || usageError) throw new ApiError("INTERNAL_ERROR", "暂时无法读取账号权限与用量", 503);

  const entitlementByUser = new Map((entitlements || []).map((item) => [item.user_id, item]));
  const usageByUser = new Map<string, { aviation: number; deepseek: number }>();
  for (const event of usage || []) {
    if (!event.user_id) continue;
    const current = usageByUser.get(event.user_id) || { aviation: 0, deepseek: 0 };
    if (event.service === "aviation") current.aviation += 1;
    if (event.service === "deepseek") current.deepseek += 1;
    usageByUser.set(event.user_id, current);
  }

  return matched.map((candidate) => {
    const entitlement = entitlementByUser.get(candidate.id);
    const tier = (entitlement?.tier || "standard") as ManagedTier;
    const totals = usageByUser.get(candidate.id) || { aviation: 0, deepseek: 0 };
    return {
      id: candidate.id,
      email: candidate.email || "未提供邮箱",
      createdAt: candidate.created_at,
      lastSignInAt: candidate.last_sign_in_at || null,
      tier,
      source: entitlement?.source || "default",
      grantedAt: entitlement?.granted_at || null,
      monthUsage: totals
    };
  });
}

export default {
  async fetch(request: Request) {
    const requestId = crypto.randomUUID();
    const origin = requestOrigin(request);
    const early = preflight(request, requestId);
    if (early) return early;

    try {
      const user = await authenticatedUser(request);
      await requireOwner(user.id);
      const body = await readJson(request, 4_000);
      const action = stringField(body.action, 30);

      if (action === "list") {
        const query = stringField(body.query, 120, false);
        return json(origin, requestId, { data: { users: await listUsers(query) } });
      }

      if (action === "set_tier") {
        const targetUserId = stringField(body.targetUserId, 80);
        const tier = stringField(body.tier, 20) as ManagedTier;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetUserId)) {
          throw new ApiError("INVALID_INPUT", "账号标识格式不正确", 400);
        }
        if (tier !== "standard" && tier !== "friend") throw new ApiError("INVALID_INPUT", "只支持 Standard 或 Friend 权限", 400);

        const { data, error } = await admin().rpc("owner_set_user_tier", {
          p_actor_user_id: user.id,
          p_target_user_id: targetUserId,
          p_new_tier: tier
        });
        if (error) throw new ApiError("INTERNAL_ERROR", "权限修改失败，请稍后重试", 503);
        const result = data as { ok?: boolean; code?: string; old_tier?: string; new_tier?: string };
        if (!result.ok) {
          if (result.code === "OWNER_LOCKED") throw new ApiError(result.code, "Owner 账号权限已锁定，不能在这里修改", 409);
          if (result.code === "USER_NOT_FOUND") throw new ApiError(result.code, "没有找到这个账号", 404);
          throw new ApiError(result.code || "FORBIDDEN", "没有权限执行这项操作", 403);
        }
        return json(origin, requestId, { data: result });
      }

      throw new ApiError("INVALID_INPUT", "不支持的管理操作", 400);
    } catch (error) {
      return errorResponse(origin, requestId, error);
    }
  }
};
