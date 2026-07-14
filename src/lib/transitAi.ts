import { supabase } from "./supabase";

export const TRANSIT_AI_ERROR = "AI查询暂时不可用，可以手动填写";

export async function queryTransitRoute(origin: string, destination: string, query: string, departureTime?: string) {
  const { data, error } = await supabase.functions.invoke("query-transit-route", {
    body: { origin: origin.trim(), destination: destination.trim(), query: query.trim(), departureTime: departureTime || undefined }
  });
  if (error) throw new Error(TRANSIT_AI_ERROR);
  const route = data?.data?.route;
  if (typeof route !== "string" || !route.trim()) throw new Error(TRANSIT_AI_ERROR);
  return route.trim();
}
