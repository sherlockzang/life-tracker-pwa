import { useId, useState, type FormEvent } from "react";
import { CalendarClock, Check, LoaderCircle, MapPin, Plane, Route, Sparkles, TrainFront, X } from "lucide-react";
import type { ActualFlightInfo, FlightDetails, FlightStop, LifeRecord, MetroDetails, RailDetails, RailSystemType, RecordDraft, TransportDetails, TransportType, Trip } from "../types";
import { RAIL_SYSTEM_LABELS, getTransportPresentation, transportTitle } from "../lib/transport";
import { queryTransitRoute, TRANSIT_AI_ERROR } from "../lib/transitAi";
import { zonedDateTimeToIso } from "../lib/tripDates";
import { confirmFlightActual, demoFlightPreview, flightMatchEligibility, matchFlightActual, type FlightMatchPreview } from "../lib/flightLookup";
import { airportLabel, searchAirports, type AirportOption } from "../lib/airports";
import { TIMEZONE_OPTIONS, timeZoneLabel } from "../lib/timezones";
import { normalizeAircraftType, searchAircraftTypes } from "../lib/aircraftTypes";

type PlanKind = "general" | TransportType;

interface EditorProps {
  day: string;
  trip: Trip;
  count: number;
  record?: LifeRecord;
  modal?: boolean;
  isDemo?: boolean;
  onSave: (draft: RecordDraft) => Promise<void>;
  onUpdate?: (record: LifeRecord) => Promise<void>;
  onClose: () => void;
}

const AIRLINES = ["中国国际航空", "中国东方航空", "中国南方航空", "国泰航空", "香港航空", "日本航空 JAL", "全日空 ANA", "新加坡航空", "汉莎航空", "联合航空", "达美航空", "澳洲航空"];

