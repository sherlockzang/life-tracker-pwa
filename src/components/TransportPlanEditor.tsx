import { useId, useState, type FormEvent } from "react";
import { CalendarClock, LoaderCircle, MapPin, Plane, Route, Sparkles, TrainFront, X } from "lucide-react";
import type { FlightDetails, LifeRecord, MetroDetails, RailDetails, RailSystemType, RecordDraft, TransportDetails, TransportType, Trip } from "../types";
import { RAIL_SYSTEM_LABELS, getTransportPresentation, transportTitle } from "../lib/transport";
import { queryTransitRoute, TRANSIT_AI_ERROR } from "../lib/transitAi";
import { zonedDateTimeToIso } from "../lib/tripDates";

type PlanKind = "general" | TransportType;

interface EditorProps {
  day: string;
  trip: Trip;
  count: number;
  record?: LifeRecord;
  modal?: boolean;
  onSave: (draft: RecordDraft) => Promise<void>;
  onUpdate?: (record: LifeRecord) => Promise<void>;
  onClose: () => void;
}

const AIRLINES = ["中国国际航空", "中国东方航空", "中国南方航空", "国泰航空", "香港航空", "日本航空 JAL", "全日空 ANA", "新加坡航空", "汉莎航空", "联合航空", "达美航空", "澳洲航空"];

