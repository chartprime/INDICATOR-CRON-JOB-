const { equitySessionAt } = require("../shared/market-calendar");
const marketCalendar = require("../../../../../config/market-calendar.json");

const minuteOfDay = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const FUTURE_OPEN = minuteOfDay(marketCalendar.future.sessionOpen);
const FUTURE_CLOSE = minuteOfDay(marketCalendar.future.maintenanceStart);

const SESSION_POLICY = Object.freeze({
  mode: "EQUITY_CHART_REGULAR_ONLY",
  timeZone: "America/New_York",
  future: Object.freeze({ sessionOpenMinute: FUTURE_OPEN, maintenanceStartMinute: FUTURE_CLOSE, maintenanceEndMinute: minuteOfDay(marketCalendar.future.maintenanceEnd) }),
});

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SESSION_POLICY.timeZone,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function assertTimestamp(tsMs) {
  if (!Number.isSafeInteger(tsMs) || tsMs < 0) throw new Error("dxfeed session policy: timestamp must be a non-negative safe integer");
}

function localParts(tsMs) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(tsMs)).map((part) => [part.type, part.value]));
  return { weekday: parts.weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function classifyFutureSession(weekday, minute) {
  if (weekday === "Sat") return "CLOSED";
  if (weekday === "Sun") return minute >= FUTURE_OPEN ? "ELECTRONIC" : "CLOSED";
  if (weekday === "Fri") return minute < FUTURE_CLOSE ? "ELECTRONIC" : "CLOSED";
  return minute >= FUTURE_CLOSE && minute < FUTURE_OPEN ? "MAINTENANCE" : "ELECTRONIC";
}

function classifyDxFeedSession(assetClass, tsMs) {
  assertTimestamp(tsMs);
  if (assetClass === "EQUITY") return equitySessionAt(tsMs);
  if (assetClass === "FUTURE") {
    const { weekday, minute } = localParts(tsMs);
    return classifyFutureSession(weekday, minute);
  }
  throw new Error("dxfeed session policy: unsupported asset class");
}

module.exports = { SESSION_POLICY, classifyDxFeedSession };
