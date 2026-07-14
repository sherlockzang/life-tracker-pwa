import { useMemo, useState, type FormEvent } from "react";
import { ArrowRight, CalendarDays, Clock3, LoaderCircle, MapPin, Route, Save, Sparkles, X } from "lucide-react";
import type { LifeRecord, MetroDetails, RecordDraft, Trip } from "../types";
import { queryTransitRoute, TRANSIT_AI_ERROR } from "../lib/transitAi";
import { transportTitle } from "../lib/transport";
import { dateInZone, zonedDateTimeToIso } from "../lib/tripDates";

interface Props {
  trips: Trip[];
  records: LifeRecord[];
  isDemo: boolean;
  onSave: (draft: RecordDraft) => Promise<void>;
}

function localToday(trip: Trip) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: trip.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function defaultDate(trip: Trip) {
  const today = localToday(trip);
  if (today < trip.start_date) return trip.start_date;
  if (today > trip.end_date) return trip.end_date;
  return today;
}

function currentTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function HomeRouteSearch({ trips, records, isDemo, onSave }: Props) {
  const availableTrips = useMemo(() => trips.filter((trip) => !trip.archived_at && trip.end_date >= localToday(trip)).sort((left, right) => left.start_date.localeCompare(right.start_date)), [trips]);
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [tripId, setTripId] = useState(availableTrips[0]?.id || "");
  const initialTrip = availableTrips.find((trip) => trip.id === tripId) || availableTrips[0];
  const [planDate, setPlanDate] = useState(initialTrip ? defaultDate(initialTrip) : "");
  const [planTime, setPlanTime] = useState(currentTime());

  function close() {
    setOpen(false);
    setOrigin("");
    setDestination("");
    setResult("");
    setError("");
    setShowSave(false);
  }

  function chooseTrip(nextId: string) {
    setTripId(nextId);
    const trip = availableTrips.find((item) => item.id === nextId);
    if (trip) setPlanDate(defaultDate(trip));
  }

  async function query(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setResult("");
    setShowSave(false);
    try {
      setResult(await queryTransitRoute(origin, destination, `请规划从“${origin.trim()}”到“${destination.trim()}”的实用路线。`, undefined, isDemo));
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : TRANSIT_AI_ERROR);
    } finally {
      setLoading(false);
    }
  }

  async function saveRoute() {
    const trip = availableTrips.find((item) => item.id === tripId);
    if (!trip || !result || !planDate || !planTime) return;
    setSaving(true);
    setError("");
    try {
      const details: MetroDetails = { origin: origin.trim(), destination: destination.trim(), estimated_departure_time: planTime, route_description: result };
      const sameDayCount = records.filter((record) => record.trip_id === trip.id && record.record_type === "trip" && dateInZone(record.event_at, trip.timezone) === planDate).length;
      await onSave({
        record_type: "trip",
        content: transportTitle("metro", details),
        location: `${details.origin} → ${details.destination}`,
        event_at: zonedDateTimeToIso(planDate, planTime, trip.timezone),
        trip_id: trip.id,
        plan_status: "planned",
        sort_order: (sameDayCount + 1) * 1000,
        transport_type: "metro",
        transport_details: details
      });
      close();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "路线保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  const selectedTrip = availableTrips.find((trip) => trip.id === tripId);

  return <>
    <button className="home-route-entry glass-card" type="button" onClick={() => setOpen(true)}><span><Route size={21} /></span><div><b>AI 路线查询</b><small>不用先建行程，随时问两地之间怎么走</small></div><ArrowRight size={18} /></button>
    {open && <div className="modal-backdrop"><section className="modal-card glass-card home-route-modal" role="dialog" aria-modal="true" aria-labelledby="home-route-title"><header><div><p className="eyebrow">快速路线</p><h2 id="home-route-title">从哪里，到哪里？</h2></div><button className="icon-button" type="button" aria-label="关闭路线查询" onClick={close}><X /></button></header>
      <form className="home-route-query" onSubmit={query}><label><span><MapPin size={14} />出发地</span><input autoFocus value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="例如 UCSB 加大圣塔芭芭拉分校" maxLength={120} required /></label><label><span><Route size={14} />目的地</span><input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="例如 洛杉矶机场" maxLength={120} required /></label><button className="primary-button" disabled={loading || !origin.trim() || !destination.trim()}>{loading ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{loading ? "正在规划…" : "查询路线"}</button></form>
      {error && <p className="field-error" role="alert">{error}</p>}
      {result && <div className="home-route-result"><div><Sparkles size={17} /><b>路线建议</b></div><p>{result}</p><small>AI 结果仅供规划参考，请以当地实时交通信息为准。</small></div>}
      {result && showSave && availableTrips.length > 0 && <div className="home-route-save"><label>保存到行程<select value={tripId} onChange={(event) => chooseTrip(event.target.value)}>{availableTrips.map((trip) => <option value={trip.id} key={trip.id}>{trip.name} · {trip.destination}</option>)}</select></label><div><label><span><CalendarDays size={14} />日期</span><input type="date" min={selectedTrip?.start_date} max={selectedTrip?.end_date} value={planDate} onChange={(event) => setPlanDate(event.target.value)} required /></label><label><span><Clock3 size={14} />时间</span><input type="time" value={planTime} onChange={(event) => setPlanTime(event.target.value)} required /></label></div><button className="primary-button" type="button" disabled={saving || !tripId || !planDate || !planTime} onClick={() => void saveRoute()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saving ? "正在保存…" : "保存为行程计划"}</button></div>}
      {result && <footer className="home-route-actions"><button className="secondary-button" type="button" onClick={close}>仅供参考，不保存</button>{availableTrips.length > 0 ? !showSave && <button className="primary-button" type="button" onClick={() => setShowSave(true)}><Save size={16} />保存到某个行程</button> : <small>当前没有进行中或未来的行程，本次结果可以直接参考。</small>}</footer>}
    </section></div>}
  </>;
}
