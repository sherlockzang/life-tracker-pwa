import type { PendingMutation } from "./offline";

export interface SaveResult { state: "confirmed" | "pending" | "failed" | "conflict"; row: Record<string, unknown>; error?: string }
export function retryableWriteError(error: unknown) {
  const value = error as { code?: string; status?: number; message?: string };
  return error instanceof TypeError || (value.status || 0) >= 500 || ["08000", "08003", "08006", "40001", "40P01", "55P03", "53300", "57014"].includes(value.code || "") || /network|failed to fetch|fetch failed|timeout|load failed|connection/i.test(value.message || "");
}
export function writeErrorMessage(error: unknown) {
  const value = error as { code?: string };
  if (value.code === "42501") return "云端拒绝了保存权限；草稿和本地副本已保留，请检查账号权限。";
  if (["PGRST202", "42703"].includes(value.code || "")) return "云端数据库尚未更新；本地副本已保留，请完成数据库迁移后重试。";
  return "云端保存失败；草稿和本地副本已保留，请检查数据后重试。";
}
interface Adapter {
  currentOwner: () => Promise<string | undefined>;
  claim: (id: string, ownerId: string) => Promise<PendingMutation | null>;
  write: (item: PendingMutation) => Promise<{ data: { ok?: boolean; code?: string; row?: Record<string, unknown> } | null; error: unknown }>;
  finish: (item: PendingMutation, row: Record<string, unknown>) => Promise<void>;
  fail: (item: PendingMutation, state: PendingMutation["state"], message: string) => Promise<void>;
}
export async function replayMutation(candidate: PendingMutation, adapter: Adapter): Promise<SaveResult | null> {
  if (await adapter.currentOwner() !== candidate.ownerId) return null;
  const item = await adapter.claim(candidate.id, candidate.ownerId);
  if (!item) return null;
  if (await adapter.currentOwner() !== item.ownerId) { await adapter.fail(item, "pending", "等待原账号登录后同步"); return null; }
  try {
    const { data, error } = await adapter.write(item);
    if (error) throw error;
    if (data?.code === "CONFLICT") {
      const message = "云端内容已在其他设备更新；本地副本已保留，请导出核对，未覆盖云端。";
      await adapter.fail(item, "conflict", message); return { state: "conflict", row: item.payload, error: message };
    }
    if (!data?.ok || !data.row) throw new Error("Invalid save response");
    await adapter.finish(item, data.row);
    return { state: "confirmed", row: data.row };
  } catch (error) {
    const pending = retryableWriteError(error);
    const message = pending ? "已保存在此设备，等待联网同步" : writeErrorMessage(error);
    await adapter.fail(item, pending ? "pending" : "failed", message);
    return { state: pending ? "pending" : "failed", row: item.payload, error: message };
  }
}
