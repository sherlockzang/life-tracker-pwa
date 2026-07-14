import { useMemo, useState, type FormEvent } from "react";
import { DndContext, PointerSensor, TouchSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronRight, CirclePlus, Clock3, GripVertical, MapPin, MoreHorizontal, Plus, Route, X } from "lucide-react";
import type { Currency, LifeRecord, RecordDraft, Trip, TripDraft } from "../types";
import { formatDateTime, formatMoney } from "../types";
import { QuickComposer } from "./QuickComposer";

interface Props {
  trips: Trip[];
  records: LifeRecord[];
  onSaveTrip: (draft: TripDraft) => Promise<Trip>;
  onSaveRecord: (draft: RecordDraft) => Promise<void>;
  onUpdateRecord: (record: LifeRecord) => Promise<void>;
  initialTripId?: string;
  baseCurrency: Currency;
}

function dateRange(start: string, end: string) {
  const result: string[] = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const endDate = new Date(`${end}T12:00:00Z`);
  while (cursor <= endDate) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function dateInZone(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function zonedDateTimeToIso(date: string, time: string, timeZone: string) {
  const tentative = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(tentative);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  const representedAsUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  const offset = representedAsUtc - tentative.getTime();
  return new Date(tentative.getTime() - offset).toISOString();
}

export function Planner({ trips, records, onSaveTrip, onSaveRecord, onUpdateRecord, initialTripId, baseCurrency }: Props) {
  const [selectedId, setSelectedId] = useState(initialTripId || "");
  const [showCreate, setShowCreate] = useState(false);
  const selected = trips.find((trip) => trip.id === selectedId);

  if (!selected) {
    return (
      <section className="planner-home">
        <div className="section-hero"><div><p className="eyebrow">行程规划</p><h1>先把期待，排进日历。</h1><p>按天安排地点与事项，出发后直接打卡，还能把实际消费和随记挂在计划下面。</p></div><button className="primary-button" onClick={() => setShowCreate(true)}><Plus size={17} />创建行程</button></div>
        {showCreate && <TripForm onClose={() => setShowCreate(false)} onSave={async (draft) => { const trip = await onSaveTrip(draft); setSelectedId(trip.id); setShowCreate(false); }} />}
        <div className="trip-grid">
          {trips.map((trip) => {
            const planCount = records.filter((record) => record.trip_id === trip.id && record.record_type === "trip").length;
            const completed = records.filter((record) => record.trip_id === trip.id && record.record_type === "trip" && record.plan_status === "completed").length;
            return <button className="trip-card glass-card" onClick={() => setSelectedId(trip.id)} key={trip.id}><span className="trip-card-icon"><Route /></span><div><p>{trip.destination}</p><h3>{trip.name}</h3><span><CalendarDays size={14} />{trip.start_date.replaceAll("-", ".")} — {trip.end_date.replaceAll("-", ".")}</span></div><div className="trip-progress"><b>{completed}/{planCount || 0}</b><small>已完成</small></div><ChevronRight /></button>;
          })}
          {!trips.length && <div className="empty-planner glass-card"><span><Route /></span><h3>还没有行程</h3><p>创建下一次出发，把机票、酒店和想去的地方提前放进来。</p><button className="secondary-button" onClick={() => setShowCreate(true)}>创建第一个行程</button></div>}
        </div>
      </section>
    );
  }

  return <TripBoard trip={selected} records={records} onBack={() => setSelectedId("")} onSaveRecord={onSaveRecord} onUpdateRecord={onUpdateRecord} baseCurrency={baseCurrency} />;
}

function TripForm({ onSave, onClose }: { onSave: (draft: TripDraft) => Promise<void>; onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [draft, setDraft] = useState<TripDraft>({ name: "", destination: "", start_date: today, end_date: today, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); await onSave(draft); setSaving(false);
  }
  return <div className="modal-backdrop"><form className="modal-card glass-card" onSubmit={submit}><header><div><p className="eyebrow">新行程</p><h2>下一站去哪里？</h2></div><button type="button" className="icon-button" onClick={onClose}><X /></button></header><label>行程名称<input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：悉尼夏日漫游" required /></label><label>目的地<input value={draft.destination} onChange={(event) => setDraft({ ...draft, destination: event.target.value })} placeholder="城市或国家" required /></label><div className="form-row"><label>开始日期<input type="date" value={draft.start_date} onChange={(event) => setDraft({ ...draft, start_date: event.target.value, end_date: event.target.value > draft.end_date ? event.target.value : draft.end_date })} required /></label><label>结束日期<input type="date" min={draft.start_date} value={draft.end_date} onChange={(event) => setDraft({ ...draft, end_date: event.target.value })} required /></label></div><label>行程时区<input value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} required /></label><footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? "创建中…" : "创建行程"}</button></footer></form></div>;
}

function TripBoard({ trip, records, onBack, onSaveRecord, onUpdateRecord, baseCurrency }: { trip: Trip; records: LifeRecord[]; onBack: () => void; onSaveRecord: Props["onSaveRecord"]; onUpdateRecord: Props["onUpdateRecord"]; baseCurrency: Currency }) {
  const [addingDay, setAddingDay] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }));
  const days = useMemo(() => dateRange(trip.start_date, trip.end_date), [trip]);
  const plans = records.filter((record) => record.trip_id === trip.id && record.record_type === "trip" && !record.parent_plan_id);

  async function handleDragEnd(event: DragEndEvent) {
    const active = plans.find((item) => item.id === event.active.id);
    if (!active || !event.over) return;
    const overId = String(event.over.id);
    const overPlan = plans.find((item) => item.id === overId);
    const targetDate = overId.startsWith("day:") ? overId.slice(4) : overPlan ? dateInZone(overPlan.event_at, trip.timezone) : null;
    if (!targetDate) return;
    const targetItems = plans.filter((item) => dateInZone(item.event_at, trip.timezone) === targetDate).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const targetIndex = overPlan ? Math.max(0, targetItems.findIndex((item) => item.id === overPlan.id)) : targetItems.length;
    const currentTime = new Intl.DateTimeFormat("en-GB", { timeZone: trip.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(active.event_at));
    await onUpdateRecord({ ...active, event_at: zonedDateTimeToIso(targetDate, currentTime, trip.timezone), sort_order: (targetIndex + 1) * 1000, updated_at: new Date().toISOString() });
  }

  return (
    <section className="trip-board">
      <header className="trip-board-header"><button className="back-button" onClick={onBack}><ArrowLeft size={18} />全部行程</button><div><p>{trip.destination}</p><h1>{trip.name}</h1><span><CalendarDays size={15} />{trip.start_date} — {trip.end_date}<i>·</i>{days.length} 天</span></div><div className="trip-completion"><b>{plans.filter((item) => item.plan_status === "completed").length}/{plans.length}</b><span>计划已完成</span></div></header>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="day-board">
          {days.map((day, index) => {
            const items = plans.filter((item) => dateInZone(item.event_at, trip.timezone) === day).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
            return <DayColumn key={day} day={day} dayNumber={index + 1} items={items} records={records} expanded={expanded} onExpand={setExpanded} onAdd={() => setAddingDay(day)} onSaveRecord={onSaveRecord} onUpdateRecord={onUpdateRecord} trip={trip} adding={addingDay === day} onCloseAdd={() => setAddingDay(null)} baseCurrency={baseCurrency} />;
          })}
        </div>
      </DndContext>
    </section>
  );
}

function DayColumn({ day, dayNumber, items, records, expanded, onExpand, onAdd, onSaveRecord, onUpdateRecord, trip, adding, onCloseAdd, baseCurrency }: { day: string; dayNumber: number; items: LifeRecord[]; records: LifeRecord[]; expanded: string | null; onExpand: (id: string | null) => void; onAdd: () => void; onSaveRecord: Props["onSaveRecord"]; onUpdateRecord: Props["onUpdateRecord"]; trip: Trip; adding: boolean; onCloseAdd: () => void; baseCurrency: Currency }) {
  const droppable = useDroppable({ id: `day:${day}` });
  return <section ref={droppable.setNodeRef} className={`day-column ${droppable.isOver ? "drag-over" : ""}`}><header><div><strong>Day {dayNumber}</strong><span>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date(`${day}T12:00:00`))}</span></div><button className="icon-button" onClick={onAdd}><Plus size={18} /></button></header>{adding && <PlanForm day={day} trip={trip} count={items.length} onClose={onCloseAdd} onSave={onSaveRecord} />}<SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}><div className="plan-list">{items.map((item) => <SortablePlan key={item.id} item={item} actualRecords={records.filter((record) => record.parent_plan_id === item.id)} expanded={expanded === item.id} onExpand={() => onExpand(expanded === item.id ? null : item.id)} onUpdate={onUpdateRecord} onSaveRecord={onSaveRecord} trip={trip} baseCurrency={baseCurrency} />)}{!items.length && !adding && <button className="empty-day" onClick={onAdd}><CirclePlus size={20} /><span>这一天还没有安排</span><small>点这里添加，或把其他计划拖过来</small></button>}</div></SortableContext></section>;
}