function timeInZone(iso: string | undefined, timeZone: string) {
  if (!iso) return "09:00";
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

function emptyFlight(day: string, timeZone: string): FlightDetails {
  return { airline: "", flight_number: "", departure: { date: day, time: "09:00", airport: "", iata: "", terminal: "", timezone: timeZone }, arrival: { date: day, time: "11:00", airport: "", iata: "", terminal: "", timezone: timeZone } };
}

function emptyRail(day: string): RailDetails {
  return { system_type: "china_hsr", train_number: "", departure: { date: day, time: "09:00", station: "" }, arrival: { date: day, time: "11:00", station: "" } };
}

function emptyMetro(): MetroDetails {
  return { origin: "", destination: "", estimated_departure_time: "09:00", estimated_arrival_time: "" };
}

export function TransportPlanEditor({ day, trip, count, record, modal, isDemo = false, onSave, onUpdate, onClose }: EditorProps) {
  const [kind, setKind] = useState<PlanKind>(record?.transport_type || "general");
  const [content, setContent] = useState(record?.transport_type ? "" : record?.content || "");
  const [location, setLocation] = useState(record?.transport_type ? "" : record?.location || "");
  const [notes, setNotes] = useState(record?.transport_type ? "" : record?.notes || "");
  const [time, setTime] = useState(timeInZone(record?.event_at, trip.timezone));
  const storedFlight = record?.transport_type === "flight" ? record.transport_details as FlightDetails : null;
  const [flight, setFlight] = useState<FlightDetails>(storedFlight ? {
    ...storedFlight,
    departure: { ...storedFlight.departure, timezone: storedFlight.departure.timezone || trip.timezone },
    arrival: { ...storedFlight.arrival, timezone: storedFlight.arrival.timezone || trip.timezone }
  } : emptyFlight(day, trip.timezone));
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
        draft = { record_type: "trip", content, location, notes, event_at: zonedDateTimeToIso(day, time, trip.timezone), trip_id: trip.id, plan_status: record?.plan_status || "planned", sort_order: record?.sort_order ?? (count + 1) * 1000 };
      } else {
        const details: TransportDetails = kind === "flight" ? flight : kind === "rail" ? rail : metro;
        const departureDate = kind === "flight" ? flight.departure.date : kind === "rail" ? rail.departure.date : day;
        const departureTime = kind === "flight" ? flight.departure.time : kind === "rail" ? rail.departure.time : metro.estimated_departure_time || time;
        const eventTimeZone = kind === "flight" ? flight.departure.timezone || trip.timezone : trip.timezone;
        if (kind === "flight" && (!flight.departure.iata || !flight.arrival.iata)) throw new Error("请从机场补全列表中选择起飞机场和到达机场");
        draft = {
          record_type: "trip", content: transportTitle(kind, details),
          location: kind === "flight" ? `${flight.departure.airport} → ${flight.arrival.airport}` : kind === "rail" ? `${rail.departure.station} → ${rail.arrival.station}` : `${metro.origin} → ${metro.destination}`,
          notes: details.notes, event_at: zonedDateTimeToIso(departureDate, departureTime, eventTimeZone), trip_id: trip.id,
          plan_status: record?.plan_status || "planned", sort_order: record?.sort_order ?? (count + 1) * 1000, transport_type: kind, transport_details: details
        };
      }
      if (record && onUpdate) {
        await onUpdate({ ...record, content: draft.content.trim(), location: draft.location?.trim() || null, notes: draft.notes?.trim() || null, event_at: draft.event_at || record.event_at, plan_status: draft.plan_status || record.plan_status, sort_order: draft.sort_order ?? record.sort_order, transport_type: draft.transport_type || null, transport_details: draft.transport_details || null, updated_at: new Date().toISOString() });
      } else await onSave(draft);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  const form = <form className={`transport-plan-form ${modal ? "modal-card glass-card transport-editor-modal" : ""}`} onSubmit={submit}>
    {modal && <header><div><p className="eyebrow">编辑计划</p><h2>更新行程信息</h2></div><button type="button" className="icon-button" aria-label="关闭编辑" onClick={onClose}><X /></button></header>}
    <div className="plan-type-switch" role="tablist" aria-label="计划类型">{([{"value":"general","label":"通用事项","icon":MapPin},{"value":"flight","label":"飞机","icon":Plane},{"value":"rail","label":"高铁 / 铁路","icon":TrainFront},{"value":"metro","label":"市内交通","icon":Route}] as const).map((item) => { const Icon = item.icon; return <button type="button" role="tab" aria-selected={kind === item.value} className={kind === item.value ? "active" : ""} onClick={() => setKind(item.value)} key={item.value}><Icon size={15} />{item.label}</button>; })}</div>

    {kind === "general" && <div className="transport-fields"><label className="field-span-2">事项名称<input autoFocus value={content} onChange={(event) => setContent(event.target.value)} placeholder="地点或事项名称" required /></label><label>时间<input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label><label>地点 <span className="optional-tag">选填</span><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="例如 酒店大堂" /></label><label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label></div>}

    {kind === "flight" && <div className="transport-fields">
      <div className="flight-planning-note field-span-2"><Plane size={16} /><p><b>先填写计划信息</b><span>未来航班不调用接口。航班按计划到达约一小时后，可在行程卡片中主动匹配实际飞行数据。</span></p></div>
      <label>航空公司<input list={airlineListId} value={flight.airline} onChange={(event) => setFlight({ ...flight, airline: event.target.value })} placeholder="可选择或自行输入" required /></label><datalist id={airlineListId}>{AIRLINES.map((airline) => <option value={airline} key={airline} />)}</datalist>
      <label>航班号<input value={flight.flight_number} onChange={(event) => setFlight({ ...flight, flight_number: event.target.value.toUpperCase().replaceAll(" ", "") })} placeholder="例如 NH105" required /></label>
      <FlightStopEditor legend="起飞信息 · 当地时间" stop={flight.departure} onChange={(departure) => setFlight({ ...flight, departure })} />
      <FlightStopEditor legend="降落信息 · 当地时间" stop={flight.arrival} onChange={(arrival) => setFlight({ ...flight, arrival })} />
      <label>登机口 <span className="optional-tag">选填</span><input value={flight.gate || ""} onChange={(event) => setFlight({ ...flight, gate: event.target.value })} /></label>
      <label>座位号 <span className="optional-tag">选填</span><input value={flight.seat || ""} onChange={(event) => setFlight({ ...flight, seat: event.target.value })} /></label>
      <label>注册号 <span className="optional-tag">选填</span><input value={flight.registration || ""} onChange={(event) => setFlight({ ...flight, registration: event.target.value.toUpperCase() })} /></label>
      <AircraftTypeField value={flight.aircraft_type || ""} onChange={(aircraftType) => setFlight({ ...flight, aircraft_type: aircraftType })} />
      <label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={flight.notes || ""} onChange={(event) => setFlight({ ...flight, notes: event.target.value })} /></label>
    </div>}

    {kind === "rail" && <div className="transport-fields"><label>铁路系统<select value={rail.system_type} onChange={(event) => setRail({ ...rail, system_type: event.target.value as RailSystemType })}>{Object.entries(RAIL_SYSTEM_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>车次号<input value={rail.train_number} onChange={(event) => setRail({ ...rail, train_number: event.target.value })} required /></label>{rail.system_type === "other" && <label className="field-span-2">铁路系统名称<input value={rail.custom_system || ""} onChange={(event) => setRail({ ...rail, custom_system: event.target.value })} required /></label>}<RailStop legend="出发信息" value={rail.departure} onChange={(departure) => setRail({ ...rail, departure })} stationLabel="出发站" /><RailStop legend="到达信息" value={rail.arrival} onChange={(arrival) => setRail({ ...rail, arrival })} stationLabel="到达站" /><label className="field-span-2">座位 / 车厢 <span className="optional-tag">选填</span><input value={rail.seat_carriage || ""} onChange={(event) => setRail({ ...rail, seat_carriage: event.target.value })} /></label><label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={rail.notes || ""} onChange={(event) => setRail({ ...rail, notes: event.target.value })} /></label></div>}

    {kind === "metro" && <div className="transport-fields"><label>出发点<input value={metro.origin} onChange={(event) => setMetro({ ...metro, origin: event.target.value })} required /></label><label>到达点<input value={metro.destination} onChange={(event) => setMetro({ ...metro, destination: event.target.value })} required /></label><label>预计出发时间 <span className="optional-tag">选填</span><input type="time" value={metro.estimated_departure_time || ""} onChange={(event) => setMetro({ ...metro, estimated_departure_time: event.target.value })} /></label><label>预计到达时间 <span className="optional-tag">选填</span><input type="time" value={metro.estimated_arrival_time || ""} onChange={(event) => setMetro({ ...metro, estimated_arrival_time: event.target.value })} /></label><label className="field-span-2 route-description-field"><span>换乘线路 / 路线说明 <span className="optional-tag">选填</span><button type="button" className="ai-route-button" disabled={!metro.origin.trim() || !metro.destination.trim()} onClick={() => setShowAi(true)}><Sparkles size={14} />AI 帮我查</button></span><textarea rows={5} value={metro.route_description || ""} onChange={(event) => setMetro({ ...metro, route_description: event.target.value })} /></label><label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={metro.notes || ""} onChange={(event) => setMetro({ ...metro, notes: event.target.value })} /></label></div>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <footer className="transport-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? "保存中…" : record ? "保存修改" : "添加计划"}</button></footer>
    {showAi && <TransitAiDialog metro={metro} isDemo={isDemo} onClose={() => setShowAi(false)} onFill={(route) => { setMetro({ ...metro, route_description: route }); setShowAi(false); }} />}
  </form>;
  return modal ? <div className="modal-backdrop">{form}</div> : form;
}

function AircraftTypeField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [focused, setFocused] = useState(false);
  const options = focused ? searchAircraftTypes(value) : [];
  return <label className="aircraft-autocomplete">机型 <span className="optional-tag">选填</span><input value={value} onChange={(event) => onChange(event.target.value)} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); onChange(normalizeAircraftType(value)); }} placeholder="例如 78X、787-10" autoComplete="off" />{options.length > 0 && <div className="aircraft-options">{options.map((option) => <button type="button" key={option.canonical} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(option.canonical); setFocused(false); }}><b>{option.canonical}</b><small>{option.aliases.slice(0, 4).join(" · ")}</small></button>)}</div>}</label>;
}

