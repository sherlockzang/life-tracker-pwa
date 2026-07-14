import { supabase } from "./supabase";
import type { ApiQuotaSnapshot } from "../types";
import { edgeFunctionMessage } from "./functionError";

export async function getApiQuota() {
  const { data, error } = await supabase.functions.invoke("get-api-quota", { body: {} });
  if (error || !data?.data) throw new Error("暂时无法读取智能服务额度");
  return data.data as ApiQuotaSnapshot;
}

export async function redeemInvite(code: string) {
  const { data, error } = await supabase.functions.invoke("redeem-invite", { body: { code } });
  if (error) throw new Error(await edgeFunctionMessage(error, "邀请码暂时无法验证"));
  if (data?.error) throw new Error(data.error.message || "邀请码无效");
  return data.data as { tier: "friend" | "owner" };
}

async function digest(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function startDemoSession() {
  let seed = localStorage.getItem("life-tracker-demo-device");
  if (!seed) {
    seed = crypto.randomUUID();
    localStorage.setItem("life-tracker-demo-device", seed);
  }
  const { data, error } = await supabase.functions.invoke("start-demo-session", { body: { deviceHash: await digest(seed) } });
  if (error || !data?.data?.token) throw new Error(error ? await edgeFunctionMessage(error, "暂时无法进入演示模式，请稍后重试") : "暂时无法进入演示模式，请稍后重试");
  localStorage.setItem("life-tracker-demo-session", data.data.token);
  localStorage.setItem("life-tracker-demo-session-expires", data.data.expiresAt);
  return data.data as { token: string; expiresAt: string };
}
