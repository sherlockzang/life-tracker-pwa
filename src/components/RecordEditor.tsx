import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { Currency, ExpenseCategory, LifeRecord, Trip } from "../types";
import { CATEGORY_META, CURRENCIES } from "../types";
import { flightTimeOptions, utcOffsetLabel } from "../../supabase/functions/_shared/flightTime";

function localInput(iso: string) {
  const date = new Date(iso);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function RecordEditor({ record, trips, isDemo, onClose, onSave, onUpload }: {
  record: LifeRecord; trips: Trip[]; isDemo: boolean; onClose: () => void;
  onSave: (record: LifeRecord) => Promise<void>; onUpload: (file: File) => Promise<string>;
}) {
  const [original] = useState(record);
  const [content, setContent] = useState(record.content);
  const [notes, setNotes] = useState(record.notes || "");
  const [location, setLocation] = useState(record.location || "");
  const [amount, setAmount] = useState(record.amount == null ? "" : String(record.amount));
  const [currency, setCurrency] = useState<Currency>(record.currency || "CNY");
  const [category, setCategory] = useState<ExpenseCategory>(record.expense_category || "other");
  const [eventAt, setEventAt] = useState(() => localInput(record.event_at));
  const [offset, setOffset] = useState("");
  const [tripId, setTripId] = useState(record.trip_id || "");
  const [imagePath, setImagePath] = useState(record.image_path);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLFormElement>(null);
  const closeRef = useRef(onClose);
  const savingRef = useRef(saving);
  useEffect(() => { closeRef.current = onClose; savingRef.current = saving; }, [onClose, saving]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') || []).filter(element => element.getClientRects().length > 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
    };
    focusable()[0]?.focus();
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, []);
  let timeOptions: ReturnType<typeof flightTimeOptions> = [];
  try { if (eventAt !== localInput(original.event_at)) timeOptions = flightTimeOptions({ date: eventAt.slice(0, 10), time: eventAt.slice(11), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); } catch { /* Report invalid local clocks on save. */ }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const changedTime = eventAt !== localInput(original.event_at);
    if (changedTime && !timeOptions.length) { setError("时间无效或因夏令时不存在，请重新选择。"); return; }
    if (changedTime && timeOptions.length > 1 && !offset) { setError("此时间因夏令时出现两次，请选择第一次或第二次。"); return; }
    const chosen = timeOptions.find(item => String(item.utcOffsetMinutes) === offset) || timeOptions[0];
    if (record.record_type === "expense" && (!amount.trim() || !Number.isFinite(Number(amount)) || Number(amount) < 0)) { setError("请输入有效金额。"); return; }
    setSaving(true);
    try {
      await onSave({ ...original, content: content.trim(), notes: notes.trim() || null, location: location.trim() || null,
        event_at: changedTime ? new Date(chosen.instant).toISOString() : original.event_at, trip_id: tripId || null,
        amount: record.record_type === "expense" ? Number(amount) : null,
        currency: record.record_type === "expense" ? currency : null,
        expense_category: record.record_type === "expense" ? category : null, image_path: imagePath });
      onClose();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "保存失败，请重试。"); }
    finally { setSaving(false); }
  }

  async function chooseImage(file?: File) {
    if (!file) return;
    setError(""); setSaving(true);
    try { setImagePath(await onUpload(file)); }
    catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : "图片上传失败。"); }
    finally { setSaving(false); }
  }

  return <div className="modal-backdrop"><form ref={dialogRef} className="modal-card glass-card record-editor" role="dialog" aria-modal="true" aria-labelledby="record-edit-title" onSubmit={submit}>
    <header><h2 id="record-edit-title">编辑{record.record_type === "expense" ? "消费" : "随记"}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X /></button></header>
    <label>内容<input value={content} onChange={event => setContent(event.target.value)} required maxLength={4000} /></label>
    {record.record_type === "expense" && <div className="form-row"><label>金额<input type="number" min="0" step="any" value={amount} onChange={event => setAmount(event.target.value)} required /></label><label>币种<select value={currency} onChange={event => setCurrency(event.target.value as Currency)}>{CURRENCIES.map(item => <option key={item.code} value={item.code}>{item.code} · {item.label}</option>)}</select></label><label>分类<select value={category} onChange={event => setCategory(event.target.value as ExpenseCategory)}>{Object.entries(CATEGORY_META).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label></div>}
    <label>时间 <small>设备当地时间</small><input type="datetime-local" value={eventAt} onChange={event => { setEventAt(event.target.value); setOffset(""); }} required /></label>
    {timeOptions.length > 1 && <label>重复时间 <small>请选择第一次或第二次</small><select value={offset} onChange={event => setOffset(event.target.value)} required><option value="">请选择</option>{timeOptions.map((item, index) => <option key={item.utcOffsetMinutes} value={item.utcOffsetMinutes}>{index === 0 ? "第一次" : "第二次"} · {utcOffsetLabel(item.utcOffsetMinutes)}</option>)}</select></label>}
    <label>地点 <small>选填</small><input value={location} onChange={event => setLocation(event.target.value)} /></label>
    {!record.parent_plan_id && <label>关联行程 <small>选填</small><select value={tripId} onChange={event => setTripId(event.target.value)}><option value="">不关联行程</option>{trips.map(trip => <option key={trip.id} value={trip.id}>{trip.name}</option>)}</select></label>}
    <label>备注 <small>选填</small><textarea value={notes} onChange={event => setNotes(event.target.value)} rows={3} /></label>
    <div className="record-image-editor"><b>图片</b>{isDemo ? <small>演示模式暂不上传图片</small> : <><label className="secondary-button file-picker">{imagePath ? "更换图片" : "上传图片"}<input className="file-input-accessible" aria-label={imagePath ? "更换图片" : "上传图片"} type="file" accept="image/jpeg,image/png,image/webp,image/heic" disabled={saving} onChange={event => { void chooseImage(event.target.files?.[0]); event.target.value = ""; }} /></label>{imagePath && <button type="button" className="text-button" onClick={() => setImagePath(null)}>移除关联</button>}<small>单张最大 10 MB，需联网。图片会立即上传；取消、更换或移除关联不会删除私有存储中的原图。</small></>}</div>
    {error && <p className="field-error" role="alert">{error}</p>}
    <footer><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" disabled={saving || !content.trim()}>{saving ? "处理中…" : "保存"}</button></footer>
  </form></div>;
}
