import marketCalendar from "../../../../../config/market-calendar.json";

export type EquitySession = "REGULAR" | "EXTENDED" | "CLOSED";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

function minuteOfDay(value: unknown, field: string): number {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) throw new Error(`market-calendar: ${field} must be HH:MM`);
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function dateSet(values: unknown, field: string): ReadonlySet<string> {
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))) {
    throw new Error(`market-calendar: ${field} must be a list of YYYY-MM-DD dates`);
  }
  return new Set(values as string[]);
}

if (marketCalendar.version !== 1 || marketCalendar.timeZone !== "America/New_York" || marketCalendar.equity.chartSession !== "REGULAR") {
  throw new Error("market-calendar: unsupported calendar");
}

const equity = {
  extendedOpen: minuteOfDay(marketCalendar.equity.extendedOpen, "extendedOpen"),
  regularOpen: minuteOfDay(marketCalendar.equity.regularOpen, "regularOpen"),
  earlyClose: minuteOfDay(marketCalendar.equity.earlyClose, "earlyClose"),
  regularClose: minuteOfDay(marketCalendar.equity.regularClose, "regularClose"),
  extendedClose: minuteOfDay(marketCalendar.equity.extendedClose, "extendedClose"),
  holidays: dateSet(marketCalendar.equity.holidays, "holidays"),
  earlyCloses: dateSet(marketCalendar.equity.earlyCloses, "earlyCloses"),
};

const futureOpen = minuteOfDay(marketCalendar.future.sessionOpen, "future.sessionOpen");
const futureClose = minuteOfDay(marketCalendar.future.maintenanceStart, "future.maintenanceStart");
const futureMaintenanceEnd = minuteOfDay(marketCalendar.future.maintenanceEnd, "future.maintenanceEnd");
if (futureOpen !== futureMaintenanceEnd || futureClose >= futureOpen) throw new Error("market-calendar: invalid future maintenance break");

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: marketCalendar.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  hourCycle: "h23",
});

let cachedHour: number | null = null;
let cachedParts = { date: "", weekday: "", hourMinute: 0 };

function localParts(tsMs: number): { date: string; weekday: string; minute: number } {
  if (!Number.isSafeInteger(tsMs) || tsMs < 0) throw new Error("market-calendar: timestamp must be a non-negative safe integer");
  const hour = Math.floor(tsMs / HOUR_MS);
  if (hour !== cachedHour) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(hour * HOUR_MS)).map((part) => [part.type, part.value]));
    cachedParts = { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, hourMinute: Number(parts.hour) * 60 };
    cachedHour = hour;
  }
  return { date: cachedParts.date, weekday: cachedParts.weekday, minute: cachedParts.hourMinute + Math.floor((tsMs - hour * HOUR_MS) / MINUTE_MS) };
}

export function equitySessionAt(tsMs: number): EquitySession {
  const { date, weekday, minute } = localParts(tsMs);
  if (!WEEKDAYS.has(weekday) || equity.holidays.has(date)) return "CLOSED";
  if (minute < equity.extendedOpen || minute >= equity.extendedClose) return "CLOSED";
  const close = equity.earlyCloses.has(date) ? equity.earlyClose : equity.regularClose;
  return minute >= equity.regularOpen && minute < close ? "REGULAR" : "EXTENDED";
}

export function futureSessionOpenAt(tsMs: number): boolean {
  const { weekday, minute } = localParts(tsMs);
  if (weekday === "Sat") return false;
  if (weekday === "Sun") return minute >= futureOpen;
  if (weekday === "Fri") return minute < futureClose;
  return minute < futureClose || minute >= futureOpen;
}

export function regularSessionAt(tsMs: number): { openMs: number; closeMs: number } | null {
  if (equitySessionAt(tsMs) !== "REGULAR") return null;
  const { date, minute } = localParts(tsMs);
  const openMs = Math.floor(tsMs / MINUTE_MS) * MINUTE_MS - (minute - equity.regularOpen) * MINUTE_MS;
  const close = equity.earlyCloses.has(date) ? equity.earlyClose : equity.regularClose;
  return { openMs, closeMs: openMs + (close - equity.regularOpen) * MINUTE_MS };
}

export interface SessionScoped {
  readonly assetClass?: string;
}

export function isRegularSessionOnly(identity: SessionScoped): boolean {
  return identity.assetClass === "EQUITY";
}

export function inChartSession(identity: SessionScoped, tsMs: number): boolean {
  return !isRegularSessionOnly(identity) || equitySessionAt(tsMs) === "REGULAR";
}