function FlightStopEditor({ legend, stop, onChange }: { legend: string; stop: FlightStop; onChange: (stop: FlightStop) => void }) {
  const [query, setQuery] = useState(stop.airport);
  const options = query !== stop.airport || !stop.iata ? searchAirports(query) : [];
  function select(airport: AirportOption) {
    setQuery(airportLabel(airport));
    onChange({ ...stop, airport: airportLabel(airport), iata: airport.iata, timezone: airport.timezone });
  }
  return <fieldset className="transport-stop field-span-2"><legend>{legend}</legend><div><label>日期<input type="date" value={stop.date} onChange={(event) => onChange({ ...stop, date: event.target.value })} required /></label><label>时间<input type="time" value={stop.time} onChange={(event) => onChange({ ...stop, time: event.target.value })} required /></label><label className="airport-autocomplete">机场<input value={query} onChange={(event) => { setQuery(event.target.value); onChange({ ...stop, airport: event.target.value, iata: "" }); }} placeholder="输入羽田、HND、Tokyo…" autoComplete="off" required />{options.length > 0 && <div className="airport-options">{options.map((airport) => <button type="button" key={airport.iata} onClick={() => select(airport)}><b>{airport.iata}</b><span>{airport.nameZh}<small>{airport.city} · {airport.nameEn}</small></span></button>)}</div>}</label><label>航站楼 <span className="optional-tag">选填</span><input value={stop.terminal} onChange={(event) => onChange({ ...stop, terminal: event.target.value })} /></label><label className="flight-timezone-field">当地时区<select value={stop.timezone || "Asia/Shanghai"} onChange={(event) => onChange({ ...stop, timezone: event.target.value })} required>{TIMEZONE_OPTIONS.map((timezone) => <option value={timezone} key={timezone}>{timeZoneLabel(timezone)}</option>)}</select></label></div></fieldset>;
}

