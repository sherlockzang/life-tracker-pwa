import { useId, useState, type FormEvent } from "react";
import { BedDouble, CalendarDays, CalendarClock, Check, LoaderCircle, MapPin, Plane, Route, Sparkles, TrainFront, X } from "lucide-react";
import type { ActualFlightInfo, FlightDetails, FlightStop, LifeRecord, MetroDetails, RailDetails, RailSystemType, RecordDraft, TransportDetails, TransportType, Trip } from "../types";
import { RAIL_SYSTEM_LABELS, getTransportPresentation, transportTitle } from "../lib/transport";
import { queryTransitRoute, TRANSIT_AI_ERROR } from "../lib/transitAi";
import { zonedDateTimeToIso } from "../lib/tripDates";
import { confirmFlightActual, demoFlightPreview, flightMatchEligibility, matchFlightActual, type FlightMatchPreview } from "../lib/flightLookup";
import { airportLabel, searchAirports, type AirportOption } from "../lib/airports";
import { TIMEZONE_OPTIONS, timeZoneLabel } from "../lib/timezones";
import { normalizeAircraftType, searchAircraftTypes } from "../lib/aircraftTypes";
import { AIRLINES, completeFlightNumber, flightNumberInput, isCompleteFlightNumber, isFlightNumberSuffix, normalizeFlightNumber, resolveAirline, searchAirlines, type AirlineOption } from "../lib/airlines";
import { FlightDurationSummary } from "./FlightDurationSummary";
import { normalizeScheduleDetails, scheduleValidation, shiftScheduleDate, scheduleNights, validScheduleDate } from "../lib/schedules";
import { FlightDetailsView } from "./FlightDetailsView";
import { flightMatchIsCurrent, flightPlanKey, invalidateChangedFlight } from "../lib/flightMatchState";
import { calculateFlightDuration, flightTimeOptions, resolveFlightInstant, utcOffsetLabel } from "../lib/flightDuration";

export type PlanKind = "general" | TransportType | "all_day" | "hotel";

interface EditorProps {
  day: string;
  trip: Trip;
  count: number;
  record?: LifeRecord;
  modal?: boolean;
  isDemo?: boolean;
  initialKind?: PlanKind;
  onSave: (draft: RecordDraft) => Promise<void>;
  onUpdate?: (record: LifeRecord, serverConfirmed?: boolean) => Promise<void>;
  onClose: () => void;
}

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

