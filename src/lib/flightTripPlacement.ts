import type { FlightDetails, Trip } from "../types";
import { calculateFlightDuration, resolveFlightInstant } from "./flightDuration";
import { dateInZone } from "./tripDates";

type TripWindow = Pick<Trip, "start_date" | "end_date" | "timezone">;

// A flight belongs to any trip day its time interval overlaps, in the trip's
// timezone. Display it once, on departure day or the first overlapping trip day.
export function flightTripPlacement(flight: FlightDetails, trip: TripWindow) {
  const fallback = { day: flight.departure.date, departureDay: flight.departure.date, arrivalDay: flight.arrival.date, overlapsTrip: flight.departure.date >= trip.start_date && flight.departure.date <= trip.end_date, startsBeforeTrip: false };
  const departure = { ...flight.departure, timezone: flight.departure.timezone || trip.timezone };
  const arrival = { ...flight.arrival, timezone: flight.arrival.timezone || trip.timezone };
  if (calculateFlightDuration(departure, arrival).status !== "ready") return fallback;
  try {
    const departureDay = dateInZone(new Date(resolveFlightInstant(departure)).toISOString(), trip.timezone);
    const arrivalDay = dateInZone(new Date(resolveFlightInstant(arrival)).toISOString(), trip.timezone);
    const overlapsTrip = departureDay <= trip.end_date && arrivalDay >= trip.start_date;
    const startsBeforeTrip = overlapsTrip && departureDay < trip.start_date;
    return { day: startsBeforeTrip ? trip.start_date : departureDay, departureDay, arrivalDay, overlapsTrip, startsBeforeTrip };
  } catch {
    return fallback;
  }
}

// Reordering within the displayed day must never rewrite the actual departure
// date. Moving to another day aligns departure to that trip-timezone day.
export function flightMoveOffset(flight: FlightDetails, trip: TripWindow, targetDay: string) {
  const placement = flightTripPlacement(flight, trip);
  if (targetDay === placement.day) return 0;
  return Math.round((Date.parse(`${targetDay}T12:00:00Z`) - Date.parse(`${placement.departureDay}T12:00:00Z`)) / 86_400_000);
}