function timeInZone(iso: string | undefined, timeZone: string) {
  if (!iso) return "09:00";
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

function emptyFlight(day: string): FlightDetails {
  return { airline: "", flight_number: "", departure: { date: day, time: "09:00", airport: "", terminal: "" }, arrival: { date: day, time: "11:00", airport: "", terminal: "" } };
}

function emptyRail(day: string): RailDetails {
  return { system_type: "china_hsr", train_number: "", departure: { date: day, time: "09:00", station: "" }, arrival: { date: day, time: "11:00", station: "" } };
}

function emptyMetro(): MetroDetails {
  return { origin: "", destination: "", estimated_departure_time: "09:00", estimated_arrival_time: "" };
}

export function TransportPlanEditor({ day, trip, count, record, modal, onSave, onUpdate, onClose }: EditorProps) {
  const [kind, setKind] = useState<PlanKind>(record?.transport_type || "general");
  const [content, setContent] = useState(record?.transport_type ? "" : record?.content || "");
  const [location, setLocation] = useState(record?.transport_type ? "" : record?.location || "");
  const [notes, setNotes] = useState(record?.transport_type ? "" : record?.notes || "");
  const [time, setTime] = useState(timeInZone(record?.event_at, trip.timezone));
  const [flight, setFlight] = useState<FlightDetails>(record?.transport_type === "flight" ? record.transport_details as FlightDetails : emptyFlight(day));
  const [rail, setRail] = useState<RailDetails>(record?.transport_type === "rail" ? record.transport_details as RailDetails : emptyRail(day));
  const [metro, setMetro] = useState<MetroDetails>(record?.transport_type === "metro" ? record.transport_details as MetroDetails : emptyMetro());
  const [showAi, setShowAi] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const airlineListId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      let draft: RecordDraft;
      if (kind === "general") {
        draft = {
          record_type: "trip",
          content,
          location,
          notes,
          event_at: zonedDateTimeToIso(day, time, trip.timezone),
          trip_id: trip.id,
          plan_status: record?.plan_status || "planned",
          sort_order: record?.sort_order ?? (count + 1) * 1000
        };
      } else {
        const details: TransportDetails = kind === "flight" ? flight : kind === "rail" ? rail : metro;
        const departureDate = kind === "flight" ? flight.departure.date : kind === "rail" ? rail.departure.date : day;
        const departureTime = kind === "flight" ? flight.departure.time : kind === "rail" ? rail.departure.time : metro.estimated_departure_time || time;
        const generatedTitle = transportTitle(kind, details);
        const generatedLocation = kind === "flight"
          ? `${flight.departure.airport} → ${flight.arrival.airport}`
          : kind === "rail"
            ? `${rail.departure.station} → ${rail.arrival.station}`
            : `${metro.origin} → ${metro.destination}`;
        draft = {
          record_type: "trip",
          content: generatedTitle,
          location: generatedLocation,
          notes: details.notes,
          event_at: zonedDateTimeToIso(departureDate, departureTime, trip.timezone),
          trip_id: trip.id,
          plan_status: record?.plan_status || "planned",
          sort_order: record?.sort_order ?? (count + 1) * 1000,
          transport_type: kind,
          transport_details: details
        };
      }

      if (record && onUpdate) {
        await onUpdate({
          ...record,
          content: draft.content.trim(),
          location: draft.location?.trim() || null,
          notes: draft.notes?.trim() || null,
          event_at: draft.event_at || record.event_at,
          plan_status: draft.plan_status || record.plan_status,
          sort_order: draft.sort_order ?? record.sort_order,
          transport_type: draft.transport_type || null,
          transport_details: draft.transport_details || null,
          updated_at: new Date().toISOString()
        });
      } else {
        await onSave(draft);
      }
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  const form = (
    <form className={`transport-plan-form ${modal ? "modal-card glass-card transport-editor-modal" : ""}`} onSubmit={submit}>
      {modal && <header><div><p className="eyebrow">编辑计划</p><h2>更新行程信息</h2></div><button type="button" className="icon-button" aria-label="关闭编辑" onClick={onClose}><X /></button></header>}
      <div className="plan-type-switch" role="tablist" aria-label="计划类型">
        {([{"value":"general","label":"通用事项","icon":MapPin},{"value":"flight","label":"飞机","icon":Plane},{"value":"rail","label":"高铁 / 铁路","icon":TrainFront},{"value":"metro","label":"地铁 / 市内交通","icon":Route}] as const).map((item) => {
          const Icon = item.icon;
          return <button type="button" role="tab" aria-selected={kind === item.value} className={kind === item.value ? "active" : ""} onClick={() => setKind(item.value)} key={item.value}><Icon size={15} />{item.label}</button>;
        })}
      </div>

      {kind === "general" && <div className="transport-fields"><label className="field-span-2">事项名称<input autoFocus value={content} onChange={(event) => setContent(event.target.value)} placeholder="地点或事项名称" required /></label><label>时间<input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label><label>地点<input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="选填" /></label><label className="field-span-2">备注<textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="预订信息或其他说明" /></label></div>}

      {kind === "flight" && <div className="transport-fields">
        <label>航空公司<input list={airlineListId} value={flight.airline} onChange={(event) => setFlight({ ...flight, airline: event.target.value })} placeholder="可选择或自行输入" required /></label><datalist id={airlineListId}>{AIRLINES.map((airline) => <option value={airline} key={airline} />)}</datalist>
        <label>航班号<input value={flight.flight_number} onChange={(event) => setFlight({ ...flight, flight_number: event.target.value.toUpperCase() })} placeholder="例如 CX880" required /></label>
        <fieldset className="transport-stop field-span-2"><legend>起飞信息</legend><div><label>日期<input type="date" value={flight.departure.date} onChange={(event) => setFlight({ ...flight, departure: { ...flight.departure, date: event.target.value } })} required /></label><label>时间<input type="time" value={flight.departure.time} onChange={(event) => setFlight({ ...flight, departure: { ...flight.departure, time: event.target.value } })} required /></label><label>机场<input value={flight.departure.airport} onChange={(event) => setFlight({ ...flight, departure: { ...flight.departure, airport: event.target.value } })} placeholder="洛杉矶 LAX" required /></label><label>航站楼<input value={flight.departure.terminal} onChange={(event) => setFlight({ ...flight, departure: { ...flight.departure, terminal: event.target.value } })} placeholder="T2" required /></label></div></fieldset>
        <fieldset className="transport-stop field-span-2"><legend>降落信息</legend><div><label>日期<input type="date" value={flight.arrival.date} onChange={(event) => setFlight({ ...flight, arrival: { ...flight.arrival, date: event.target.value } })} required /></label><label>时间<input type="time" value={flight.arrival.time} onChange={(event) => setFlight({ ...flight, arrival: { ...flight.arrival, time: event.target.value } })} required /></label><label>机场<input value={flight.arrival.airport} onChange={(event) => setFlight({ ...flight, arrival: { ...flight.arrival, airport: event.target.value } })} placeholder="香港 HKG" required /></label><label>航站楼<input value={flight.arrival.terminal} onChange={(event) => setFlight({ ...flight, arrival: { ...flight.arrival, terminal: event.target.value } })} placeholder="T1" required /></label></div></fieldset>
        <label>登机口<span className="field-hint">可稍后随时更新</span><input value={flight.gate || ""} onChange={(event) => setFlight({ ...flight, gate: event.target.value })} placeholder="例如 24A" /></label>
        <label>座位号<input value={flight.seat || ""} onChange={(event) => setFlight({ ...flight, seat: event.target.value })} placeholder="例如 18A" /></label>
        <label>注册号<input value={flight.registration || ""} onChange={(event) => setFlight({ ...flight, registration: event.target.value.toUpperCase() })} placeholder="例如 B-LJA" /></label>
        <label>机型<input value={flight.aircraft_type || ""} onChange={(event) => setFlight({ ...flight, aircraft_type: event.target.value })} placeholder="例如 A350-900" /></label>
        <label className="field-span-2">备注<textarea rows={3} value={flight.notes || ""} onChange={(event) => setFlight({ ...flight, notes: event.target.value })} placeholder="选填" /></label>
      </div>}

      {kind === "rail" && <div className="transport-fields">
        <label>铁路系统<select value={rail.system_type} onChange={(event) => setRail({ ...rail, system_type: event.target.value as RailSystemType })}>{Object.entries(RAIL_SYSTEM_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label>车次号<input value={rail.train_number} onChange={(event) => setRail({ ...rail, train_number: event.target.value })} placeholder="例如 G1234 / のぞみ123号" required /></label>
        {rail.system_type === "other" && <label className="field-span-2">铁路系统名称<input value={rail.custom_system || ""} onChange={(event) => setRail({ ...rail, custom_system: event.target.value })} placeholder="输入铁路系统名称" required /></label>}
        <fieldset className="transport-stop field-span-2"><legend>出发信息</legend><div className="rail-stop-grid"><label>日期<input type="date" value={rail.departure.date} onChange={(event) => setRail({ ...rail, departure: { ...rail.departure, date: event.target.value } })} required /></label><label>时间<input type="time" value={rail.departure.time} onChange={(event) => setRail({ ...rail, departure: { ...rail.departure, time: event.target.value } })} required /></label><label>出发站<input value={rail.departure.station} onChange={(event) => setRail({ ...rail, departure: { ...rail.departure, station: event.target.value } })} placeholder="例如 北京南站" required /></label></div></fieldset>
        <fieldset className="transport-stop field-span-2"><legend>到达信息</legend><div className="rail-stop-grid"><label>日期<input type="date" value={rail.arrival.date} onChange={(event) => setRail({ ...rail, arrival: { ...rail.arrival, date: event.target.value } })} required /></label><label>时间<input type="time" value={rail.arrival.time} onChange={(event) => setRail({ ...rail, arrival: { ...rail.arrival, time: event.target.value } })} required /></label><label>到达站<input value={rail.arrival.station} onChange={(event) => setRail({ ...rail, arrival: { ...rail.arrival, station: event.target.value } })} placeholder="例如 上海虹桥站" required /></label></div></fieldset>
        <label className="field-span-2">座位 / 车厢信息<input value={rail.seat_carriage || ""} onChange={(event) => setRail({ ...rail, seat_carriage: event.target.value })} placeholder="例如 8号车厢 12A" /></label>
        <label className="field-span-2">备注<textarea rows={3} value={rail.notes || ""} onChange={(event) => setRail({ ...rail, notes: event.target.value })} placeholder="选填" /></label>
      </div>}

      {kind === "metro" && <div className="transport-fields">
        <label>出发点<input value={metro.origin} onChange={(event) => setMetro({ ...metro, origin: event.target.value })} placeholder="例如 羽田机场 T2" required /></label>
        <label>到达点<input value={metro.destination} onChange={(event) => setMetro({ ...metro, destination: event.target.value })} placeholder="例如 东京站" required /></label>
        <label>预计出发时间<input type="time" value={metro.estimated_departure_time || ""} onChange={(event) => setMetro({ ...metro, estimated_departure_time: event.target.value })} /></label>
        <label>预计到达时间<input type="time" value={metro.estimated_arrival_time || ""} onChange={(event) => setMetro({ ...metro, estimated_arrival_time: event.target.value })} /></label>
        <label className="field-span-2 route-description-field"><span>换乘线路 / 路线说明<button type="button" className="ai-route-button" disabled={!metro.origin.trim() || !metro.destination.trim()} onClick={() => setShowAi(true)}><Sparkles size={14} />AI 帮我查</button></span><textarea rows={5} value={metro.route_description || ""} onChange={(event) => setMetro({ ...metro, route_description: event.target.value })} placeholder="手动填写，或使用 AI 查询后确认填入" /></label>
        <label className="field-span-2">备注<textarea rows={3} value={metro.notes || ""} onChange={(event) => setMetro({ ...metro, notes: event.target.value })} placeholder="选填" /></label>
      </div>}

      {error && <p className="field-error" role="alert">{error}</p>}
      <footer className="transport-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? "保存中…" : record ? "保存修改" : "添加计划"}</button></footer>
      {showAi && <TransitAiDialog metro={metro} onClose={() => setShowAi(false)} onFill={(route) => { setMetro({ ...metro, route_description: route }); setShowAi(false); }} />}
    </form>
  );

  return modal ? <div className="modal-backdrop">{form}</div> : form;
}

function TransitAiDialog({ metro, onClose, onFill }: { metro: MetroDetails; onClose: () => void; onFill: (route: string) => void }) {
  const [query, setQuery] = useState(`从${metro.origin}到${metro.destination}怎么乘坐地铁或公共交通？`);
  const [preview, setPreview] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function runQuery() {
    if (!query.trim()) return;
    setLoading(true);
    setError("");
    try {
      setPreview(await queryTransitRoute(metro.origin, metro.destination, query, metro.estimated_departure_time));
    } catch {
      setError(TRANSIT_AI_ERROR);
    } finally {
      setLoading(false);
    }
  }

  return <div className="nested-modal-backdrop"><section className="modal-card glass-card transit-ai-modal" role="dialog" aria-modal="true" aria-labelledby="transit-ai-title"><header><div><p className="eyebrow">AI 路线查询</p><h2 id="transit-ai-title">确认查询内容</h2></div><button type="button" className="icon-button" aria-label="关闭 AI 路线查询" onClick={onClose}><X /></button></header><label>查询内容<textarea rows={3} value={query} onChange={(event) => setQuery(event.target.value)} /></label><button type="button" className="secondary-button ai-query-submit" disabled={loading || !query.trim()} onClick={() => void runQuery()}>{loading ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{loading ? "正在查询…" : "查询路线"}</button>{error && <p className="field-error" role="alert">{error}</p>}{preview && <><label>路线预览<textarea rows={7} value={preview} onChange={(event) => setPreview(event.target.value)} /></label><p className="ai-disclaimer">AI 结果仅供规划参考，请以当地实时交通信息为准。</p></>}<footer><button type="button" className="secondary-button" onClick={onClose}>取消</button>{preview && <button type="button" className="primary-button" onClick={() => onFill(preview)}>填入路线</button>}</footer></section></div>;
}

export function TransportDetailsPanel({ record, onUpdate, onEdit }: { record: LifeRecord; onUpdate: (record: LifeRecord) => Promise<void>; onEdit: () => void }) {
  const [gate, setGate] = useState(record.transport_type === "flight" ? (record.transport_details as FlightDetails).gate || "" : "");
  const [savingGate, setSavingGate] = useState(false);
  if (!record.transport_type || !record.transport_details) return <button className="edit-plan-button" onClick={onEdit}>编辑事项信息</button>;
  const presentation = getTransportPresentation(record);

  async function saveGate() {
    if (record.transport_type !== "flight") return;
    setSavingGate(true);
    await onUpdate({ ...record, transport_details: { ...(record.transport_details as FlightDetails), gate: gate.trim() || undefined }, updated_at: new Date().toISOString() });
    setSavingGate(false);
  }

  return <section className="transport-details-panel"><div className="transport-details-heading"><div><span>{presentation.label}</span><strong>{presentation.title}</strong></div><button className="edit-plan-button" onClick={onEdit}>编辑完整信息</button></div>
    {record.transport_type === "flight" && (() => { const details = record.transport_details as FlightDetails; return <><div className="transport-route-grid"><div><small>起飞</small><b>{details.departure.airport}</b><span>{details.departure.date} · {details.departure.time} · {details.departure.terminal}</span></div><Route size={18} /><div><small>降落</small><b>{details.arrival.airport}</b><span>{details.arrival.date} · {details.arrival.time} · {details.arrival.terminal}</span></div></div><div className="transport-facts">{details.airline && <span>航空公司 <b>{details.airline}</b></span>}{details.seat && <span>座位 <b>{details.seat}</b></span>}{details.aircraft_type && <span>机型 <b>{details.aircraft_type}</b></span>}{details.registration && <span>注册号 <b>{details.registration}</b></span>}</div><div className="gate-editor"><label>登机口<input value={gate} onChange={(event) => setGate(event.target.value)} placeholder="尚未公布" /></label><button className="secondary-button" disabled={savingGate || gate === (details.gate || "")} onClick={() => void saveGate()}>{savingGate ? "保存中…" : "更新登机口"}</button></div></>; })()}
    {record.transport_type === "rail" && (() => { const details = record.transport_details as RailDetails; const system = details.system_type === "other" ? details.custom_system : RAIL_SYSTEM_LABELS[details.system_type]; return <><div className="transport-route-grid"><div><small>出发</small><b>{details.departure.station}</b><span>{details.departure.date} · {details.departure.time}</span></div><TrainFront size={18} /><div><small>到达</small><b>{details.arrival.station}</b><span>{details.arrival.date} · {details.arrival.time}</span></div></div><div className="transport-facts"><span>铁路系统 <b>{system}</b></span>{details.seat_carriage && <span>座位 / 车厢 <b>{details.seat_carriage}</b></span>}</div></>; })()}
    {record.transport_type === "metro" && (() => { const details = record.transport_details as MetroDetails; return <><div className="transport-route-grid metro"><div><small>出发点</small><b>{details.origin}</b></div><Route size={18} /><div><small>到达点</small><b>{details.destination}</b></div></div>{details.route_description && <div className="route-description-preview"><CalendarClock size={16} /><p>{details.route_description}</p></div>}</>; })()}
  </section>;
}
