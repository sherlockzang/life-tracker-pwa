export interface AircraftTypeOption {
  canonical: string;
  aliases: string[];
}

// Common commercial aircraft names plus frequently seen IATA/ICAO/provider
// designators. Unknown values deliberately remain untouched.
export const AIRCRAFT_TYPES: AircraftTypeOption[] = [
  { canonical: "A220-100", aliases: ["221", "A221", "BCS1", "CS100"] },
  { canonical: "A220-300", aliases: ["223", "A223", "BCS3", "CS300"] },
  { canonical: "A319-100", aliases: ["319", "A319"] },
  { canonical: "A320-200", aliases: ["320", "A320"] },
  { canonical: "A320neo", aliases: ["32N", "A20N", "A320N", "A320NEO"] },
  { canonical: "A321-200", aliases: ["321", "A321"] },
  { canonical: "A321neo", aliases: ["32Q", "A21N", "A321N", "A321NEO"] },
  { canonical: "A330-200", aliases: ["332", "A332"] },
  { canonical: "A330-300", aliases: ["333", "A333"] },
  { canonical: "A330-800neo", aliases: ["338", "A338", "A330-800"] },
  { canonical: "A330-900neo", aliases: ["339", "A339", "A330-900"] },
  { canonical: "A340-300", aliases: ["343", "A343"] },
  { canonical: "A340-600", aliases: ["346", "A346"] },
  { canonical: "A350-900", aliases: ["359", "A359", "A350900"] },
  { canonical: "A350-1000", aliases: ["35K", "A35K", "A3501000"] },
  { canonical: "A380-800", aliases: ["388", "A388", "A380"] },
  { canonical: "737-700", aliases: ["73G", "B737", "B737-700", "7377"] },
  { canonical: "737-800", aliases: ["738", "73H", "B738", "B737-800", "7378"] },
  { canonical: "737-900ER", aliases: ["739", "B739", "B737-900ER", "739ER"] },
  { canonical: "737 MAX 8", aliases: ["7M8", "B38M", "737-8", "737MAX8", "B737MAX8"] },
  { canonical: "737 MAX 9", aliases: ["7M9", "B39M", "737-9", "737MAX9", "B737MAX9"] },
  { canonical: "747-400", aliases: ["744", "B744", "B747-400"] },
  { canonical: "747-8", aliases: ["748", "B748", "B747-8", "7478"] },
  { canonical: "757-200", aliases: ["752", "B752", "B757-200"] },
  { canonical: "757-300", aliases: ["753", "B753", "B757-300"] },
  { canonical: "767-300ER", aliases: ["763", "B763", "B767-300ER", "763ER"] },
  { canonical: "767-400ER", aliases: ["764", "B764", "B767-400ER", "764ER"] },
  { canonical: "777-200", aliases: ["772", "B772", "B777-200"] },
  { canonical: "777-200ER", aliases: ["772ER", "B777-200ER"] },
  { canonical: "777-200LR", aliases: ["77L", "B77L", "B777-200LR"] },
  { canonical: "777-300", aliases: ["773", "B773", "B777-300"] },
  { canonical: "777-300ER", aliases: ["77W", "B77W", "773ER", "B777-300ER"] },
  { canonical: "777-8", aliases: ["778", "B778", "B777-8"] },
  { canonical: "777-9", aliases: ["779", "B779", "B777-9"] },
  { canonical: "787-8", aliases: ["788", "B788", "B787-8", "7878"] },
  { canonical: "787-9", aliases: ["789", "B789", "B787-9", "7879"] },
  { canonical: "787-10", aliases: ["78X", "B78X", "B787-10", "7810", "7871000", "787-1000"] },
  { canonical: "E170", aliases: ["E70", "E170", "ERJ170"] },
  { canonical: "E175", aliases: ["E75", "E175", "ERJ175", "E75L", "E75S"] },
  { canonical: "E190", aliases: ["E90", "E190", "ERJ190"] },
  { canonical: "E195", aliases: ["E95", "E195", "ERJ195"] },
  { canonical: "E190-E2", aliases: ["E290", "E190E2"] },
  { canonical: "E195-E2", aliases: ["E295", "E195E2"] },
  { canonical: "ATR 72-600", aliases: ["AT7", "AT76", "ATR72", "ATR72600"] },
  { canonical: "CRJ-700", aliases: ["CR7", "CRJ7", "CRJ700"] },
  { canonical: "CRJ-900", aliases: ["CR9", "CRJ9", "CRJ900"] },
  { canonical: "CRJ-1000", aliases: ["CRK", "CRJ1000"] },
  { canonical: "MD-11", aliases: ["M11", "MD11"] }
];

function key(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const LOOKUP = new Map(AIRCRAFT_TYPES.flatMap((option) => [option.canonical, ...option.aliases].map((alias) => [key(alias), option.canonical] as const)));

export function normalizeAircraftType(value: string | null | undefined) {
  const trimmed = value?.trim() || "";
  return trimmed ? LOOKUP.get(key(trimmed)) || trimmed : "";
}

export function searchAircraftTypes(query: string, limit = 6) {
  const needle = key(query);
  if (!needle) return [];
  return AIRCRAFT_TYPES.map((option) => {
    const values = [option.canonical, ...option.aliases].map(key);
    const exact = values.includes(needle);
    const starts = values.some((value) => value.startsWith(needle));
    const contains = values.some((value) => value.includes(needle));
    return { option, score: exact ? 100 : starts ? 50 : contains ? 10 : 0 };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.option.canonical.localeCompare(right.option.canonical)).slice(0, limit).map((item) => item.option);
}