export function TransportPlanEditor({ day, trip, count, record, modal, isDemo = false, initialKind = "general", onSave, onUpdate, onClose }: EditorProps) {
  const storedSchedule = normalizeScheduleDetails(record?.schedule_details);
  const [kind, setKind] = useState<PlanKind>(storedSchedule?.kind || record?.transport_type || initialKind);
  const [schedule, setSchedule] = useState(storedSchedule || { kind: initialKind === "hotel" ? "hotel" as const : "all_day" as const, start_date: day, end_date: initialKind === "hotel" ? shiftScheduleDate(day, 1) : day, check_in_time: "", check_out_time: "", booking_reference: "" });
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
  const [localChoice, setLocalChoice] = useState<{ key: string; offset?: number }>({ key: "" });
  const localDate = kind === "rail" ? rail.departure.date : day;
  const localTime = kind === "rail" ? rail.departure.time : kind === "metro" ? metro.estimated_departure_time || time : time;
  const localKey = `${localDate}|${localTime}|${trip.timezone}`;
  let localOptions: ReturnType<typeof flightTimeOptions> = [];
  try { if (["general", "rail", "metro"].includes(kind)) localOptions = flightTimeOptions({ date: localDate, time: localTime, timezone: trip.timezone }); } catch { /* Submit reports invalid/nonexistent clocks without changing the draft. */ }
  const originalOption = localOptions.find(option => option.instant === Math.floor(Date.parse(record?.event_at || "") / 60_000) * 60_000);
  const localOffset = localChoice.key === localKey ? localChoice.offset : originalOption?.utcOffsetMinutes;
  const selectedAirline = resolveAirline(flight.airline);
  const fullFlightNumber = completeFlightNumber(flight.flight_number, flight.airline);
  const showAirlinePrefix = selectedAirline && (!flight.flight_number || isFlightNumberSuffix(flight.flight_number) || (isCompleteFlightNumber(fullFlightNumber) && fullFlightNumber.startsWith(selectedAirline.iata)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      let draft: RecordDraft;
      if (kind === "general") {
        draft = { record_type: "trip", content, location, notes, event_at: zonedDateTimeToIso(day, time, trip.timezone, localOffset, record?.event_at), trip_id: trip.id, plan_status: record?.plan_status || "planned", sort_order: record?.sort_order ?? (count + 1) * 1000 };
      } else if (kind === "all_day" || kind === "hotel") {
        const details = { ...schedule, kind };
        const validation = scheduleValidation(details);
        if (validation) throw new Error(validation);
        if (!content.trim()) throw new Error(kind === "hotel" ? "请填写酒店名称" : "请填写事项名称");
        draft = { record_type: "trip", content, location, notes, event_at: storedSchedule?.start_date === details.start_date && record ? record.event_at : zonedDateTimeToIso(details.start_date, "12:00", trip.timezone), trip_id: trip.id, plan_status: record?.plan_status || "planned", sort_order: record?.sort_order ?? (count + 1) * 1000, schedule_details: normalizeScheduleDetails(details)! };
      } else {
        const details: TransportDetails = kind === "flight" ? { ...flight, airline: selectedAirline?.name || flight.airline.trim(), flight_number: fullFlightNumber } : kind === "rail" ? rail : metro;
        if (kind === "flight" && !isCompleteFlightNumber(fullFlightNumber)) throw new Error("请选择已收录的航空公司，或填写带航司代码的完整航班号（例如 NH105）");
        const departureDate = kind === "flight" ? flight.departure.date : kind === "rail" ? rail.departure.date : day;
        const departureTime = kind === "flight" ? flight.departure.time : kind === "rail" ? rail.departure.time : metro.estimated_departure_time || time;
        const eventTimeZone = kind === "flight" ? flight.departure.timezone || trip.timezone : trip.timezone;
        if (kind === "flight" && (!flight.departure.airport.trim() || !flight.arrival.airport.trim())) throw new Error("请填写起飞机场和到达机场名称");
        if (kind === "flight") { const duration = calculateFlightDuration(flight.departure, flight.arrival); if (duration.status !== "ready") throw new Error(duration.message); }
        draft = {
          record_type: "trip", content: transportTitle(kind, details),
          location: kind === "flight" ? `${flight.departure.airport} → ${flight.arrival.airport}` : kind === "rail" ? `${rail.departure.station} → ${rail.arrival.station}` : `${metro.origin} → ${metro.destination}`,
          notes: details.notes, event_at: kind === "flight" ? new Date(resolveFlightInstant(flight.departure)).toISOString() : zonedDateTimeToIso(departureDate, departureTime, eventTimeZone, localOffset, record?.event_at), trip_id: trip.id,
          plan_status: record?.plan_status || "planned", sort_order: record?.sort_order ?? (count + 1) * 1000, transport_type: kind, transport_details: details
        };
      }
      if (record && onUpdate) {
        await onUpdate(invalidateChangedFlight(record, { ...record, content: draft.content.trim(), location: draft.location?.trim() || null, notes: draft.notes?.trim() || null, event_at: draft.event_at || record.event_at, plan_status: draft.plan_status || record.plan_status, sort_order: draft.sort_order ?? record.sort_order, transport_type: draft.transport_type || null, transport_details: draft.transport_details || null, ...(draft.schedule_details ? { schedule_details: draft.schedule_details } : record.schedule_details ? { schedule_details: null } : {}), updated_at: new Date().toISOString() }));
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
    <div className="plan-type-switch" role="tablist" aria-label="计划类型">{([{"value":"general","label":"通用事项","icon":MapPin},{"value":"flight","label":"飞机","icon":Plane},{"value":"rail","label":"高铁 / 铁路","icon":TrainFront},{"value":"metro","label":"市内交通","icon":Route},{"value":"all_day","label":"全天事项","icon":CalendarDays},{"value":"hotel","label":"酒店住宿","icon":BedDouble}] as const).map((item) => { const Icon = item.icon; return <button type="button" role="tab" aria-selected={kind === item.value} className={kind === item.value ? "active" : ""} onClick={() => { setKind(item.value); if (item.value === "hotel" && (!validScheduleDate(schedule.start_date) || schedule.end_date <= schedule.start_date)) { const start = validScheduleDate(schedule.start_date) ? schedule.start_date : day; setSchedule({ ...schedule, start_date: start, end_date: shiftScheduleDate(start, 1) }); } }} key={item.value}><Icon size={15} />{item.label}</button>; })}</div>

    {kind === "general" && <div className="transport-fields"><label className="field-span-2">事项名称<input autoFocus value={content} onChange={(event) => setContent(event.target.value)} placeholder="地点或事项名称" required /></label><label>时间<input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label><label>地点 <span className="optional-tag">选填</span><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="例如 酒店大堂" /></label><label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label></div>}

    {(kind === "all_day" || kind === "hotel") && <div className="transport-fields">
      <p className="field-help field-span-2">日期按行程时区 {timeZoneLabel(trip.timezone)} 记录。跨日安排只保存一条，修改会同步到所有展示日期。</p>
      <label className="field-span-2">{kind === "hotel" ? "酒店名称" : "事项名称"}<input autoFocus value={content} onChange={(event) => setContent(event.target.value)} placeholder={kind === "hotel" ? "例如 东京浅草酒店" : "例如 全天游园"} required /></label>
      <label>{kind === "hotel" ? "入住日期" : "开始日期"}<input type="date" value={schedule.start_date} onChange={(event) => setSchedule({ ...schedule, start_date: event.target.value })} required /></label>
      <label>{kind === "hotel" ? "退房日期" : "结束日期（含当天）"}<input type="date" min={kind === "hotel" && schedule.start_date ? shiftScheduleDate(schedule.start_date, 1) : schedule.start_date} value={schedule.end_date} onChange={(event) => setSchedule({ ...schedule, end_date: event.target.value })} required /></label>
      {kind === "hotel" && <><label>入住时间 <span className="optional-tag">选填</span><input type="time" value={schedule.check_in_time || ""} onChange={(event) => setSchedule({ ...schedule, check_in_time: event.target.value })} /></label><label>退房时间 <span className="optional-tag">选填</span><input type="time" value={schedule.check_out_time || ""} onChange={(event) => setSchedule({ ...schedule, check_out_time: event.target.value })} /></label><p className="field-help field-span-2">{validScheduleDate(schedule.start_date) && validScheduleDate(schedule.end_date) && schedule.end_date > schedule.start_date ? `共 ${scheduleNights(schedule)} 晚；退房日会显示退房提醒，不计入连住夜晚。` : "请填写有效日期，并将退房日期设在入住日期之后。"}</p><label className="field-span-2">预订号 <span className="optional-tag">选填</span><input value={schedule.booking_reference || ""} onChange={(event) => setSchedule({ ...schedule, booking_reference: event.target.value })} /></label></>}
      <label className="field-span-2">{kind === "hotel" ? "酒店地址" : "地点"} <span className="optional-tag">选填</span><input value={location} onChange={(event) => setLocation(event.target.value)} /></label>
      <label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    </div>}

    {kind === "flight" && <div className="transport-fields">
      <div className="flight-planning-note field-span-2"><Plane size={16} /><p><b>先填写计划信息</b><span>未来航班不调用接口。保存后前往“行程规划”，展开航班详情即可查看“匹配实际飞行信息”；按钮仅在计划到达 1 小时后至 48 小时内显示，其他时间可手动补充。</span></p></div>
      <AirlineField value={flight.airline} onChange={(airline) => setFlight({ ...flight, airline })} />
      <div><label>航班号<div className="flight-number-input">{showAirlinePrefix && <span aria-hidden="true">{selectedAirline.iata}</span>}<input aria-label="航班号" value={flightNumberInput(flight.flight_number, flight.airline)} onChange={(event) => setFlight({ ...flight, flight_number: normalizeFlightNumber(event.target.value) })} placeholder={selectedAirline ? "例如 105" : "例如 NH105"} required /></div></label><p className="field-help">{selectedAirline ? isCompleteFlightNumber(fullFlightNumber) ? `完整航班号：${fullFlightNumber}${fullFlightNumber.startsWith(selectedAirline.iata) ? "" : "；与所选航司代码不同，请核对是否为代码共享航班"}` : `已匹配 ${selectedAirline.iata}，只需填写数字部分；也可粘贴完整航班号。` : "选择航司后自动补全代码；未收录的航司请填写完整航班号。"}</p></div>
      <FlightStopEditor legend="起飞信息 · 当地时间" stop={flight.departure} onChange={(departure) => setFlight({ ...flight, departure })} />
      <FlightStopEditor legend="降落信息 · 当地时间" stop={flight.arrival} onChange={(arrival) => setFlight({ ...flight, arrival })} />
      {(!flight.departure.iata || !flight.arrival.iata) && <p className="field-help field-span-2">未收录机场可按名称和当地时区手动保存。自动匹配另需从候选列表选择正确机场，不能选择其他机场代替。</p>}
      <FlightDurationSummary details={flight} />
      <label>登机口 <span className="optional-tag">选填</span><input value={flight.gate || ""} onChange={(event) => setFlight({ ...flight, gate: event.target.value })} /></label>
      <label>座位号 <span className="optional-tag">选填</span><input value={flight.seat || ""} onChange={(event) => setFlight({ ...flight, seat: event.target.value })} /></label>
      <label>注册号 <span className="optional-tag">选填</span><input value={flight.registration || ""} onChange={(event) => setFlight({ ...flight, registration: event.target.value.toUpperCase() })} /></label>
      <AircraftTypeField value={flight.aircraft_type || ""} onChange={(aircraftType) => setFlight({ ...flight, aircraft_type: aircraftType })} />
      <label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={flight.notes || ""} onChange={(event) => setFlight({ ...flight, notes: event.target.value })} /></label>
    </div>}

    {kind === "rail" && <div className="transport-fields"><label>铁路系统<select value={rail.system_type} onChange={(event) => setRail({ ...rail, system_type: event.target.value as RailSystemType })}>{Object.entries(RAIL_SYSTEM_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>车次号<input value={rail.train_number} onChange={(event) => setRail({ ...rail, train_number: event.target.value })} required /></label>{rail.system_type === "other" && <label className="field-span-2">铁路系统名称<input value={rail.custom_system || ""} onChange={(event) => setRail({ ...rail, custom_system: event.target.value })} required /></label>}<RailStop legend="出发信息" value={rail.departure} onChange={(departure) => setRail({ ...rail, departure })} stationLabel="出发站" /><RailStop legend="到达信息" value={rail.arrival} onChange={(arrival) => setRail({ ...rail, arrival })} stationLabel="到达站" /><label className="field-span-2">座位 / 车厢 <span className="optional-tag">选填</span><input value={rail.seat_carriage || ""} onChange={(event) => setRail({ ...rail, seat_carriage: event.target.value })} /></label><label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={rail.notes || ""} onChange={(event) => setRail({ ...rail, notes: event.target.value })} /></label></div>}

    {kind === "metro" && <div className="transport-fields"><label>出发点<input value={metro.origin} onChange={(event) => setMetro({ ...metro, origin: event.target.value })} required /></label><label>到达点<input value={metro.destination} onChange={(event) => setMetro({ ...metro, destination: event.target.value })} required /></label><label>预计出发时间 <span className="optional-tag">选填</span><input type="time" value={metro.estimated_departure_time || ""} onChange={(event) => setMetro({ ...metro, estimated_departure_time: event.target.value })} /></label><label>预计到达时间 <span className="optional-tag">选填</span><input type="time" value={metro.estimated_arrival_time || ""} onChange={(event) => setMetro({ ...metro, estimated_arrival_time: event.target.value })} /></label><label className="field-span-2 route-description-field"><span>换乘线路 / 路线说明 <span className="optional-tag">选填</span><button type="button" className="ai-route-button" disabled={!metro.origin.trim() || !metro.destination.trim()} onClick={() => setShowAi(true)}><Sparkles size={14} />AI 帮我查</button></span><textarea rows={5} value={metro.route_description || ""} onChange={(event) => setMetro({ ...metro, route_description: event.target.value })} /></label><label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={metro.notes || ""} onChange={(event) => setMetro({ ...metro, notes: event.target.value })} /></label></div>}
    {localOptions.length > 1 && <label>重复当地时间 · 必选<select value={localOffset ?? ""} required onChange={event => setLocalChoice({ key: localKey, offset: event.target.value === "" ? undefined : Number(event.target.value) })}><option value="" disabled>请选择第一次或第二次</option>{localOptions.map((option, index) => <option key={option.utcOffsetMinutes} value={option.utcOffsetMinutes}>{index === 0 ? "第一次" : "第二次"} · {utcOffsetLabel(option.utcOffsetMinutes)}</option>)}</select><small className="field-help">夏令时结束时同一当地时间出现两次。已有计划保留原选择；修改日期或时间后请重新核对。</small></label>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <footer className="transport-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? "保存中…" : record ? "保存修改" : "添加计划"}</button></footer>
    {showAi && <TransitAiDialog metro={metro} isDemo={isDemo} onClose={() => setShowAi(false)} onFill={(route) => { setMetro({ ...metro, route_description: route }); setShowAi(false); }} />}
  </form>;
  return modal ? <div className="modal-backdrop">{form}</div> : form;
}

function AirlineField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const options = searchAirlines(value);
  function select(airline: AirlineOption) { onChange(airline.name); setFocused(false); setActive(-1); }
  return <label className="airline-autocomplete">航空公司<input aria-label="航空公司" role="combobox" aria-autocomplete="list" aria-expanded={focused && options.length > 0} aria-controls={listId} aria-activedescendant={focused && options[active] ? `${listId}-${active}` : undefined} value={value} onChange={(event) => { onChange(event.target.value); setFocused(true); setActive(-1); }} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); setActive(-1); }} onKeyDown={(event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length > 0) { event.preventDefault(); setFocused(true); setActive((current) => event.key === "ArrowDown" ? Math.min(current + 1, options.length - 1) : Math.max(current - 1, 0)); }
    else if (event.key === "Enter" && focused && active >= 0 && options[active]) { event.preventDefault(); select(options[active]); }
    else if (event.key === "Escape") { event.preventDefault(); setFocused(false); setActive(-1); }
  }} placeholder="搜索中文、英文、简称或代码；也可自行输入" autoComplete="off" required /><span className="field-help">已收录 {AIRLINES.length} 家常用航司，输入关键词查看更多候选。</span>{focused && options.length > 0 && <div className="airline-options" id={listId} role="listbox" aria-label="航空公司候选">{options.map((airline, index) => <button type="button" role="option" aria-selected={active === index} id={`${listId}-${index}`} key={airline.iata} ref={(element) => { if (active === index) element?.scrollIntoView({ block: "nearest" }); }} onMouseDown={(event) => event.preventDefault()} onClick={() => select(airline)}><b>{airline.iata}</b><span>{airline.name}<small>{airline.nameEn}</small></span></button>)}</div>}</label>;
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
    onChange({ ...stop, airport: airportLabel(airport), iata: airport.iata, timezone: airport.timezone, utc_offset_minutes: airport.timezone === stop.timezone ? stop.utc_offset_minutes : undefined });
  }
  const occurrences = (() => { try { return flightTimeOptions(stop); } catch { return []; } })();
  return <fieldset className="transport-stop field-span-2"><legend>{legend}</legend><div><label>日期<input type="date" value={stop.date} onChange={(event) => onChange({ ...stop, date: event.target.value, utc_offset_minutes: undefined })} required /></label><label>时间<input type="time" value={stop.time} onChange={(event) => onChange({ ...stop, time: event.target.value, utc_offset_minutes: undefined })} required /></label><label className="airport-autocomplete">机场<input value={query} onChange={(event) => { setQuery(event.target.value); onChange({ ...stop, airport: event.target.value, iata: "" }); }} placeholder="输入羽田、HND、Tokyo…" autoComplete="off" required />{options.length > 0 && <div className="airport-options">{options.map((airport) => <button type="button" key={airport.iata} onClick={() => select(airport)}><b>{airport.iata}</b><span>{airport.nameZh}<small>{airport.city} · {airport.nameEn}</small></span></button>)}</div>}</label><label>航站楼 <span className="optional-tag">选填</span><input value={stop.terminal} onChange={(event) => onChange({ ...stop, terminal: event.target.value })} /></label><label className="flight-timezone-field">当地时区<select value={stop.timezone || "Asia/Shanghai"} onChange={(event) => onChange({ ...stop, timezone: event.target.value, utc_offset_minutes: undefined })} required>{TIMEZONE_OPTIONS.map((timezone) => <option value={timezone} key={timezone}>{timeZoneLabel(timezone)}</option>)}</select></label>{occurrences.length > 1 && <label className="flight-timezone-field">重复当地时间 · 必选<select value={occurrences.some(option => option.utcOffsetMinutes === stop.utc_offset_minutes) ? stop.utc_offset_minutes : ""} onChange={event => onChange({ ...stop, utc_offset_minutes: event.target.value === "" ? undefined : Number(event.target.value) })} required><option value="" disabled>请选择第一次或第二次</option>{occurrences.map((option, index) => <option key={option.utcOffsetMinutes} value={option.utcOffsetMinutes}>{index === 0 ? "第一次" : "第二次"} · {utcOffsetLabel(option.utcOffsetMinutes)}</option>)}</select><small className="field-help">当地夏令时结束，同一个时间会出现两次。请按机票标注的偏移选择。</small></label>}</div></fieldset>;
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

export function TransportDetailsPanel({ record, isDemo = false, onUpdate, onEdit }: { record: LifeRecord; isDemo?: boolean; onUpdate: (record: LifeRecord, serverConfirmed?: boolean) => Promise<void>; onEdit: () => void }) {
  const [gate, setGate] = useState(record.transport_type === "flight" ? (record.transport_details as FlightDetails).gate || "" : "");
  const [savingGate, setSavingGate] = useState(false);
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState("");
  const [preview, setPreview] = useState<FlightMatchPreview | null>(null);
  if (!record.transport_type || !record.transport_details) return <button className="edit-plan-button" onClick={onEdit}>编辑事项信息</button>;
  const presentation = getTransportPresentation(record);

  async function saveGate() {
    if (record.transport_type !== "flight") return;
    setSavingGate(true); setMatchError("");
    try { await onUpdate({ ...record, transport_details: { ...(record.transport_details as FlightDetails), gate: gate.trim() || undefined }, updated_at: new Date().toISOString() }); }
    catch (error) { setMatchError(error instanceof Error ? error.message : "登机口保存失败，输入内容已保留。"); }
    finally { setSavingGate(false); }
  }
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
      if (preview.planKey !== flightPlanKey(record) || preview.planVersion !== (record.flight_plan_version ?? 1)) throw new Error("航班计划已修改，这份预览不再适用。请先核对并保存最新计划。");
      if (isDemo) await onUpdate({ ...record, actual_match_status: "matched", actual_info: preview.preview, actual_info_matched: true, flight_plan_version: preview.planVersion, actual_match_plan_version: preview.planVersion, actual_confirmed_request_id: preview.requestId, actual_matched_at: preview.preview.matched_at || new Date().toISOString(), actual_match_provider: "aviationstack", actual_match_request_id: preview.requestId, updated_at: new Date().toISOString() });
      else await onUpdate(await confirmFlightActual(record.id, preview.requestId, preview.planVersion, preview.recoveryToken), true);
      setPreview(null);
    } catch (error) { setMatchError(error instanceof Error ? error.message : "保存失败"); }
    finally { setMatching(false); }
  }
  const eligibility = flightMatchEligibility(record);
  const matched = flightMatchIsCurrent(record);

  return <section className="transport-details-panel"><div className="transport-details-heading"><div><span>{presentation.label}</span><strong>{presentation.title}</strong></div><button className="edit-plan-button" onClick={onEdit}>编辑完整信息</button></div>
    {record.transport_type === "flight" && (() => {
      const details = record.transport_details as FlightDetails;
      const actual = matched ? record.actual_info : null;
      const gateEditor = <div className="gate-editor"><label>{matched ? "手动登机口（原计划）" : "登机口"}<input value={gate} onChange={(event) => setGate(event.target.value)} placeholder="尚未公布" /></label><button className="secondary-button" disabled={savingGate || gate === (details.gate || "")} onClick={() => void saveGate()}>{savingGate ? "保存中…" : "更新登机口"}</button></div>;
      return <>
        <FlightDetailsView record={record} />
        {record.actual_info_matched && actual ? <details className="flight-original-plan"><summary>查看原计划与修改登机口</summary><FlightDetailsView record={record} original />{gateEditor}</details> : gateEditor}
        <div className="flight-match-card">{record.actual_info_matched && actual ? <><div className="match-success"><Check size={16} /><span><b>实际飞行信息已匹配</b><small>原计划完整保留；打开页面不会重复查询</small></span></div><details className="flight-provider-details"><summary>查看接口返回详情</summary><ActualFlightSummary actual={actual} /></details><button className="text-button" disabled={matching} onClick={() => void runMatch(true)}>重新匹配</button></> : <><div><b>实际飞行信息</b><p>{eligibility.reason}</p>{(record.actual_match_status === "not_found" || record.actual_match_status === "failed") && <small>上次没有保存匹配结果；再次尝试会使用一次航班额度。</small>}</div>{eligibility.eligible && <button className="secondary-button" disabled={matching} onClick={() => void runMatch(record.actual_match_status === "not_found" || record.actual_match_status === "failed")}>{matching ? <LoaderCircle className="spin" size={15} /> : <Plane size={15} />}{matching ? "正在匹配…" : record.actual_match_status === "not_found" || record.actual_match_status === "failed" ? "重新匹配" : "匹配实际飞行信息"}</button>}</>}{matchError && <p className="field-error">{matchError}</p>}</div>
      </>;
    })()}
    {record.transport_type === "rail" && (() => { const details = record.transport_details as RailDetails; return <><div className="transport-route-grid"><div><small>出发</small><b>{details.departure.station}</b><span>{details.departure.date} · {details.departure.time}</span></div><TrainFront size={18} /><div><small>到达</small><b>{details.arrival.station}</b><span>{details.arrival.date} · {details.arrival.time}</span></div></div></>; })()}
    {record.transport_type === "metro" && (() => { const details = record.transport_details as MetroDetails; return <><div className="transport-route-grid metro"><div><small>出发点</small><b>{details.origin}</b></div><Route size={18} /><div><small>到达点</small><b>{details.destination}</b></div></div>{details.route_description && <div className="route-description-preview"><CalendarClock size={16} /><p>{details.route_description}</p></div>}</>; })()}
    {preview && <FlightPreviewDialog plan={record.transport_details as FlightDetails} actual={preview.preview} warning={preview.warning} loading={matching} onClose={() => setPreview(null)} onConfirm={() => void confirmPreview()} />}
  </section>;
}

