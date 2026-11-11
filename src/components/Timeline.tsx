import { useState } from "react";
import { CalendarClock, Check, CircleDollarSign, Clock3, MapPin, NotebookPen, Pencil, ReceiptText, RotateCcw, Route, Sparkles, X } from "lucide-react";
import type { Currency, LifeRecord, RecordDraft, RecordType, Trip } from "../types";
import { CATEGORY_META, formatDateTime, formatMoney } from "../types";
import { getTransportPresentation } from "../lib/transport";
import { calculateFlightDuration } from "../lib/flightDuration";
import { EmptyState } from "./ui";
import { TransportPlanEditor } from "./TransportPlanEditor";
import { flightDisplay } from "../lib/flightDisplay";
import { normalizeScheduleDetails } from "../lib/schedules";
import { groupTimeline, timelineDate } from "../lib/calendar";

interface Props {
  records: LifeRecord[];
  trips: Trip[];
  filter: "all" | RecordType;
  baseCurrency: Currency;
  onStatus: (record: LifeRecord, status: "planned" | "completed" | "cancelled") => void;
  onSaveRecord: (draft: RecordDraft) => Promise<void>;
  onUpdateRecord: (record: LifeRecord, serverConfirmed?: boolean) => Promise<void>;
  isDemo?: boolean;
}

const icons = { expense: ReceiptText, trip: Route, note: NotebookPen };
const labels = { expense: "消费", trip: "行程", note: "随记" };

export function Timeline({ records, trips, filter, onStatus, onSaveRecord, onUpdateRecord, isDemo = false }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingRecord = records.find((record) => record.id === editingId);
  const editingTrip = trips.find((trip) => trip.id === editingRecord?.trip_id);
  const visible = records.filter((record) => !record.parent_plan_id && (filter === "all" || record.record_type === filter)).sort((a, b) => b.event_at.localeCompare(a.event_at));
  const grouped = groupTimeline(visible);

  if (!visible.length) {
    return <EmptyState className="empty-timeline" icon={Sparkles} title="这里还很安静" description="从上方快速记下第一条，生活的时间线就会从这里开始。" />;
  }

  return (
    <section className="timeline">
      {grouped.map(([date, items]) => (
        <div className="timeline-day" key={date}>
          <div className="day-label"><span>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(`${date}T12:00:00`))}</span><small>{new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(new Date(`${date}T12:00:00`))}</small></div>
          <div className="day-records">
            {items.map((record) => <RecordCard key={record.id} record={record} trip={trips.find((trip) => trip.id === record.trip_id)} onStatus={onStatus} onEdit={() => setEditingId(record.id)} />)}
          </div>
        </div>
      ))}
      {editingRecord && editingTrip && <TransportPlanEditor key={editingRecord.id} modal day={timelineDate(editingRecord, editingTrip.timezone)} trip={editingTrip} count={0} record={editingRecord} isDemo={isDemo} onSave={onSaveRecord} onUpdate={onUpdateRecord} onClose={() => setEditingId(null)} />}
    </section>
  );
}

function RecordCard({ record, trip, onStatus, onEdit }: { record: LifeRecord; trip?: Trip; onStatus: Props["onStatus"]; onEdit: () => void }) {
  const Icon = icons[record.record_type];
  const presentation = getTransportPresentation(record);
  const flightView = flightDisplay(record);
  const flight = flightView?.details;
  const schedule = normalizeScheduleDetails(record.schedule_details);
  const duration = flight ? calculateFlightDuration(flight.departure, flight.arrival) : null;
  const displayTime = record.transport_type === "flight" && record.transport_details
    ? flight!.departure.time
    : schedule ? "全天" : formatDateTime(record.event_at).split(" ").slice(-1);
  return (
    <article className={`record-card glass-card record-${record.record_type}`}>
      <span className="record-icon"><Icon size={20} /></span>
      <div className="record-main">
        <div className="record-meta"><span>{record.transport_type || schedule ? presentation.label : labels[record.record_type]}</span><i>·</i><time>{displayTime}</time>{trip && <em>{trip.name}</em>}</div>
        <h3>{presentation.title}</h3>
        {presentation.subtitle && <p>{presentation.subtitle}</p>}
        <div className="record-details">
          {duration?.status === "ready" && <span><Clock3 size={14} />{flightView!.durationLabel} {duration.label}</span>}
          {flightView?.matched && <span className="status completed"><Check size={14} />优先展示匹配信息</span>}
          {record.location && !record.transport_type && <span><MapPin size={14} />{record.location}</span>}
          {record.record_type === "expense" && record.expense_category && <span><CircleDollarSign size={14} />{CATEGORY_META[record.expense_category].label}</span>}
          {record.record_type === "trip" && record.plan_status && <span className={`status ${record.plan_status}`}><Clock3 size={14} />{{ planned: "计划中", completed: "已完成", cancelled: "已取消" }[record.plan_status]}</span>}
        </div>
      </div>
      {record.record_type === "expense" && record.amount != null && record.currency && <strong className="record-amount">{formatMoney(record.amount, record.currency)}</strong>}
      {record.record_type === "trip" && <div className="record-controls">
        {record.plan_status === "completed" && <span className="done-stamp"><Check size={15} />已打卡</span>}
        <div className="record-control-buttons">
          {trip && <button className="record-control-button" onClick={onEdit}><Pencil size={15} />{record.transport_type === "flight" ? "编辑航班" : "编辑计划"}</button>}
          {record.plan_status === "planned" && <><button className="record-control-button" onClick={() => onStatus(record, "completed")}><Check size={15} />标记完成</button><button className="record-control-button" onClick={() => onStatus(record, "cancelled")}><X size={15} />取消计划</button></>}
          {(record.plan_status === "completed" || record.plan_status === "cancelled") && <button className="record-control-button" onClick={() => onStatus(record, "planned")}><RotateCcw size={15} />{record.plan_status === "completed" ? "撤回完成" : "恢复计划"}</button>}
        </div>
      </div>}
      {record.record_type === "trip" && <span className="timeline-pin"><CalendarClock size={13} /></span>}
    </article>
  );
}
