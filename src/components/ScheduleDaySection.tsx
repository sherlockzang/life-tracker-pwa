import { useState } from "react";
import { BedDouble, CalendarDays, Check, Pencil, Plus, RotateCcw, X } from "lucide-react";
import type { LifeRecord, RecordDraft, Trip } from "../types";
import { scheduleDayNotice, scheduleNights, type ScheduleDayEntry } from "../lib/schedules";
import { TransportPlanEditor } from "./TransportPlanEditor";

interface Props {
  day: string;
  trip: Trip;
  entries: ScheduleDayEntry[];
  isDemo: boolean;
  onAdd: () => void;
  onSave: (draft: RecordDraft) => Promise<void>;
  onUpdate: (record: LifeRecord) => Promise<void>;
}

export function ScheduleDaySection({ day, trip, entries, isDemo, onAdd, onSave, onUpdate }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = entries.find((entry) => entry.record.id === editingId);
  const notice = scheduleDayNotice(entries);
  return <section className="schedule-day-section" aria-label={`${day} 全天与住宿`}>
    <header><span><CalendarDays size={16} />全天与住宿</span><button className="text-button" onClick={onAdd}><Plus size={14} />添加</button></header>
    {notice.change && <p className="hotel-change-notice">{notice.change}</p>}
    {notice.conflict && <p className="field-error">{notice.conflict}</p>}
    <div className="schedule-cards">{entries.map(({ record, details, phase }) => {
      const hotel = details.kind === "hotel";
      const phaseLabel = { all_day: "全天", check_in: "入住", staying: "连住", check_out: "退房" }[phase];
      const phaseTime = phase === "check_in" ? details.check_in_time : phase === "check_out" ? details.check_out_time : "";
      const Icon = hotel ? BedDouble : CalendarDays;
      return <article className={`schedule-card glass-card ${record.plan_status} ${phase}`} key={record.id}>
        <div className="schedule-card-top"><span className="schedule-phase"><Icon size={16} />{phaseLabel}{phaseTime && ` · ${phaseTime}`}</span><span className={`status ${record.plan_status}`}>{{ planned: "计划中", completed: "已完成", cancelled: "已取消" }[record.plan_status || "planned"]}</span></div>
        <h3>{record.content}</h3>
        <p>{hotel ? `${details.start_date} 入住 → ${details.end_date} 退房 · ${scheduleNights(details)} 晚` : details.start_date === details.end_date ? "全天安排" : `${details.start_date} — ${details.end_date}（含结束日）`}</p>
        {phase === "check_out" && <small>本日仅退房，不计入住宿夜晚。</small>}
        {record.location && <p>{record.location}</p>}
        {details.booking_reference && <p>预订号：{details.booking_reference}</p>}
        {record.notes && <p className="schedule-notes">{record.notes}</p>}
        <div className="record-control-buttons"><button className="record-control-button" aria-label={`编辑${record.content}`} onClick={() => setEditingId(record.id)}><Pencil size={14} />编辑{hotel ? "住宿" : "事项"}</button>
          <button className="record-control-button" onClick={() => void onUpdate({ ...record, plan_status: record.plan_status === "planned" ? "completed" : "planned", updated_at: new Date().toISOString() }).catch(() => undefined)}>{record.plan_status === "planned" ? <Check size={14} /> : <RotateCcw size={14} />}{record.plan_status === "planned" ? "标记完成" : record.plan_status === "completed" ? "撤回完成" : "恢复计划"}</button>
          {record.plan_status === "planned" && <button className="record-control-button" onClick={() => void onUpdate({ ...record, plan_status: "cancelled", updated_at: new Date().toISOString() }).catch(() => undefined)}><X size={14} />取消计划</button>}
        </div>
      </article>;
    })}</div>
    {!entries.length && <p className="schedule-empty">可添加全天事项，或跨日的酒店住宿。</p>}
    {editing && <TransportPlanEditor key={editing.record.id} modal day={editing.details.start_date} trip={trip} count={0} record={editing.record} isDemo={isDemo} onSave={onSave} onUpdate={onUpdate} onClose={() => setEditingId(null)} />}
  </section>;
}
