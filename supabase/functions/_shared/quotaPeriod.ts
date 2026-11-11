export function shanghaiPeriod(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (name: string) => Number(parts.find((part) => part.type === name)?.value);
  const year = get("year"), monthNumber = get("month"), dayNumber = get("day");
  const month = `${year}-${String(monthNumber).padStart(2, "0")}`;
  const day = `${month}-${String(dayNumber).padStart(2, "0")}`;
  // Calendar arithmetic on Shanghai local fields, then apply its UTC offset.
  const localMidnight = (monthIndex: number, date: number) => new Date(Date.UTC(year, monthIndex, date) - 8 * 60 * 60_000).toISOString();
  return { day, month, dayEnd: localMidnight(monthNumber - 1, dayNumber + 1), monthEnd: localMidnight(monthNumber, 1) };
}
