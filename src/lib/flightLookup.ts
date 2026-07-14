import { supabase } from "./supabase";

export interface FlightLookupStop {
  airport: string;
  date: string;
  time: string;
  timezone: string;
  terminal: string;
  gate: string;
}

export interface FlightLookupCandidate {
  id: string;
  airline: string;
  flight_number: string;
  status: string;
  departure: FlightLookupStop;
  arrival: FlightLookupStop;
  registration: string;
  aircraft_type: string;
}

export const FLIGHT_LOOKUP_ERROR = "暂时无法获取航班信息，请稍后重试或手动填写";

export async function lookupFlight(flightNumber: string, departureDate?: string) {
  const { data, error } = await supabase.functions.invoke("lookup-flight", {
    body: { flightNumber: flightNumber.trim().replaceAll(" ", "").toUpperCase(), departureDate }
  });
  if (error) throw error;
  const flights = data?.data?.flights;
  if (!Array.isArray(flights)) throw new Error(FLIGHT_LOOKUP_ERROR);
  return flights as FlightLookupCandidate[];
}
