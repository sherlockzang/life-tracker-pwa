import { createContext, useState } from "react";
import { ImagePlus } from "lucide-react";
import type { LifeRecord } from "../types";

export const RecordPhotoContext = createContext<{ onAttach: (record: LifeRecord, file: File) => Promise<void>; onDetach: (record: LifeRecord) => Promise<void> } | null>(null);

export function RecordPhotoAction({ record, isDemo, onAttach, onDetach }: { record: LifeRecord; isDemo: boolean; onAttach: (record: LifeRecord, file: File) => Promise<void>; onDetach: (record: LifeRecord) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(task: () => Promise<void>) {
    setBusy(true); setError("");
    try { await task(); } catch (failure) { setError(failure instanceof Error ? failure.message : "图片操作失败。"); }
    finally { setBusy(false); }
  }
  if (isDemo) return null;
  return <div className="record-photo-actions"><label className="record-control-button file-picker"><ImagePlus size={15} />{busy ? "处理中…" : record.image_path ? "更换图片" : "添加图片"}<input className="file-input-accessible" aria-label={`${record.image_path ? "更换" : "添加"}${record.content}的图片`} type="file" accept="image/jpeg,image/png,image/webp,image/heic" disabled={busy} onChange={event => { const file=event.target.files?.[0]; if (file) void run(() => onAttach(record, file)); event.target.value=""; }} /></label>{record.image_path && <button type="button" className="record-control-button" disabled={busy} onClick={() => void run(() => onDetach(record))}>移除图片关联</button>}<small>单张不超过 10 MB；上传需联网，移除关联不会删除存储原图。</small>{error && <p className="field-error" role="alert">{error}</p>}</div>;
}
