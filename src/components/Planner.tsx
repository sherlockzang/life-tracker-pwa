import { useMemo, useState, type FormEvent } from "react";
import { DndContext, PointerSensor, TouchSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronRight, CirclePlus, Clock3, GripVertical, LoaderCircle, Pencil, Plus, Route, Sparkles, X } from "lucide-react";
import type { Currency, FlightDetails, LifeRecord, MetroDetails, RailDetails, RecordDraft, Trip, TripDraft } from "../types";
import { formatDateTime, formatMoney } from "../types";
import { dateInZone, zonedDateTimeToIso } from "../lib/tripDates";
import { getTransportPresentation } from "../lib/transport";
import { detectTimeZone, TIMEZONE_OPTIONS, timeZoneLabel } from "../lib/timezones";
import { QuickComposer } from "./QuickComposer";
import { TransportDetailsPanel, TransportPlanEditor } from "./TransportPlanEditor";
import { generateTripRecap } from "../lib/ai";

interface Props {
  trips: Trip[];
  records: LifeRecord[];
  onSaveTrip: (draft: TripDraft) => Promise<Trip>;
  onUpdateTrip: (trip: Trip) => Promise<void>;
  onSaveRecord: (draft: RecordDraft) => Promise<void>;
  onUpdateRecord: (record: LifeRecord) => Promise<void>;
  initialTripId?: string;
  baseCurrency: Currency;
  isDemo?: boolean;
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

function planDate(record: LifeRecord, trip: Trip) {
  if (record.transport_type === "flight" && record.transport_details) return (record.transport_details as FlightDetails).departure.date;
  if (record.transport_type === "rail" && record.transport_details) return (record.transport_details as RailDetails).departure.date;
  return dateInZone(record.event_at, trip.timezone);
}

function shiftDate(date: string, offsetDays: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function chronological(left: LifeRecord, right: LifeRecord) {
  return left.event_at.localeCompare(right.event_at) || (left.sort_order || 0) - (right.sort_order || 0) || left.created_at.localeCompare(right.created_at);
}

function orderedTrips(trips: Trip[]) {
  const today = new Date().toISOString().slice(0, 10);
  return [...trips].sort((left, right) => {
    const leftGroup = left.start_date <= today && left.end_date >= today ? 0 : left.start_date > today ? 1 : 2;
    const rightGroup = right.start_date <= today && right.end_date >= today ? 0 : right.start_date > today ? 1 : 2;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    return leftGroup === 2 ? right.end_date.localeCompare(left.end_date) : left.start_date.localeCompare(right.start_date);
  });
}

export function Planner({ trips, records, onSaveTrip, onUpdateTrip, onSaveRecord, onUpdateRecord, initialTripId, baseCurrency, isDemo = false }: Props) {
  const [selectedId, setSelectedId] = useState(initialTripId || "");
  const [showCreate, setShowCreate] = useState(false);
  const selected = trips.find((trip) => trip.id === selectedId);

  if (!selected) {
    return (
      <section className="planner-home">
        <div className="section-hero"><div><p className="eyebrow">行程规划</p><h1>先把期待，排进日历。</h1><p>按天安排地点与事项，出发后直接打卡，还能把实际消费和随记挂在计划下面。</p></div><button className="primary-button" onClick={() => setShowCreate(true)}><Plus size={17} />创建行程</button></div>
        {showCreate && <TripForm onClose={() => setShowCreate(false)} onSave={async (draft) => { const trip = await onSaveTrip(draft); setSelectedId(trip.id); setShowCreate(false); }} />}
        <div className="trip-grid">
          {orderedTrips(trips).map((trip) => {
            const planCount = records.filter((record) => record.trip_id === trip.id && record.record_type === "trip").length;
            const completed = records.filter((record) => record.trip_id === trip.id && record.record_type === "trip" && record.plan_status === "completed").length;
            return <button className="trip-card glass-card" onClick={() => setSelectedId(trip.id)} key={trip.id}><span className="trip-card-icon"><Route /></span><div><p>{trip.destination}</p><h3>{trip.name}</h3><span><CalendarDays size={14} />{trip.start_date.replaceAll("-", ".")} — {trip.end_date.replaceAll("-", ".")}</span></div><div className="trip-progress"><b>{completed}/{planCount || 0}</b><small>已完成</small></div><ChevronRight /></button>;
          })}
          {!trips.length && <div className="empty-planner glass-card"><span><Route /></span><h3>还没有行程</h3><p>创建下一次出发，把机票、酒店和想去的地方提前放进来。</p><button className="secondary-button" onClick={() => setShowCreate(true)}>创建第一个行程</button></div>}
        </div>
      </section>
    );
  }

  return <TripBoard trip={selected} records={records} onBack={() => setSelectedId("")} onUpdateTrip={onUpdateTrip} onSaveRecord={onSaveRecord} onUpdateRecord={onUpdateRecord} baseCurrency={baseCurrency} isDemo={isDemo} />;
}

function TripForm({ trip, records = [], onSave, onClose }: { trip?: Trip; records?: LifeRecord[]; onSave: (draft: TripDraft) => Promise<void>; onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [draft, setDraft] = useState<TripDraft>(trip ? { name: trip.name, destination: trip.destination, start_date: trip.start_date, end_date: trip.end_date, timezone: trip.timezone } : { name: "", destination: "", start_date: today, end_date: today, timezone: deviceTimeZone });
  const [timezoneMode, setTimezoneMode] = useState<"device" | "detected" | "manual">(trip ? "manual" : "device");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const outside = records.filter((record) => { const date = trip ? planDate(record, trip) : record.event_at.slice(0, 10); return date < draft.start_date || date > draft.end_date; });
    if (outside.length && !window.confirm(`修改后有 ${outside.length} 条计划超出新的行程日期范围。这些计划不会被删除，但会暂时显示在日期范围之外。仍要保存吗？`)) return;
    setSaving(true); await onSave(draft); setSaving(false);
  }
  function updateDestination(destination: string) {
    const detected = detectTimeZone(destination);
    setDraft((current) => ({ ...current, destination, timezone: timezoneMode !== "manual" && detected ? detected : current.timezone }));
    if (timezoneMode !== "manual") setTimezoneMode(detected ? "detected" : "device");
  }
  return <div className="modal-backdrop"><form className="modal-card glass-card trip-form" onSubmit={submit}><header><div><p className="eyebrow">{trip ? "编辑行程" : "新行程"}</p><h2>{trip ? "调整这段旅程" : "下一站去哪里？"}</h2></div><button type="button" className="icon-button" aria-label="关闭行程编辑" onClick={onClose}><X /></button></header><label>行程名称<input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：悉尼夏日漫游" required /></label><label>目的地<input value={draft.destination} onChange={(event) => updateDestination(event.target.value)} placeholder="城市或国家" required /></label><div className="form-row"><label>开始日期<input type="date" value={draft.start_date} onChange={(event) => setDraft({ ...draft, start_date: event.target.value, end_date: event.target.value > draft.end_date ? event.target.value : draft.end_date })} required /></label><label>结束日期<input type="date" min={draft.start_date} value={draft.end_date} onChange={(event) => setDraft({ ...draft, end_date: event.target.value })} required /></label></div><label>行程时区<select value={draft.timezone} onChange={(event) => { setDraft({ ...draft, timezone: event.target.value }); setTimezoneMode("manual"); }} required>{TIMEZONE_OPTIONS.map((timezone) => <option value={timezone} key={timezone}>{timeZoneLabel(timezone)}</option>)}</select><span className="field-help">{timezoneMode === "detected" ? "已根据目的地自动匹配，可手动调整" : timezoneMode === "manual" ? "已选择标准 IANA 时区" : "输入目的地后自动匹配；当前暂用设备时区"}</span></label><footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? "保存中…" : trip ? "保存行程" : "创建行程"}</button></footer></form></div>;
}

function TripBoard({ trip, records, onBack, onUpdateTrip, onSaveRecord, onUpdateRecord, baseCurrency, isDemo }: { trip: Trip; records: LifeRecord[]; onBack: () => void; onUpdateTrip: Props["onUpdateTrip"]; onSaveRecord: Props["onSaveRecord"]; onUpdateRecord: Props["onUpdateRecord"]; baseCurrency: Currency; isDemo: boolean }) {
  const [addingDay, setAddingDay] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingTrip, setEditingTrip] = useState(false);
  const [recap, setRecap] = useState("");
  const [recapLoading, setRecapLoading] = useState(false);
  const [recapError, setRecapError] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }));
  const days = useMemo(() => dateRange(trip.start_date, trip.end_date), [trip]);
  const plans = records.filter((record) => record.trip_id === trip.id && record.record_type === "trip" && !record.parent_plan_id);
  const outsidePlans = plans.filter((record) => { const date = planDate(record, trip); return date < trip.start_date || date > trip.end_date; }).sort(chronological);

  async function handleDragEnd(event: DragEndEvent) {
    const active = plans.find((item) => item.id === event.active.id);
    if (!active || !event.over) return;
    const overId = String(event.over.id);
    const overPlan = plans.find((item) => item.id === overId);
    const targetDate = overId.startsWith("day:") ? overId.slice(4) : overPlan ? planDate(overPlan, trip) : null;
    if (!targetDate) return;
    const targetItems = plans.filter((item) => planDate(item, trip) === targetDate).sort(chronological);
    const targetIndex = overPlan ? Math.max(0, targetItems.findIndex((item) => item.id === overPlan.id)) : targetItems.length;
    const activeFlight = active.transport_type === "flight" && active.transport_details ? active.transport_details as FlightDetails : null;
    const sourceDate = planDate(active, trip);
    const offsetDays = Math.round((new Date(`${targetDate}T12:00:00Z`).getTime() - new Date(`${sourceDate}T12:00:00Z`).getTime()) / 86_400_000);
    const currentTime = activeFlight?.departure.time || new Intl.DateTimeFormat("en-GB", { timeZone: trip.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(active.event_at));
    const eventTimeZone = activeFlight?.departure.timezone || trip.timezone;
    const movedDetails = active.transport_type === "flight" && active.transport_details
      ? { ...(active.transport_details as FlightDetails), departure: { ...(active.transport_details as FlightDetails).departure, date: targetDate }, arrival: { ...(active.transport_details as FlightDetails).arrival, date: shiftDate((active.transport_details as FlightDetails).arrival.date, offsetDays) } }
      : active.transport_type === "rail" && active.transport_details
        ? { ...(active.transport_details as RailDetails), departure: { ...(active.transport_details as RailDetails).departure, date: targetDate }, arrival: { ...(active.transport_details as RailDetails).arrival, date: shiftDate((active.transport_details as RailDetails).arrival.date, offsetDays) } }
        : active.transport_details;
    await onUpdateRecord({ ...active, event_at: zonedDateTimeToIso(targetDate, currentTime, eventTimeZone), transport_details: movedDetails, sort_order: (targetIndex + 1) * 1000, updated_at: new Date().toISOString() });
  }

  async function loadRecap(regenerate = false) {
    if (regenerate && !window.confirm("重新生成会再次使用一次旅行回顾额度，是否继续？")) return;
    setRecapLoading(true); setRecapError("");
    try { const result = await generateTripRecap(trip.id, regenerate, isDemo); setRecap(result.result); }
    catch (error) { setRecapError(error instanceof Error ? error.message : "暂时无法生成旅行回顾"); }
    finally { setRecapLoading(false); }
  }

  return (
    <section className="trip-board">
      <header className="trip-board-header"><button className="back-button" onClick={onBack}><ArrowLeft size={18} />全部行程</button><div><p>{trip.destination}</p><h1>{trip.name}</h1><span><CalendarDays size={15} />{trip.start_date} — {trip.end_date}<i>·</i>{days.length} 天</span><button className="trip-edit-link" onClick={() => setEditingTrip(true)}><Pencil size={13} />编辑行程</button></div><div className="trip-completion"><b>{plans.filter((item) => item.plan_status === "completed").length}/{plans.length}</b><span>计划已完成</span></div></header>
      {(trip.end_date < new Date().toISOString().slice(0, 10) || (plans.length > 0 && plans.every((plan) => plan.plan_status === "completed")) || isDemo) && <section className="trip-recap-card glass-card"><div><Sparkles size={18} /><span><b>本次旅行回顾</b><small>结合消费统计和少量随记生成，结果会缓存保存</small></span></div>{recap ? <><p>{recap}</p><button className="text-button" onClick={() => void loadRecap(true)}>重新生成</button></> : <button className="secondary-button" disabled={recapLoading} onClick={() => void loadRecap(false)}>{recapLoading ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{recapLoading ? "正在整理…" : "生成本次旅行回顾"}</button>}{recapError && <p className="field-error">{recapError}</p>}</section>}
      {outsidePlans.length > 0 && <section className="trip-range-warning"><b>{outsidePlans.length} 条计划在当前行程日期范围之外</b><p>这些计划仍然保留，没有被删除。编辑行程日期或逐条调整时间后，它们会重新回到对应日期。</p><ul>{outsidePlans.map((plan) => <li key={plan.id}>{planDate(plan, trip)} · {getTransportPresentation(plan).title}</li>)}</ul></section>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="day-board">
          {days.map((day, index) => {
            const items = plans.filter((item) => planDate(item, trip) === day).sort(chronological);
            return <DayColumn key={day} day={day} dayNumber={index + 1} items={items} records={records} expanded={expanded} onExpand={setExpanded} onAdd={() => setAddingDay(day)} onSaveRecord={onSaveRecord} onUpdateRecord={onUpdateRecord} trip={trip} adding={addingDay === day} onCloseAdd={() => setAddingDay(null)} baseCurrency={baseCurrency} isDemo={isDemo} />;
          })}
        </div>
      </DndContext>
      {editingTrip && <TripForm trip={trip} records={plans} onClose={() => setEditingTrip(false)} onSave={async (draft) => { await onUpdateTrip({ ...trip, ...draft, updated_at: new Date().toISOString() }); setEditingTrip(false); }} />}
    </section>
  );
}

function DayColumn({ day, dayNumber, items, records, expanded, onExpand, onAdd, onSaveRecord, onUpdateRecord, trip, adding, onCloseAdd, baseCurrency, isDemo }: { day: string; dayNumber: number; items: LifeRecord[]; records: LifeRecord[]; expanded: string | null; onExpand: (id: string | null) => void; onAdd: () => void; onSaveRecord: Props["onSaveRecord"]; onUpdateRecord: Props["onUpdateRecord"]; trip: Trip; adding: boolean; onCloseAdd: () => void; baseCurrency: Currency; isDemo: boolean }) {
  const droppable = useDroppable({ id: `day:${day}` });
  return <section ref={droppable.setNodeRef} className={`day-column ${droppable.isOver ? "drag-over" : ""}`}><header><div><strong>Day {dayNumber}</strong><span>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date(`${day}T12:00:00`))}</span></div><button className="icon-button" aria-label={`为 Day ${dayNumber} 添加计划`} onClick={onAdd}><Plus size={18} /></button></header>{adding && <TransportPlanEditor day={day} trip={trip} count={items.length} isDemo={isDemo} onClose={onCloseAdd} onSave={onSaveRecord} />}<SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}><div className="plan-list">{items.map((item) => <SortablePlan key={item.id} item={item} actualRecords={records.filter((record) => record.parent_plan_id === item.id)} expanded={expanded === item.id} onExpand={() => onExpand(expanded === item.id ? null : item.id)} onUpdate={onUpdateRecord} onSaveRecord={onSaveRecord} trip={trip} baseCurrency={baseCurrency} isDemo={isDemo} />)}{!items.length && !adding && <button className="empty-day" onClick={onAdd}><CirclePlus size={20} /><span>这一天还没有安排</span><small>点这里添加，或把其他计划拖过来</small></button>}</div></SortableContext></section>;
}

