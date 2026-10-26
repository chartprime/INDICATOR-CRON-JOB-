// Binance's spot REST limit is REQUEST_WEIGHT 6000 per minute per IP, counted
// by the exchange and reported back in every response's x-mbx-used-weight-1m
// header. The REST transport reserves each request's weight here before it is
// sent, against a budget that leaves at least 1000 of margin, and raises its
// own count to whatever the exchange reports, so it never has to be told off.
const REQUEST_WEIGHTS = Object.freeze({
  KLINES: 2,
  EXCHANGE_INFO: 20,
  SERVER_TIME: 1,
});
const EXCHANGE_WEIGHT_LIMIT_PER_MINUTE = 6000;
const DEFAULT_WEIGHT_BUDGET_PER_MINUTE = 4000;
const MAX_WEIGHT_BUDGET_PER_MINUTE = 5000;
const MIN_WEIGHT_BUDGET_PER_MINUTE = 100;
const MINUTE_MS = 60_000;
const USED_WEIGHT_HEADER = "x-mbx-used-weight-1m";
// The share of the budget the steady cadence may plan on; the rest is kept
// for the connect probe, the clock refresh, catch-up pages and the candle
// backfill.
const PLANNED_SHARE = 0.9;
// The longest poll interval: at least two polls a minute fall outside the
// one-second finalisation grace, so every candle is confirmed within the
// minute after its close. Neither the setting nor the planner goes past it.
const MAX_POLL_MS = 20_000;

function assertBudget(budgetPerMinute) {
  if (
    !Number.isSafeInteger(budgetPerMinute) ||
    budgetPerMinute < MIN_WEIGHT_BUDGET_PER_MINUTE ||
    budgetPerMinute > MAX_WEIGHT_BUDGET_PER_MINUTE
  ) {
    throw new Error(
      `weight budget must be a whole number between ${MIN_WEIGHT_BUDGET_PER_MINUTE} and ${MAX_WEIGHT_BUDGET_PER_MINUTE} per minute`,
    );
  }
}

function usedWeightFromHeaders(headers) {
  if (headers === null || typeof headers !== "object") return null;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === USED_WEIGHT_HEADER);
  if (!entry || typeof entry[1] !== "string" || !/^\d+$/.test(entry[1].trim())) return null;
  const value = Number.parseInt(entry[1].trim(), 10);
  return Number.isSafeInteger(value) ? value : null;
}

function createBinanceRestWeightBudget({ budgetPerMinute = DEFAULT_WEIGHT_BUDGET_PER_MINUTE, now = () => Date.now() } = {}) {
  assertBudget(budgetPerMinute);
  if (typeof now !== "function") throw new Error("now must be a function");

  let minuteStart = Math.floor(now() / MINUTE_MS) * MINUTE_MS;
  let reserved = 0;
  let observed = 0;
  // The conservative total this minute: every reservation adds to it, and an
  // exchange header raises it when the exchange counts more than we did.
  // Reservations after a header keep adding on top of that header.
  let accounted = 0;
  let deferrals = 0;
  let reservations = 0;

  function rollMinute() {
    const current = Math.floor(now() / MINUTE_MS) * MINUTE_MS;
    if (current !== minuteStart) {
      minuteStart = current;
      reserved = 0;
      observed = 0;
      accounted = 0;
    }
  }

  function used() {
    rollMinute();
    return accounted;
  }

  /** Reserves `weight` for a request about to be sent; false means wait for the next minute. */
  function reserve(weight) {
    if (!Number.isSafeInteger(weight) || weight <= 0) throw new Error("weight must be a positive safe integer");
    rollMinute();
    if (accounted + weight > budgetPerMinute) {
      deferrals += 1;
      return false;
    }
    reserved += weight;
    accounted += weight;
    reservations += 1;
    return true;
  }

  /** Raises this minute's count to what the exchange reports in a response's headers. */
  function observe(headers) {
    const value = usedWeightFromHeaders(headers);
    if (value === null) return null;
    rollMinute();
    if (value > observed) observed = value;
    if (value > accounted) accounted = value;
    return value;
  }

  function msUntilReset() {
    const at = now();
    return Math.max(1, minuteStart + MINUTE_MS - at);
  }

  function stats() {
    rollMinute();
    return Object.freeze({
      budgetPerMinute,
      minuteStart,
      reserved,
      observed,
      used: accounted,
      remaining: Math.max(0, budgetPerMinute - accounted),
      reservations,
      deferrals,
    });
  }

  return Object.freeze({ reserve, observe, used, msUntilReset, stats, get budgetPerMinute() { return budgetPerMinute; } });
}

/**
 * The steady candle cadence that fits the budget: the poll interval, lengthened
 * in whole multiples until the planned share holds. The caller says so in the
 * health reason when it was lengthened. The budget is never exceeded to keep a
 * cadence.
 */
function planCadence({ klinePollers, pollMs, budgetPerMinute }) {
  assertBudget(budgetPerMinute);
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error("pollMs must be a positive safe integer");
  if (!Number.isSafeInteger(klinePollers) || klinePollers < 0) throw new Error("klinePollers must be a non-negative safe integer");
  const target = Math.floor(budgetPerMinute * PLANNED_SHARE);
  const cost = (cadenceMs) => klinePollers * Math.ceil(MINUTE_MS / cadenceMs) * REQUEST_WEIGHTS.KLINES + REQUEST_WEIGHTS.SERVER_TIME;
  let klineCadenceMs = pollMs;
  let stretched = false;
  for (let multiple = 2; cost(klineCadenceMs) > target && pollMs * multiple <= MAX_POLL_MS; multiple += 1) {
    klineCadenceMs = pollMs * multiple;
    stretched = true;
  }
  return Object.freeze({
    klineCadenceMs,
    stretched,
    projectedPerMinute: cost(klineCadenceMs),
    fits: cost(klineCadenceMs) <= target,
  });
}

module.exports = {
  createBinanceRestWeightBudget,
  planCadence,
  usedWeightFromHeaders,
  REQUEST_WEIGHTS,
  EXCHANGE_WEIGHT_LIMIT_PER_MINUTE,
  DEFAULT_WEIGHT_BUDGET_PER_MINUTE,
  MAX_WEIGHT_BUDGET_PER_MINUTE,
  MIN_WEIGHT_BUDGET_PER_MINUTE,
  USED_WEIGHT_HEADER,
  MAX_POLL_MS,
};
