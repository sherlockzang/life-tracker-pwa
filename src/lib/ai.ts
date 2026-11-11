import { supabase } from "./supabase";
import type { ExpenseCategory } from "../types";
import { edgeFunctionMessage } from "./functionError";

export type AiAction = "route" | "expense_parse" | "note_polish" | "trip_recap" | "daily_summary";

export interface ParsedExpense {
  amount: number | null;
  currency: string | null;
  category: ExpenseCategory | null;
  merchant: string | null;
  note: string | null;
}

export interface AiResponse<T> {
  action: AiAction; cached?: boolean; skipped?: boolean; result: T;
  generatedAt?: string; persisted?: boolean; warning?: string; recoveryToken?: string;
  contextKey?: string; usageLogPending?: boolean; recoverySaved?: boolean; newerPreserved?: boolean;
}

export interface PendingAiRecovery {
  id: string; action: AiAction; targetKey: string; createdAt: string; generatedAt?: string;
  result: unknown; recoveryToken?: string; warning?: string; error?: string;
}

export const AI_RECOVERY_CHANGED = "life-tracker-ai-recovery-change";
const recoveryKey = (userId: string) => `life-tracker-ai-recovery:${userId}`;

export function pendingAiRecoveries(userId: string): PendingAiRecovery[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(recoveryKey(userId)) || "[]");
    return Array.isArray(value) ? value.filter((item): item is PendingAiRecovery => item && typeof item.id === "string" && typeof item.action === "string" && typeof item.createdAt === "string") : [];
  } catch { return []; }
}

function saveRecoveries(userId: string, items: PendingAiRecovery[]) {
  localStorage.setItem(recoveryKey(userId), JSON.stringify(items));
  window.dispatchEvent(new CustomEvent(AI_RECOVERY_CHANGED));
}

function quotaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function recoveryTarget(action: AiAction, payload: Record<string, unknown>) {
  if (action === "trip_recap") return `trip:${String(payload.tripId)}`;
  if (action === "daily_summary") return payload.clientContext ? `daily:${String(payload.clientContext)}` : `daily:${quotaDate()}:default`;
  return "";
}

function demoToken() {
  return localStorage.getItem("life-tracker-demo-session") || undefined;
}

export async function deepseekAssist<T>(action: AiAction, payload: Record<string, unknown>, isDemo = false) {
  const ownerId = isDemo ? undefined : (await supabase.auth.getSession()).data.session?.user.id;
  if (!isDemo && !ownerId) throw new Error("请先登录后再使用智能服务。");
  const assertCurrentOwner = async () => {
    if (ownerId && (await supabase.auth.getSession()).data.session?.user.id !== ownerId) throw new Error("账号已切换，已停止展示上一账号的 AI 结果。请在当前账号中重新操作。");
  };
  const targetKey = recoveryTarget(action, payload);
  if (ownerId && targetKey && payload.regenerate !== true) {
    const pending = pendingAiRecoveries(ownerId).find((item) => item.action === action && item.targetKey === targetKey);
    if (pending) {
      await assertCurrentOwner();
      return { action, result: pending.result as T, generatedAt: pending.generatedAt, persisted: false, recoveryToken: pending.recoveryToken,
        warning: pending.warning || "这份结果尚未保存到云端，请先重试保存；不会重复调用 AI。" } satisfies AiResponse<T>;
    }
  }
  const requestId = crypto.randomUUID();
  await assertCurrentOwner();
  const { data, error } = await supabase.functions.invoke("deepseek-assist", {
    body: { ...payload, action, requestId, ...(isDemo ? { demoSessionToken: demoToken() } : { expectedOwner: ownerId }) }
  });
  if (error) throw new Error(await edgeFunctionMessage(error, "智能服务暂时不可用，请稍后重试或继续手动填写。"));
  if (data?.error) throw new Error(data.error.message || "智能服务暂时不可用");
  const response = data?.data as AiResponse<T>;
  if (!response || !("result" in response)) throw new Error("智能服务没有返回有效结果。");
  const stillOwner = !ownerId || (await supabase.auth.getSession()).data.session?.user.id === ownerId;
  if (ownerId && response.persisted === false) {
    try {
      const items = pendingAiRecoveries(ownerId);
      items.push({ id: requestId, action, targetKey, createdAt: new Date().toISOString(), result: response.result,
        generatedAt: response.generatedAt, recoveryToken: response.recoveryToken, warning: response.warning });
      saveRecoveries(ownerId, items);
    } catch {
      response.warning = "内容已生成，但云端同步及本机备份均未完成。请立即复制保存这份内容，不要反复重新生成。";
    }
  }
  // A server-validated old-account response may be backed up only under that
  // original owner. Never return its content into the newly active account UI.
  if (!stillOwner) throw new Error("账号已切换，已停止展示上一账号的 AI 结果。尚未同步的内容只保留在原账号中。");
  return response;
}

/** Persistence retry only: the Edge endpoint neither reserves quota nor calls DeepSeek. */
export async function retryAiPersistence(userId: string) {
  const currentOwner = async () => (await supabase.auth.getSession()).data.session?.user.id;
  if (await currentOwner() !== userId) throw new Error("请在原账号中重试保存这份内容。");
  let saved = 0;
  const errors: string[] = [];
  for (const item of pendingAiRecoveries(userId)) {
    if (await currentOwner() !== userId) break;
    if (!item.recoveryToken) { errors.push("这份内容没有可用的保存凭据，请先复制保存本地副本。"); continue; }
    try {
      const { data, error } = await supabase.functions.invoke("deepseek-assist", { body: { action: "retry_save", recoveryToken: item.recoveryToken } });
      if (error) throw new Error(await edgeFunctionMessage(error, "云端保存仍未完成，请保留本地副本后稍后再试。"));
      if (data?.error || data?.data?.persisted !== true) throw new Error(data?.error?.message || "云端保存仍未完成。");
      // The response belongs to the account captured above; a switch can stop
      // later requests, but must not move or expose this result to the new user.
      saveRecoveries(userId, pendingAiRecoveries(userId).filter((entry) => entry.id !== item.id));
      saved += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "云端保存仍未完成。";
      errors.push(message);
      try { saveRecoveries(userId, pendingAiRecoveries(userId).map((entry) => entry.id === item.id ? { ...entry, error: message } : entry)); } catch { /* Never remove a result whose retry was not confirmed. */ }
    }
  }
  return { saved, remaining: pendingAiRecoveries(userId).length, errors };
}

export async function parseExpense(text: string, isDemo = false) {
  return deepseekAssist<ParsedExpense>("expense_parse", { text }, isDemo);
}

export async function polishNote(text: string, isDemo = false) {
  return deepseekAssist<string>("note_polish", { text }, isDemo);
}

export async function generateTripRecap(tripId: string, regenerate = false, isDemo = false) {
  return deepseekAssist<string>("trip_recap", { tripId, regenerate }, isDemo);
}

export async function generateDailySummary(clientContext?: string) {
  // The backend owns the calendar calculation; do not send a device/Shanghai
  // date as if it were the business date of every trip.
  return deepseekAssist<string>("daily_summary", { ...(clientContext ? { clientContext } : {}) });
}
