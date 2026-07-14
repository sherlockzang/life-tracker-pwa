import { deepseekAssist } from "./ai";

export const TRANSIT_AI_ERROR = "AI查询暂时不可用，可以手动填写";

export async function queryTransitRoute(origin: string, destination: string, query: string, departureTime?: string, isDemo = false) {
  const data = await deepseekAssist<string>("route", { origin: origin.trim(), destination: destination.trim(), query: query.trim(), departureTime: departureTime || undefined }, isDemo);
  if (typeof data.result !== "string" || !data.result.trim()) throw new Error(TRANSIT_AI_ERROR);
  return data.result.trim();
}
