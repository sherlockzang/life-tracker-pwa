import type { FlightDetails, LifeRecord, MetroDetails, RailDetails, RailSystemType, TransportDetails, TransportType } from "../types";
import { normalizeAircraftType } from "./aircraftTypes";

export const RAIL_SYSTEM_LABELS: Record<RailSystemType, string> = {
  china_hsr: "中国高铁",
  japan_shinkansen: "日本新干线",
  germany_db: "德国 DB",
  taiwan_hsr: "台湾高铁",
  other: "其他"
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const stringValue = (value: unknown) => typeof value === "string" ? value : "";

export function isTransportType(value: unknown): value is TransportType {
  return value === "flight" || value === "rail" || value === "metro";
}

export function normalizeTransportDetails(type: TransportType, value: unknown): TransportDetails | null {
  if (!isObject(value)) return null;
  if (type === "flight") {
    const departure = isObject(value.departure) ? value.departure : {};
    const arrival = isObject(value.arrival) ? value.arrival : {};
    return {
      airline: stringValue(value.airline),
      flight_number: stringValue(value.flight_number),
      departure: { date: stringValue(departure.date), time: stringValue(departure.time), airport: stringValue(departure.airport), iata: stringValue(departure.iata) || undefined, terminal: stringValue(departure.terminal), timezone: stringValue(departure.timezone) || undefined },
      arrival: { date: stringValue(arrival.date), time: stringValue(arrival.time), airport: stringValue(arrival.airport), iata: stringValue(arrival.iata) || undefined, terminal: stringValue(arrival.terminal), timezone: stringValue(arrival.timezone) || undefined },
      gate: stringValue(value.gate) || undefined,
      registration: stringValue(value.registration) || undefined,
      seat: stringValue(value.seat) || undefined,
      aircraft_type: normalizeAircraftType(stringValue(value.aircraft_type)) || undefined,
      notes: stringValue(value.notes) || undefined
    } satisfies FlightDetails;
  }
  if (type === "rail") {
    const departure = isObject(value.departure) ? value.departure : {};
    const arrival = isObject(value.arrival) ? value.arrival : {};
    const systemType = value.system_type;
    return {
      system_type: systemType === "china_hsr" || systemType === "japan_shinkansen" || systemType === "germany_db" || systemType === "taiwan_hsr" || systemType === "other" ? systemType : "other",
      custom_system: stringValue(value.custom_system) || undefined,
      train_number: stringValue(value.train_number),
      departure: { date: stringValue(departure.date), time: stringValue(departure.time), station: stringValue(departure.station) },
      arrival: { date: stringValue(arrival.date), time: stringValue(arrival.time), station: stringValue(arrival.station) },
      seat_carriage: stringValue(value.seat_carriage) || undefined,
      notes: stringValue(value.notes) || undefined
    } satisfies RailDetails;
  }
  return {
    origin: stringValue(value.origin),
    destination: stringValue(value.destination),
    estimated_departure_time: stringValue(value.estimated_departure_time) || undefined,
    estimated_arrival_time: stringValue(value.estimated_arrival_time) || undefined,
    route_description: stringValue(value.route_description) || undefined,
    notes: stringValue(value.notes) || undefined
  } satisfies MetroDetails;
}

export function normalizeTransport(valueType: unknown, valueDetails: unknown) {
  if (!isTransportType(valueType)) return { transport_type: null, transport_details: null } as const;
  const details = normalizeTransportDetails(valueType, valueDetails);
  return details ? { transport_type: valueType, transport_details: details } : { transport_type: null, transport_details: null } as const;
}

function compactAirport(value: string) {
  const match = value.trim().match(/(?:^|[\s(])([A-Z]{3,4})\)?$/);
  return match?.[1] || value.trim();
}

export function transportTitle(type: TransportType, details: TransportDetails) {
  if (type === "flight") {
    const flight = details as FlightDetails;
    return `${flight.flight_number || "航班"} · ${compactAirport(flight.departure.airport)}→${compactAirport(flight.arrival.airport)}`;
  }
  if (type === "rail") {
    const rail = details as RailDetails;
    return `${rail.train_number || "列车"} · ${rail.departure.station}→${rail.arrival.station}`;
  }
  const metro = details as MetroDetails;
  return `${metro.origin}→${metro.destination}`;
}

export function getTransportPresentation(record: LifeRecord) {
  if (!record.transport_type || !record.transport_details) {
    return { title: record.content, subtitle: record.notes || "", label: "通用事项" };
  }
  if (record.transport_type === "flight") {
    const details = record.transport_details as FlightDetails;
    return {
      title: transportTitle("flight", details),
      subtitle: [details.airline, details.gate ? `登机口 ${details.gate}` : "", details.seat ? `座位 ${details.seat}` : ""].filter(Boolean).join(" · "),
      label: "飞机"
    };
  }
  if (record.transport_type === "rail") {
    const details = record.transport_details as RailDetails;
    const system = details.system_type === "other" ? details.custom_system || "铁路" : RAIL_SYSTEM_LABELS[details.system_type];
    return {
      title: transportTitle("rail", details),
      subtitle: [system, details.seat_carriage || ""].filter(Boolean).join(" · "),
      label: "铁路"
    };
  }
  const details = record.transport_details as MetroDetails;
  return {
    title: transportTitle("metro", details),
    subtitle: details.route_description || details.notes || "",
    label: "市内交通"
  };
}
