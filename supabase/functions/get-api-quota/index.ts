import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, authenticatedUser, errorResponse, json, preflight, requestOrigin } from "../_shared/api.ts";

function shanghaiPeriod() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (name: string) => parts.find((part) => part.type === name)?.value || "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const month = `${get("year")}-${get("month")}`;
  const nextDay = new Date(`${day}T00:00:00+08:00`); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextMonth = new Date(`${month}-01T00:00:00+08:00`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  return { day, month, dayEnd: nextDay.toISOString(), monthEnd: nextMonth.toISOString() };
}

function expectedBuckets(userId: string, tier: string, periods: ReturnType<typeof shanghaiPeriod>) {
  const values: Array<{ bucket_key: string; used_value: number; limit_value: number; period_end: string }> = [];
  if (tier === "owner") {
    values.push({ bucket_key: `aviation:owner:${periods.month}`, used_value: 0, limit_value: 20, period_end: periods.monthEnd });
    values.push({ bucket_key: `deepseek:light:owner:${userId}:${periods.day}`, used_value: 0, limit_value: 200, period_end: periods.dayEnd });
    values.push({ bucket_key: `deepseek:recap:owner:${userId}:${periods.month}`, used_value: 0, limit_value: 50, period_end: periods.monthEnd });
  } else {
    values.push({ bucket_key: `aviation:shared:${periods.month}`, used_value: 0, limit_value: 80, period_end: periods.monthEnd });
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
      const { data: entitlement } = await admin().from("api_entitlements").select("tier").eq("user_id", user.id).is("revoked_at", null).maybeSingle();
      const tier = entitlement?.tier || "standard";
      const expected = expectedBuckets(user.id, tier, periods);
      const [{ data: buckets }, { data: cooldown }, { count: deepseekMonth }] = await Promise.all([
        admin().from("api_quota_buckets").select("bucket_key, used_value, limit_value, period_end").in("bucket_key", expected.map((bucket) => bucket.bucket_key)),
        admin().from("api_cooldowns").select("until_at").eq("principal_key", `user:${user.id}`).gt("until_at", new Date().toISOString()).maybeSingle(),
        admin().from("api_usage_events").select("id", { count: "exact", head: true }).eq("service", "deepseek").gte("created_at", `${periods.month}-01T00:00:00+08:00`).eq("counted", true)
      ]);
      const usedByKey = new Map((buckets || []).map((bucket) => [bucket.bucket_key, bucket]));
      const quotaBuckets = expected.map((bucket) => usedByKey.get(bucket.bucket_key) || bucket);
      return json(origin, requestId, {
        data: {
          tier,
          timezone: "Asia/Shanghai",
          cooldownUntil: cooldown?.until_at || null,
          deepseekMonthTotal: deepseekMonth || 0,
          buckets: quotaBuckets
        }
      });
    } catch (error) {
      return errorResponse(origin, requestId, error);
    }
  }
};
