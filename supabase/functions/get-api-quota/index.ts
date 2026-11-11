import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, ApiError, authenticatedUser, errorResponse, json, preflight, requestOrigin } from "../_shared/api.ts";
import { readAllPages } from "../_shared/pagination.ts";
import { shanghaiPeriod } from "../_shared/quotaPeriod.ts";

function expectedBuckets(userId: string, tier: string, periods: ReturnType<typeof shanghaiPeriod>) {
  const values: Array<{ bucket_key: string; used_value: number; limit_value: number; period_end: string }> = [
    { bucket_key: `aviation:global:${periods.month}`, used_value: 0, limit_value: 100, period_end: periods.monthEnd },
    { bucket_key: `aviation:shared:${periods.month}`, used_value: 0, limit_value: 80, period_end: periods.monthEnd }
  ];
  if (tier !== "owner") {
    values.push({ bucket_key: `deepseek:light:shared:${periods.month}`, used_value: 0, limit_value: 10000, period_end: periods.monthEnd });
    values.push({ bucket_key: `deepseek:recap:${tier}:${userId}:${periods.month}`, used_value: 0, limit_value: tier === "friend" ? 10 : 3, period_end: periods.monthEnd });
    if (tier === "standard") {
      values.push({ bucket_key: `aviation:standard:${userId}:${periods.day}`, used_value: 0, limit_value: 2, period_end: periods.dayEnd });
      values.push({ bucket_key: `deepseek:light:standard:${userId}:${periods.day}`, used_value: 0, limit_value: 15, period_end: periods.dayEnd });
      values.push({ bucket_key: `deepseek:summary:standard:${userId}:${periods.day}`, used_value: 0, limit_value: 1, period_end: periods.dayEnd });
    }
  }
  return values;
}

export default {
  async fetch(request: Request) {
    const requestId = crypto.randomUUID();
    const origin = requestOrigin(request);
    const early = preflight(request, requestId);
    if (early) return early;
    try {
      const user = await authenticatedUser(request);
      const periods = shanghaiPeriod();
      const { data: entitlement, error: entitlementError } = await admin().from("api_entitlements").select("tier").eq("user_id", user.id).is("revoked_at", null).maybeSingle();
      if (entitlementError) throw new ApiError("DATA_UNAVAILABLE", "暂时无法核对权限与额度，请稍后重试。", 503);
      const tier = entitlement?.tier || "standard";
      const expected = expectedBuckets(user.id, tier, periods);
      const [buckets, cooldownResult, monthResult] = await Promise.all([
        readAllPages((cursor) => {
          // This collection has a text primary key rather than an `id` column.
          let query = admin().from("api_quota_buckets").select("id:bucket_key, bucket_key, used_value, limit_value, period_end").in("bucket_key", expected.map((bucket) => bucket.bucket_key)).order("bucket_key").limit(500);
          if (cursor) query = query.gt("bucket_key", cursor);
          return query;
        }).catch(() => { throw new ApiError("DATA_UNAVAILABLE", "暂时无法读取完整额度，请稍后重试。", 503); }),
        admin().from("api_cooldowns").select("until_at").eq("principal_key", `user:${user.id}`).gt("until_at", new Date().toISOString()).maybeSingle(),
        admin().from("api_usage_events").select("id", { count: "exact", head: true }).eq("service", "deepseek").gte("created_at", `${periods.month}-01T00:00:00+08:00`).eq("counted", true)
      ]);
      if (cooldownResult.error || monthResult.error || monthResult.count == null) throw new ApiError("DATA_UNAVAILABLE", "暂时无法核对完整额度，不会将读取失败显示为剩余额度。", 503);
      const cooldown = cooldownResult.data;
      const deepseekMonth = monthResult.count;
      const usedByKey = new Map((buckets || []).map((bucket) => [bucket.bucket_key, bucket]));
      const quotaBuckets = expected.map((bucket) => usedByKey.get(bucket.bucket_key) || bucket);
      const globalAviation = quotaBuckets.find((bucket) => bucket.bucket_key.startsWith("aviation:global:"));
      const sharedAviation = quotaBuckets.find((bucket) => bucket.bucket_key.startsWith("aviation:shared:"));
      const globalUsed = globalAviation?.used_value || 0;
      const nonOwnerUsed = sharedAviation?.used_value || 0;
      return json(origin, requestId, {
        data: {
          tier,
          timezone: "Asia/Shanghai",
          cooldownUntil: cooldown?.until_at || null,
          deepseekMonthTotal: deepseekMonth || 0,
          aviation: {
            globalUsed,
            globalLimit: 100,
            globalRemaining: Math.max(0, 100 - globalUsed),
            nonOwnerUsed,
            nonOwnerLimit: 80,
            ownerUsed: Math.max(0, globalUsed - nonOwnerUsed)
          },
          buckets: quotaBuckets
        }
      });
    } catch (error) {
      return errorResponse(origin, requestId, error);
    }
  }
};