function ActualFlightSummary({ actual }: { actual: ActualFlightInfo }) {
  return <div className="actual-flight-summary"><span>状态 <b>{actual.status || "已完成"}</b></span><span>实际起飞 <b>{actual.departure.actual.date || actual.departure.estimated.date} {actual.departure.actual.time || actual.departure.estimated.time}</b></span><span>实际到达 <b>{actual.arrival.actual.date || actual.arrival.estimated.date} {actual.arrival.actual.time || actual.arrival.estimated.time}</b></span>{actual.arrival.delay_minutes > 0 && <span>到达延误 <b>{actual.arrival.delay_minutes} 分钟</b></span>}{actual.aircraft_type && <span>实际机型 <b>{actual.aircraft_type}</b></span>}</div>;
}

function FlightPreviewDialog({ plan, actual, warning, loading, onClose, onConfirm }: { plan: FlightDetails; actual: ActualFlightInfo; warning?: string; loading: boolean; onClose: () => void; onConfirm: () => void }) {
  return <div className="nested-modal-backdrop"><section className="modal-card glass-card flight-lookup-modal"><header><div><p className="eyebrow">计划 vs 实际</p><h2>确认实际飞行信息</h2></div><button className="icon-button" onClick={onClose}><X /></button></header><p className="flight-lookup-intro">先核对差异，再决定是否保存。原计划会完整保留。</p>{warning && <p className="field-error" role="alert">{warning}</p>}<div className="flight-compare-grid"><article><b>计划</b><span>起飞 {plan.departure.date} {plan.departure.time}</span><span>到达 {plan.arrival.date} {plan.arrival.time}</span><span>登机口 {plan.gate || "未填写"}</span><span>机型 {plan.aircraft_type || "未填写"}</span></article><article><b>实际</b><span>起飞 {actual.departure.actual.date || actual.departure.estimated.date} {actual.departure.actual.time || actual.departure.estimated.time}</span><span>到达 {actual.arrival.actual.date || actual.arrival.estimated.date} {actual.arrival.actual.time || actual.arrival.estimated.time}</span><span>登机口 {actual.departure.gate || "未提供"}</span><span>机型 {actual.aircraft_type || "未提供"}</span></article></div><footer><button className="secondary-button" onClick={onClose}>保留计划</button><button className="primary-button" disabled={loading} onClick={onConfirm}>{loading ? "保存中…" : "确认保存实际信息"}</button></footer></section></div>;
}