function SortablePlan({ item, actualRecords, expanded, onExpand, onUpdate, onSaveRecord, trip, baseCurrency, isDemo }: { item: LifeRecord; actualRecords: LifeRecord[]; expanded: boolean; onExpand: () => void; onUpdate: Props["onUpdateRecord"]; onSaveRecord: Props["onSaveRecord"]; trip: Trip; baseCurrency: Currency; isDemo: boolean }) {
  const sortable = useSortable({ id: item.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const [actualMode, setActualMode] = useState<"standard" | "route" | null>(null);
  const [editing, setEditing] = useState(false);
  const presentation = getTransportPresentation(item);
  const planSubtitle = item.transport_type ? presentation.subtitle : [item.location, item.notes].filter(Boolean).join(" · ");
  const suggestedRoute = item.transport_type === "metro" ? (item.transport_details as MetroDetails | null)?.route_description || "" : "";
  const displayTime = item.transport_type === "flight" && item.transport_details
    ? (item.transport_details as FlightDetails).departure.time
    : new Intl.DateTimeFormat("zh-CN", { timeZone: trip.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(item.event_at));
  return <>
    <article ref={sortable.setNodeRef} style={style} className={`plan-item glass-card ${sortable.isDragging ? "dragging" : ""} ${item.plan_status}`}>
      <div className="plan-summary"><button className="drag-handle" aria-label="拖动计划排序" {...sortable.attributes} {...sortable.listeners}><GripVertical size={18} /></button><button className="plan-check" aria-label={item.plan_status === "completed" ? "标记为计划中" : "标记完成"} onClick={() => void onUpdate({ ...item, plan_status: item.plan_status === "completed" ? "planned" : "completed", updated_at: new Date().toISOString() })}>{item.plan_status === "completed" && <Check size={16} />}</button><div className="plan-time">{displayTime}</div><button className="plan-content" onClick={onExpand}><strong>{presentation.title}</strong>{planSubtitle && <span><em>{planSubtitle}</em></span>}</button><button className="icon-button" aria-label={expanded ? "收起计划详情" : "展开计划详情"} onClick={onExpand}>{expanded ? <ChevronDown /> : <ChevronRight />}</button></div>
      {expanded && <div className="plan-expanded">
        <TransportDetailsPanel record={item} isDemo={isDemo} onUpdate={onUpdate} onEdit={() => setEditing(true)} />
        <div className="actual-heading"><span>实际发生</span><small>{actualRecords.length} 条记录</small></div>
        {actualRecords.map((record) => <div className={`actual-row ${record.record_type}`} key={record.id}><span>{record.record_type === "expense" ? "消费" : "随记"}</span><div><b>{record.content}</b><small>{formatDateTime(record.event_at)}</small></div>{record.amount != null && record.currency && <strong>{formatMoney(record.amount, record.currency)}</strong>}</div>)}
        {actualMode ? <QuickComposer compact isDemo={isDemo} trips={[]} defaultCurrency={baseCurrency} forcedTripId={trip.id} parentPlanId={item.id} defaultType={actualMode === "route" ? "note" : undefined} initialContent={actualMode === "route" ? "实际路线" : undefined} initialNotes={actualMode === "route" ? suggestedRoute : undefined} onSave={onSaveRecord} onClose={() => setActualMode(null)} /> : <div className="actual-actions"><button className="add-actual" onClick={() => setActualMode("standard")}><Plus size={15} />添加消费或随记</button>{item.transport_type === "metro" && <button className="add-actual route-actual" onClick={() => setActualMode("route")}><Route size={15} />补记实际路线</button>}</div>}
        <div className="plan-status-actions"><button className={item.plan_status === "planned" ? "active" : ""} onClick={() => void onUpdate({ ...item, plan_status: "planned", updated_at: new Date().toISOString() })}><Clock3 size={14} />计划中</button><button className={item.plan_status === "completed" ? "active" : ""} onClick={() => void onUpdate({ ...item, plan_status: "completed", updated_at: new Date().toISOString() })}><Check size={14} />已完成</button><button className={item.plan_status === "cancelled" ? "active" : ""} onClick={() => void onUpdate({ ...item, plan_status: "cancelled", updated_at: new Date().toISOString() })}><X size={14} />已取消</button></div>
      </div>}
    </article>
    {editing && <TransportPlanEditor modal day={planDate(item, trip)} trip={trip} count={0} record={item} isDemo={isDemo} onSave={onSaveRecord} onUpdate={onUpdate} onClose={() => setEditing(false)} />}
  </>;
}
