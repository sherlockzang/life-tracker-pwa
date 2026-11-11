import { Route } from "lucide-react";
import type { LifeRecord } from "../types";
import { flightDisplay, flightStatusLabel, FLIGHT_CLOCK_LABELS } from "../lib/flightDisplay";
import { FlightDurationSummary } from "./FlightDurationSummary";
import { utcOffsetLabel } from "../lib/flightDuration";

export function FlightDetailsView({ record, original = false }: { record: LifeRecord; original?: boolean }) {
  const view = flightDisplay(original ? { ...record, actual_info_matched: false } : record);
  if (!view) return null;
  const { details, actual } = view;
  return <div className="flight-current-view">
    {view.matched && <div className="flight-view-status"><b>{flightStatusLabel(actual!.status)}</b><span>优先显示已匹配信息，缺失项保留计划值</span></div>}
    <FlightDurationSummary details={details} label={view.durationLabel} description={view.durationDescription} />
    <div className="transport-route-grid">
      <div><small>{view.matched ? FLIGHT_CLOCK_LABELS[view.departureSource] : "计划"}起飞 · 当地时间</small><b>{details.departure.airport}</b><span>{details.departure.date} · {details.departure.time}{details.departure.terminal && ` · 航站楼 ${details.departure.terminal}${view.matched && !actual?.departure.terminal ? "（计划值）" : ""}`}</span><i>{details.departure.timezone}{details.departure.utc_offset_minutes != null && ` · ${utcOffsetLabel(details.departure.utc_offset_minutes)}`}</i></div>
      <Route size={18} />
      <div><small>{view.matched ? FLIGHT_CLOCK_LABELS[view.arrivalSource] : "计划"}降落 · 当地时间</small><b>{details.arrival.airport}</b><span>{details.arrival.date} · {details.arrival.time}{details.arrival.terminal && ` · 航站楼 ${details.arrival.terminal}${view.matched && !actual?.arrival.terminal ? "（计划值）" : ""}`}</span><i>{details.arrival.timezone}{details.arrival.utc_offset_minutes != null && ` · ${utcOffsetLabel(details.arrival.utc_offset_minutes)}`}</i></div>
    </div>
    <div className="transport-facts">
      {details.airline && <span>航空公司 <b>{details.airline}</b></span>}
      {details.gate && <span>登机口 <b>{details.gate}</b>{view.matched && <small>{actual?.departure.gate ? "接口" : "计划值"}</small>}</span>}
      {details.seat && <span>座位 <b>{details.seat}</b><small>手动记录</small></span>}
      {details.aircraft_type && <span>机型 <b>{details.aircraft_type}</b>{view.matched && <small>{actual?.aircraft_type ? "接口" : "计划值"}</small>}</span>}
      {details.registration && <span>注册号 <b>{details.registration}</b>{view.matched && <small>{actual?.registration ? "接口" : "计划值"}</small>}</span>}
      {actual && actual.arrival.delay_minutes > 0 && <span>到达延误 <b>{actual.arrival.delay_minutes} 分钟</b></span>}
    </div>
    {details.notes && <p className="flight-record-notes">{details.notes}</p>}
  </div>;
}
