const marketCalendar = require("../../../../../config/market-calendar.json");

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
const CLOSED_WINDOW_STEP_MS = 5 * MINUTE_MS;

function fail(message) {
  throw new Error(`market-calendar: ${message}`);
}

function minuteOfDay(value, field) {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) fail(`${field} must be HH:MM`);
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function utcWeekday(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function dateList(values, field, coverage) {
  if (!Array.isArray(values)) fail(`${field} must be an array`);
  let previous = "";
  for (const value of values) {
    if (!isCalendarDate(value)) fail(`${field} has an invalid date ${JSON.stringify(value)}`);
    if (value <= previous) fail(`${field} must be strictly ascending`);
    if (value < coverage.from || value > coverage.to) fail(`${field} date ${value} is outside coverage`);
    const weekday = utcWeekday(value);
    if (weekday === 0 || weekday === 6) fail(`${field} date ${value} is a weekend`);
    previous = value;
  }
  return new Set(values);
}

function loadEquityCalendar(config) {
  if (config === null || typeof config !== "object" || config.version !== 1) fail("unsupported calendar version");
  if (config.timeZone !== "America/New_York") fail("timeZone must be America/New_York");
  const equity = config.equity;
  if (equity === null || typeof equity !== "object") fail("equity section is required");
  if (equity.chartSession !== "REGULAR") fail("equity chartSession must be REGULAR");
  const coverage = equity.coverage;
  if (!isCalendarDate(coverage?.from) || !isCalendarDate(coverage?.to) || coverage.from > coverage.to) fail("equity coverage is invalid");
  const extendedOpen = minuteOfDay(equity.extendedOpen, "extendedOpen");
  const regularOpen = minuteOfDay(equity.regularOpen, "regularOpen");
  const earlyClose = minuteOfDay(equity.earlyClose, "earlyClose");
  const regularClose = minuteOfDay(equity.regularClose, "regularClose");
  const extendedClose = minuteOfDay(equity.extendedClose, "extendedClose");
  if (!(extendedOpen < regularOpen && regularOpen < earlyClose && earlyClose < regularClose && regularClose <= extendedClose)) {
    fail("equity session times must be ordered extendedOpen < regularOpen < earlyClose < regularClose <= extendedClose");
  }
  const holidays = dateList(equity.holidays, "holidays", coverage);
  const earlyCloses = dateList(equity.earlyCloses, "earlyCloses", coverage);
  for (const date of earlyCloses) if (holidays.has(date)) fail(`${date} is both a holiday and an early close`);
  if (!Array.isArray(equity.sources) || equity.sources.length === 0) fail("equity sources are required");
  for (const source of equity.sources) {
    if (typeof source?.url !== "string" || !source.url.startsWith("https://") || !isCalendarDate(source.fetched)) fail("every source needs an https url and a fetched date");
  }
  return Object.freeze({
    coverage: Object.freeze({ from: coverage.from, to: coverage.to }),
    extendedOpen, regularOpen, earlyClose, regularClose, extendedClose, holidays, earlyCloses,
  });
}

function createMarketCalendar(config = marketCalendar) {
  const equity = loadEquityCalendar(config);
  const futureOpen = minuteOfDay(config.future?.sessionOpen, "future.sessionOpen");
  const futureClose = minuteOfDay(config.future?.maintenanceStart, "future.maintenanceStart");
  const futureMaintenanceEnd = minuteOfDay(config.future?.maintenanceEnd, "future.maintenanceEnd");
  if (futureOpen !== futureMaintenanceEnd || futureClose >= futureOpen) fail("future session times must describe a daily maintenance break");
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  });
  let cachedHour = null;
  let cachedParts = null;

  function localParts(tsMs) {
    if (!Number.isSafeInteger(tsMs) || tsMs < 0) fail("timestamp must be a non-negative safe integer");
    const hour = Math.floor(tsMs / HOUR_MS);
    if (hour !== cachedHour) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(hour * HOUR_MS)).map((part) => [part.type, part.value]));
      cachedParts = { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, hourMinute: Number(parts.hour) * 60 };
      cachedHour = hour;
    }
    return { date: cachedParts.date, weekday: cachedParts.weekday, minute: cachedParts.hourMinute + Math.floor((tsMs - hour * HOUR_MS) / MINUTE_MS) };
  }

  function equitySessionAt(tsMs) {
    const { date, weekday, minute } = localParts(tsMs);
    if (!WEEKDAYS.has(weekday) || equity.holidays.has(date)) return "CLOSED";
    if (minute < equity.extendedOpen || minute >= equity.extendedClose) return "CLOSED";
    const close = equity.earlyCloses.has(date) ? equity.earlyClose : equity.regularClose;
    return minute >= equity.regularOpen && minute < close ? "REGULAR" : "EXTENDED";
  }

  function isEquityChartTime(tsMs) {
    return equitySessionAt(tsMs) === "REGULAR";
  }

  function inChartSession(assetClass, tsMs) {
    return assetClass !== "EQUITY" || isEquityChartTime(tsMs);
  }

  function coversTime(tsMs) {
    const { date } = localParts(tsMs);
    return date >= equity.coverage.from && date <= equity.coverage.to;
  }

  function futuresSessionOpen(tsMs) {
    const { weekday, minute } = localParts(tsMs);
    if (weekday === "Sat") return false;
    if (weekday === "Sun") return minute >= futureOpen;
    if (weekday === "Fri") return minute < futureClose;
    return minute < futureClose || minute >= futureOpen;
  }

  function isMarketOpen(assetClass, tsMs) {
    if (assetClass === "EQUITY") return equitySessionAt(tsMs) !== "CLOSED";
    if (assetClass === "FUTURE") return futuresSessionOpen(tsMs);
    return true;
  }

  function isClosedThroughout(assetClass, fromMs, toMs) {
    if (assetClass !== "EQUITY" && assetClass !== "FUTURE") return false;
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs < fromMs) return false;
    for (let ts = fromMs; ts < toMs; ts += CLOSED_WINDOW_STEP_MS) {
      if (isMarketOpen(assetClass, ts)) return false;
    }
    return !isMarketOpen(assetClass, Math.max(fromMs, toMs - 1));
  }

  return Object.freeze({ coverage: equity.coverage, equitySessionAt, isEquityChartTime, inChartSession, coversTime, isMarketOpen, isClosedThroughout });
}

const defaultCalendar = createMarketCalendar();

module.exports = {
  createMarketCalendar,
  equitySessionAt: defaultCalendar.equitySessionAt,
  isEquityChartTime: defaultCalendar.isEquityChartTime,
  inChartSession: defaultCalendar.inChartSession,
  coversTime: defaultCalendar.coversTime,
  isMarketOpen: defaultCalendar.isMarketOpen,
  isClosedThroughout: defaultCalendar.isClosedThroughout,
  EQUITY_CALENDAR_COVERAGE: defaultCalendar.coverage,
};
