import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { LifeRecord } from "../types";

export function RecordActions({ record, onEdit, onDelete }: { record: LifeRecord; onEdit: (id: string) => void; onDelete: (record: LifeRecord) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    const warning = record.image_path ? "删除这条记录？关联图片会保留在私有存储中。" : "删除这条记录？此操作无法撤销。";
    if (!window.confirm(warning)) return;
    setBusy(true); setError("");
    try { await onDelete(record); } catch (failure) { setError(failure instanceof Error ? failure.message : "删除失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <div className="record-action-group"><div className="record-control-buttons"><button type="button" className="record-control-button" aria-label={`编辑${record.content}`} disabled={busy} onClick={() => onEdit(record.id)}><Pencil size={15} />编辑</button><button type="button" className="record-control-button" aria-label={`删除${record.content}`} disabled={busy} onClick={() => void remove()}><Trash2 size={15} />{busy ? "删除中…" : "删除"}</button></div>{error && <p className="field-error" role="alert">{error}</p>}</div>;
}
