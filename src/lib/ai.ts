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

function demoToken() {
  return localStorage.getItem("life-tracker-demo-session") || undefined;
}

export async function deepseekAssist<T>(action: AiAction, payload: Record<string, unknown>, isDemo = false) {
  const requestId = crypto.randomUUID();
  const { data, error } = await supabase.functions.invoke("deepseek-assist", {
    body: { action, requestId, ...payload, ...(isDemo ? { demoSessionToken: demoToken() } : {}) }
  });
  if (error) throw new Error(await edgeFunctionMessage(error, "智能服务暂时不可用，请稍后重试或继续手动填写。"));
  if (data?.error) throw new Error(data.error.message || "智能服务暂时不可用");
  return data?.data as { action: AiAction; cached?: boolean; skipped?: boolean; result: T; generatedAt?: string };
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

export async function generateDailySummary() {
  return deepseekAssist<string>("daily_summary", { date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()) });
}
