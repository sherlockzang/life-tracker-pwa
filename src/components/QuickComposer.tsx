import { useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarDays, ChevronDown, Coffee, MapPin, NotebookPen, Plus, ReceiptText, Route, Send, ShoppingBag, Sparkles, Ticket, TrainFront, X } from "lucide-react";
import type { Currency, ExpenseCategory, RecordDraft, RecordType, Trip } from "../types";
import { CATEGORY_META, CURRENCIES, nowLocalInput, toIso } from "../types";

interface Props {
  trips: Trip[];
  defaultCurrency: Currency;
  forcedTripId?: string;
  parentPlanId?: string;
  defaultType?: RecordType;
  initialContent?: string;
  initialNotes?: string;
  compact?: boolean;
  onSave: (draft: RecordDraft) => Promise<void>;
  onClose?: () => void;
}

const typeMeta: { type: RecordType; label: string; icon: typeof ReceiptText }[] = [
  { type: "expense", label: "消费", icon: ReceiptText },
  { type: "trip", label: "行程", icon: Route },
  { type: "note", label: "随记", icon: NotebookPen }
];

const categoryIcons: Record<ExpenseCategory, typeof Coffee> = {
  food: Coffee,
  transport: TrainFront,
  shopping: ShoppingBag,
  stay: CalendarDays,
  entertainment: Ticket,
  other: Sparkles
};

export function QuickComposer({ trips, defaultCurrency, forcedTripId, parentPlanId, defaultType, initialContent, initialNotes, compact, onSave, onClose }: Props) {
  const [open, setOpen] = useState(Boolean(compact));
  const [type, setType] = useState<RecordType>(defaultType || (parentPlanId ? "expense" : "note"));
  const [content, setContent] = useState(initialContent || "");
  const [notes, setNotes] = useState(initialNotes || "");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [category, setCategory] = useState<ExpenseCategory>("food");
  const [location, setLocation] = useState("");
  const [eventAt, setEventAt] = useState(nowLocalInput());
  const [tripId, setTripId] = useState(forcedTripId || "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCurrency(defaultCurrency);
  }, [defaultCurrency]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 80);
  }, [open]);

  const reset = () => {
    setContent(""); setNotes(""); setAmount(""); setLocation(""); setEventAt(nowLocalInput());
    if (!forcedTripId) setTripId("");
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim() || (type === "expense" && !amount)) return;
    setSaving(true);
    await onSave({
      record_type: type,
      content,
      notes,
      amount: type === "expense" ? Number(amount) : undefined,
      currency: type === "expense" ? currency : undefined,
      expense_category: type === "expense" ? category : undefined,
      location: type !== "note" ? location : undefined,
      event_at: toIso(eventAt),
      trip_id: forcedTripId || tripId || undefined,
      plan_status: type === "trip" && (forcedTripId || tripId) ? "planned" : undefined,
      parent_plan_id: parentPlanId
    });
    setSaving(false);
    reset();
    if (compact) onClose?.();
  }

  if (!open && !compact) {
    return (
      <button className="quick-collapsed glass-card" onClick={() => setOpen(true)}>
        <span className="quick-plus"><Plus size={22} /></span>
        <span><b>现在，想记下什么？</b><small>消费、行程或一个念头</small></span>
        <span className="quick-types"><ReceiptText /><Route /><NotebookPen /></span>
      </button>
    );
  }

  return (
    <form className={`composer glass-card ${compact ? "composer-compact" : ""}`} onSubmit={submit}>
      <div className="composer-top">
        <div className="type-switch" role="tablist" aria-label="记录类型">
          {typeMeta.filter((item) => !(parentPlanId && item.type === "trip")).map((item) => {
            const Icon = item.icon;
            return <button type="button" role="tab" aria-selected={type === item.type} className={type === item.type ? `active ${item.type}` : ""} onClick={() => setType(item.type)} key={item.type}><Icon size={17} />{item.label}</button>;
          })}
        </div>
        <button type="button" className="icon-button" aria-label="收起快速输入" onClick={() => { setOpen(false); onClose?.(); }}><X size={19} /></button>
      </div>

      <input ref={inputRef} className="composer-main-input" value={content} onChange={(event) => setContent(event.target.value)} placeholder={type === "expense" ? "买了什么？" : type === "trip" ? "要去哪里或做什么？" : "此刻发生了什么？"} />

      {type === "expense" && (
        <div className="expense-fields">
          <div className="amount-box"><span>{CURRENCIES.find((item) => item.code === currency)?.symbol}</span><input type="number" min="0" step="any" inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} /><label>金额</label></div>
          <label className="select-field"><span>币种</span><select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}>{CURRENCIES.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.label}</option>)}</select><ChevronDown size={16} /></label>
          <div className="category-picker">
            {Object.entries(CATEGORY_META).map(([key, meta]) => {
              const Icon = categoryIcons[key as ExpenseCategory];
              return <button type="button" className={category === key ? "active" : ""} onClick={() => setCategory(key as ExpenseCategory)} key={key}><Icon size={17} /><span>{meta.label}</span></button>;
            })}
          </div>
        </div>
      )}

      <div className="composer-grid">
        {type !== "note" && <label className="soft-field"><MapPin size={16} /><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="地点（选填）" /></label>}
        <label className="soft-field"><CalendarDays size={16} /><input type="datetime-local" value={eventAt} onChange={(event) => setEventAt(event.target.value)} /></label>
        {!forcedTripId && trips.length > 0 && <label className="soft-field"><Route size={16} /><select value={tripId} onChange={(event) => setTripId(event.target.value)}><option value="">不关联行程</option>{trips.map((trip) => <option value={trip.id} key={trip.id}>{trip.name}</option>)}</select></label>}
      </div>
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="补充备注（选填）" rows={2} />
      <div className="composer-actions">
        <span>{navigator.onLine ? "将保存到你的私人空间" : "当前离线，将在联网后同步"}</span>
        <button className="primary-button" disabled={saving || !content.trim() || (type === "expense" && !amount)}>{saving ? "保存中…" : "记下来"}<Send size={16} /></button>
      </div>
    </form>
  );
}