function RailStop({ legend, value, onChange, stationLabel }: { legend: string; value: RailDetails["departure"]; onChange: (value: RailDetails["departure"]) => void; stationLabel: string }) {
  return <fieldset className="transport-stop field-span-2"><legend>{legend}</legend><div className="rail-stop-grid"><label>日期<input type="date" value={value.date} onChange={(event) => onChange({ ...value, date: event.target.value })} required /></label><label>时间<input type="time" value={value.time} onChange={(event) => onChange({ ...value, time: event.target.value })} required /></label><label>{stationLabel}<input value={value.station} onChange={(event) => onChange({ ...value, station: event.target.value })} required /></label></div></fieldset>;
}

function TransitAiDialog({ metro, isDemo, onClose, onFill }: { metro: MetroDetails; isDemo: boolean; onClose: () => void; onFill: (route: string) => void }) {
  const [query, setQuery] = useState(`从${metro.origin}到${metro.destination}怎么乘坐地铁或公共交通？`);
  const [preview, setPreview] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function runQuery() { setLoading(true); setError(""); try { setPreview(await queryTransitRoute(metro.origin, metro.destination, query, metro.estimated_departure_time, isDemo)); } catch (queryError) { setError(queryError instanceof Error ? queryError.message : TRANSIT_AI_ERROR); } finally { setLoading(false); } }
  return <div className="nested-modal-backdrop"><section className="modal-card glass-card transit-ai-modal" role="dialog" aria-modal="true"><header><div><p className="eyebrow">AI 路线查询</p><h2>确认查询内容</h2></div><button type="button" className="icon-button" onClick={onClose}><X /></button></header><label>查询内容<textarea rows={3} value={query} onChange={(event) => setQuery(event.target.value)} maxLength={500} /></label><button type="button" className="secondary-button ai-query-submit" disabled={loading || !query.trim()} onClick={() => void runQuery()}>{loading ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{loading ? "正在查询…" : "查询路线"}</button>{error && <p className="field-error">{error}</p>}{preview && <label>路线预览<textarea rows={7} value={preview} onChange={(event) => setPreview(event.target.value)} /></label>}<p className="ai-disclaimer">AI 结果仅供规划参考。确认后才会填入表单，请以当地实时交通信息为准。</p><footer><button type="button" className="secondary-button" onClick={onClose}>取消</button>{preview && <button type="button" className="primary-button" onClick={() => onFill(preview)}>确认并填入</button>}</footer></section></div>;
}

export function TransportDetailsPanel({ record, isDemo = false, onUpdate, onEdit }: { record: LifeRecord; isDemo?: boolean; onUpdate: (record: LifeRecord) => Promise<void>; onEdit: () => void }) {
  const [gate, setGate] = useState(record.transport_type === "flight" ? (record.transport_details as FlightDetails).gate || "" : "");
  const [savingGate, setSavingGate] = useState(false);
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState("");
  const [preview, setPreview] = useState<FlightMatchPreview | null>(null);
  if (!record.transport_type || !record.transport_details) return <button className="edit-plan-button" onClick={onEdit}>编辑事项信息</button>;
  const presentation = getTransportPresentation(record);

  async function saveGate() { if (record.transport_type !== "flight") return; setSavingGate(true); await onUpdate({ ...record, transport_details: { ...(record.transport_details as FlightDetails), gate: gate.trim() || undefined }, updated_at: new Date().toISOString() }); setSavingGate(false); }
  async function runMatch(rematch = false) {
    if (rematch && !window.confirm("重新匹配会再次使用一次航班查询额度，是否继续？")) return;
    setMatching(true); setMatchError("");
    try { setPreview(isDemo ? demoFlightPreview(record) : await matchFlightActual(record, rematch)); }
    catch (error) { setMatchError(error instanceof Error ? error.message : "暂时无法匹配航班"); }
    finally { setMatching(false); }
  }
  async function confirmPreview() {
    if (!preview) return;
    setMatching(true); setMatchError("");
    try {
      if (isDemo || preview.cached) await onUpdate({ ...record, actual_match_status: "matched", actual_info: preview.preview, actual_info_matched: true, actual_matched_at: preview.preview.matched_at || new Date().toISOString(), actual_match_provider: "aviationstack", actual_match_request_id: preview.requestId, updated_at: new Date().toISOString() });
      else await onUpdate(await confirmFlightActual(record.id, preview.requestId));
      setPreview(null);
    } catch (error) { setMatchError(error instanceof Error ? error.message : "保存失败"); }
    finally { setMatching(false); }
  }
  const eligibility = flightMatchEligibility(record);

  return <section className="transport-details-panel"><div className="transport-details-heading"><div><span>{presentation.label}</span><strong>{presentation.title}</strong></div><button className="edit-plan-button" onClick={onEdit}>编辑完整信息</button></div>
    {record.transport_type === "flight" && (() => { const details = record.transport_details as FlightDetails; const actual = record.actual_info; return <><div className="transport-route-grid"><div><small>计划起飞 · 当地时间</small><b>{details.departure.airport}</b><span>{details.departure.date} · {details.departure.time} {details.departure.terminal && `· ${details.departure.terminal}`}</span><i>{details.departure.timezone}</i></div><Route size={18} /><div><small>计划降落 · 当地时间</small><b>{details.arrival.airport}</b><span>{details.arrival.date} · {details.arrival.time} {details.arrival.terminal && `· ${details.arrival.terminal}`}</span><i>{details.arrival.timezone}</i></div></div><div className="transport-facts">{details.airline && <span>航空公司 <b>{details.airline}</b></span>}{details.seat && <span>座位 <b>{details.seat}</b></span>}{details.aircraft_type && <span>计划机型 <b>{details.aircraft_type}</b></span>}</div><div className="gate-editor"><label>登机口<input value={gate} onChange={(event) => setGate(event.target.value)} placeholder="尚未公布" /></label><button className="secondary-button" disabled={savingGate || gate === (details.gate || "")} onClick={() => void saveGate()}>{savingGate ? "保存中…" : "更新登机口"}</button></div>
      <div className="flight-match-card">{record.actual_info_matched && actual ? <><div className="match-success"><Check size={16} /><span><b>实际飞行信息已匹配</b><small>不会在打开页面时重复查询</small></span></div><ActualFlightSummary actual={actual} /><button className="text-button" onClick={() => void runMatch(true)}>重新匹配</button></> : <><div><b>实际飞行信息</b><p>{eligibility.reason}</p>{(record.actual_match_status === "not_found" || record.actual_match_status === "failed") && <small>上次没有保存匹配结果；再次尝试会使用一次航班额度。</small>}</div>{eligibility.eligible && <button className="secondary-button" disabled={matching} onClick={() => void runMatch(record.actual_match_status === "not_found" || record.actual_match_status === "failed")}>{matching ? <LoaderCircle className="spin" size={15} /> : <Plane size={15} />}{matching ? "正在匹配…" : record.actual_match_status === "not_found" || record.actual_match_status === "failed" ? "重新匹配" : "匹配实际飞行信息"}</button>}</>}{matchError && <p className="field-error">{matchError}</p>}</div></>; })()}
    {record.transport_type === "rail" && (() => { const details = record.transport_details as RailDetails; return <><div className="transport-route-grid"><div><small>出发</small><b>{details.departure.station}</b><span>{details.departure.date} · {details.departure.time}</span></div><TrainFront size={18} /><div><small>到达</small><b>{details.arrival.station}</b><span>{details.arrival.date} · {details.arrival.time}</span></div></div></>; })()}
    {record.transport_type === "metro" && (() => { const details = record.transport_details as MetroDetails; return <><div className="transport-route-grid metro"><div><small>出发点</small><b>{details.origin}</b></div><Route size={18} /><div><small>到达点</small><b>{details.destination}</b></div></div>{details.route_description && <div className="route-description-preview"><CalendarClock size={16} /><p>{details.route_description}</p></div>}</>; })()}
    {preview && <FlightPreviewDialog plan={record.transport_details as FlightDetails} actual={preview.preview} loading={matching} onClose={() => setPreview(null)} onConfirm={() => void confirmPreview()} />}
  </section>;
}

function ActualFlightSummary({ actual }: { actual: ActualFlightInfo }) {
  return <div className="actual-flight-summary"><span>状态 <b>{actual.status || "已完成"}</b></span><span>实际起飞 <b>{actual.departure.actual.date || actual.departure.estimated.date} {actual.departure.actual.time || actual.departure.estimated.time}</b></span><span>实际到达 <b>{actual.arrival.actual.date || actual.arrival.estimated.date} {actual.arrival.actual.time || actual.arrival.estimated.time}</b></span>{actual.arrival.delay_minutes > 0 && <span>到达延误 <b>{actual.arrival.delay_minutes} 分钟</b></span>}{actual.aircraft_type && <span>实际机型 <b>{actual.aircraft_type}</b></span>}</div>;
}

function FlightPreviewDialog({ plan, actual, loading, onClose, onConfirm }: { plan: FlightDetails; actual: ActualFlightInfo; loading: boolean; onClose: () => void; onConfirm: () => void }) {
  return <div className="nested-modal-backdrop"><section className="modal-card glass-card flight-lookup-modal"><header><div><p className="eyebrow">计划 vs 实际</p><h2>确认实际飞行信息</h2></div><button className="icon-button" onClick={onClose}><X /></button></header><p className="flight-lookup-intro">先核对差异，再决定是否保存。原计划会完整保留。</p><div className="flight-compare-grid"><article><b>计划</b><span>起飞 {plan.departure.date} {plan.departure.time}</span><span>到达 {plan.arrival.date} {plan.arrival.time}</span><span>登机口 {plan.gate || "未填写"}</span><span>机型 {plan.aircraft_type || "未填写"}</span></article><article><b>实际</b><span>起飞 {actual.departure.actual.date || actual.departure.estimated.date} {actual.departure.actual.time || actual.departure.estimated.time}</span><span>到达 {actual.arrival.actual.date || actual.arrival.estimated.date} {actual.arrival.actual.time || actual.arrival.estimated.time}</span><span>登机口 {actual.departure.gate || "未提供"}</span><span>机型 {actual.aircraft_type || "未提供"}</span></article></div><footer><button className="secondary-button" onClick={onClose}>保留计划</button><button className="primary-button" disabled={loading} onClick={onConfirm}>{loading ? "保存中…" : "确认保存实际信息"}</button></footer></section></div>;
}
