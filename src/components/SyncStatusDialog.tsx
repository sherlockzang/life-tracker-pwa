import { useState } from "react";
import type { PendingMutation } from "../lib/offline";
import type { PendingAiRecovery } from "../lib/ai";
import { inspectSyncConflict, resolveSyncConflict } from "../lib/data";

interface Props {
  items: PendingMutation[]; aiCopies: PendingAiRecovery[];
  online: boolean; cloudReady: boolean; isDemo: boolean;
  onClose: () => void; onRetrySave: () => Promise<void>; onRetryAi: () => Promise<void>;
  onResolved: () => Promise<void>;
}
export function SyncStatusDialog({ items, aiCopies, online, cloudReady, isDemo, onClose, onRetrySave, onRetryAi, onResolved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<Awaited<ReturnType<typeof inspectSyncConflict>> | null>(null);
  const activeItems = items.filter(item => !item.supersededBy);
  async function retry(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "仍未完成保存，请保留本地副本"); }
    finally { setBusy(false); }
  }
  function exportCopies() {
    const blob = new Blob([JSON.stringify({ records: items, aiResults: aiCopies }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = "life-tracker-local-copies.json"; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="modal-backdrop"><section className="modal-card glass-card" role="dialog" aria-modal="true" aria-labelledby="sync-status-title">
    <header><h2 id="sync-status-title">同步与本地副本</h2><button className="secondary-button" onClick={onClose}>关闭</button></header>
    <p>只有收到云端确认才显示“已同步”。冲突可点击“比较并处理”，核对两份内容后选择保留云端或保存本机内容；原始副本仍可导出。</p>
    <p>导出文件包含个人内容及临时保存凭据，请妥善保管，不要公开分享。</p>
    {items.map(item => <p key={item.id}><b>{String(item.payload.content || item.payload.name || item.table)}</b> · {item.supersededBy ? "已处理，保留历史副本（不会再次同步）" : item.error || "等待同步"}{!item.supersededBy && item.state === "conflict" && <button className="secondary-button" disabled={busy || !online || isDemo} onClick={() => void retry(async () => setReview(await inspectSyncConflict(item)))}>比较并处理</button>}</p>)}
    {review && <section><h3>核对冲突内容</h3><b>云端内容</b><pre className="local-copy-content">{JSON.stringify(review.cloud, null, 2) || "云端记录不存在"}</pre><b>本机最新内容</b><pre className="local-copy-content">{JSON.stringify(review.inspected.at(-1)?.payload, null, 2)}</pre><p>保存本机内容会替换以上云端版本。若云端随后又发生变化，将再次提示冲突，不会强制覆盖。</p>{(["cloud", "local"] as const).map(choice => <button key={choice} className="secondary-button" disabled={busy || !online} onClick={() => void retry(async () => { await resolveSyncConflict(review, choice); setReview(null); await onResolved(); })}>{choice === "cloud" ? "保留云端，归档本机副本" : "使用本机内容保存"}</button>)}</section>}
    {aiCopies.map(item => <section key={item.id}><p><b>AI 结果待保存</b> · {item.error || item.warning || "内容已生成，但尚未确认云端保存"}</p><pre className="local-copy-content">{typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}</pre></section>)}
    {!activeItems.length && !aiCopies.length && <p>{isDemo ? "演示数据仅保存在此设备。" : cloudReady && online ? "当前记录已获云端确认。" : "暂无待同步记录；网络连接不代表云端已确认。"}</p>}
    {error && <p className="field-error">{error}</p>}
    <footer>
      <button className="secondary-button" disabled={!items.length && !aiCopies.length} onClick={exportCopies}>导出本地副本</button>
      <button className="primary-button" disabled={!online || isDemo || busy} onClick={() => void retry(onRetrySave)}>重试可恢复的保存</button>
      {!!aiCopies.length && <button className="secondary-button" disabled={!online || busy} onClick={() => void retry(onRetryAi)}>仅重试 AI 保存（不重新生成）</button>}
    </footer>
  </section></div>;
}
