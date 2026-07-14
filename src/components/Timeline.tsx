import { CalendarClock, Check, CircleDollarSign, Clock3, MapPin, NotebookPen, ReceiptText, Route, Sparkles, X } from "lucide-react";
import type { Currency, LifeRecord, RecordType, Trip } from "../types";
import { CATEGORY_META, formatDateTime, formatMoney } from "../types";

interface Props {
  records: LifeRecord[];
  trips: Trip[];
  filter: "all" | RecordType;
  baseCurrency: Currency;
  onStatus: (record: LifeRecord, status: "planned" | "completed" | "cancelled") => void;
}

const icons = { expense: ReceiptText, trip: Route, note: NotebookPen };
const labels = { expense: "消费", trip: "行程", note: "随记" };

export function Timeline({ records, trips, filter, onStatus }: Props) {
  const visible = records.filter((record) => !record.parent_plan_id && (filter === "all" || record.record_type === filter)).sort((a, b) => b.event_at.localeCompare(a.event_at));
  const grouped = visible.reduce<Record<string, LifeRecord[]>>((acc, record) => {
    const date = new Date(record.event_at).toDateString();
    (acc[date] ||= []).push(record);
    return acc;
  }, {});

  if (!visible.length) {
    return <div className="empty-timeline glass-card"><span><Sparkles /></span><h3>这里还很安静</h3><p>从上方快速记下第一条，生活的时间线就会从这里开始。</p></div>;
  }

  return (
    <section className="timeline">
      {Object.entries(grouped).map(([date, items]) => (
        <div className="timeline-day" key={date}>
          <div className="day-label"><span>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(date))}</span><small>{new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(new Date(date))}</small></div>
          <div className="day-records">
            {items.map((record) => <RecordCard key={record.id} record={record} trip={trips.find((trip) => trip.id === record.trip_id)} onStatus={onStatus} />)}
          </div>
        </div>
      ))}
    </section>
  );
}

function RecordCard({ record, trip, onStatus }: { record: LifeRecord; trip?: Trip; onStatus: Props["onStatus"] }) {
  const Icon = icons[record.record_type];
  return (
    <article className={`record-card glass-card record-${record.record_type}`}>
      <span className="record-icon"><Icon size={20} /></span>
      <div className="record-main">
        <div className="record-meta"><span>{labels[record.record_type]}</span><i>·</i><time>{formatDateTime(record.event_at).split(" ").slice(-1)}</time>{trip && <em>{trip.name}</em>}</div>
        <h3>{record.content}</h3>
        {record.notes && <p>{record.notes}</p>}
        <div className="record-details">
          {record.location && <span><MapPin size={14} />{record.location}</span>}
          {record.record_type === "expense" && record.expense_category && <span><CircleDollarSign size={14} />{CATEGORY_META[record.expense_category].label}</span>}
          {record.record_type === "trip" && record.plan_status && <span className={`status ${record.plan_status}`}><Clock3 size={14} />{{ planned: "计划中", completed: "已完成", cancelled: "已取消" }[record.plan_status]}</span>}
        </div>
      </div>
      {record.record_type === "expense" && record.amount != null && record.currency && <strong className="record-amount">{formatMoney(record.amount, record.currency)}</strong>}
      {record.record_type === "trip" && record.plan_status === "planned" && <div className="record-actions"><button title="标记完成" onClick={() => onStatus(record, "completed")}><Check size={17} /></button><button title="取消计划" onClick={() => onStatus(record, "cancelled")}><X size={17} /></button></div>}
      {record.record_type === "trip" && record.plan_status === "completed" && <span className="done-stamp"><Check size={15} />已打卡</span>}
      {record.record_type === "trip" && <span className="timeline-pin"><CalendarClock size={13} /></span>}
    </article>
  );
}
