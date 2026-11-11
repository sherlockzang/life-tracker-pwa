import { Clock3 } from "lucide-react";
import type { FlightDetails } from "../types";
import { calculateFlightDuration } from "../lib/flightDuration";

export function FlightDurationSummary({ details, label = "计划飞行时长", description }: { details: FlightDetails; label?: string; description?: string }) {
  const duration = calculateFlightDuration(details.departure, details.arrival);
  return <div className={`flight-duration-summary field-span-2 ${duration.status}`} role="status" aria-live="polite"><Clock3 size={17} /><div><b>{label}{duration.status === "ready" && <strong>{duration.label}</strong>}</b><p>{duration.status === "ready" ? description || "按两地当地时间及时区换算，自动处理跨日与时差；计划用时不等于实际空中飞行时间。" : duration.message}</p></div></div>;
}