function PlanForm({ day, trip, count, onSave, onClose }: { day: string; trip: Trip; count: number; onSave: Props["onSaveRecord"]; onClose: () => void }) {
  const [content, setContent] = useState(""); const [location, setLocation] = useState(""); const [notes, setNotes] = useState(""); const [time, setTime] = useState("09:00");
  async function submit(event: FormEvent) { event.preventDefault(); await onSave({ record_type: "trip", content, location, notes, event_at: zonedDateTimeToIso(day, time, trip.timezone), trip_id: trip.id, plan_status: "planned", sort_order: (count + 1) * 1000 }); onClose(); }
  return <form className="plan-form" onSubmit={submit}><input autoFocus value={content} onChange={(event) => setContent(event.target.value)} placeholder="地点或事项名称" required /><div><label><Clock3 size={14} /><input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label><label><MapPin size={14} /><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="地点" /></label></div><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="航班、酒店或预订信息" /><footer><button type="button" onClick={onClose}>取消</button><button>添加计划</button></footer></form>;
}

function SortablePlan({ item, actualRecords, expanded, onExpand, onUpdate, onSaveRecord, trip, baseCurrency }: { item: LifeRecord; actualRecords: LifeRecord[]; expanded: boolean; onExpand: () => void; onUpdate: Props["onUpdateRecord"]; onSaveRecord: Props["onSaveRecord"]; trip: Trip; baseCurrency: Currency }) {
  const sortable = useSortable({ id: item.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const [addingActual, setAddingActual] = useState(false);
  return <article ref={sortable.setNodeRef} style={style} className={`plan-item glass-card ${sortable.isDragging ? "dragging" : ""} ${item.plan_status}`}><div className="plan-summary"><button className="drag-handle" {...sortable.attributes} {...sortable.listeners}><GripVertical size={18} /></button><button className="plan-check" onClick={() => onUpdate({ ...item, plan_status: item.plan_status === "completed" ? "planned" : "completed", updated_at: new Date().toISOString() })}>{item.plan_status === "completed" && <Check size={16} />}</button><div className="plan-time">{new Intl.DateTimeFormat("zh-CN", { timeZone: trip.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(item.event_at))}</div><button className="plan-content" onClick={onExpand}><strong>{item.content}</strong><span>{item.location && <><MapPin size={13} />{item.location}</>}{item.notes && <em>{item.notes}</em>}</span></button><button className="icon-button" onClick={onExpand}>{expanded ? <ChevronDown /> : <ChevronRight />}</button></div>{expanded && <div className="plan-expanded"><div className="actual-heading"><span>实际发生</span><small>{actualRecords.length} 条记录</small></div>{actualRecords.map((record) => <div className={`actual-row ${record.record_type}`} key={record.id}><span>{record.record_type === "expense" ? "消费" : "随记"}</span><div><b>{record.content}</b><small>{formatDateTime(record.event_at)}</small></div>{record.amount != null && record.currency && <strong>{formatMoney(record.amount, record.currency)}</strong>}</div>)}{addingActual ? <QuickComposer compact trips={[]} defaultCurrency={baseCurrency} forcedTripId={trip.id} parentPlanId={item.id} onSave={onSaveRecord} onClose={() => setAddingActual(false)} /> : <button className="add-actual" onClick={() => setAddingActual(true)}><Plus size={15} />添加消费或随记</button>}<div className="plan-status-actions"><button className={item.plan_status === "planned" ? "active" : ""} onClick={() => onUpdate({ ...item, plan_status: "planned", updated_at: new Date().toISOString() })}><Clock3 size={14} />计划中</button><button className={item.plan_status === "completed" ? "active" : ""} onClick={() => onUpdate({ ...item, plan_status: "completed", updated_at: new Date().toISOString() })}><Check size={14} />已完成</button><button className={item.plan_status === "cancelled" ? "active" : ""} onClick={() => onUpdate({ ...item, plan_status: "cancelled", updated_at: new Date().toISOString() })}><X size={14} />已取消</button><button><MoreHorizontal size={15} /></button></div></div>}</article>;
}
