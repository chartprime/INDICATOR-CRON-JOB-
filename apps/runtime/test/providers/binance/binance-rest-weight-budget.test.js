const {
  createBinanceRestWeightBudget,
  planCadence,
  usedWeightFromHeaders,
  REQUEST_WEIGHTS,
  DEFAULT_WEIGHT_BUDGET_PER_MINUTE,
  MAX_WEIGHT_BUDGET_PER_MINUTE,
  EXCHANGE_WEIGHT_LIMIT_PER_MINUTE,
} = require("../../../src/providers/binance/binance-rest-weight-budget");

const MINUTE_MS = 60_000;

function fakeClock(startMs) {
  let at = startMs;
  return { now: () => at, advance(ms) { at += ms; }, set(ms) { at = ms; } };
}

describe("binance-rest-weight-budget", () => {
  test("the corrected weights and the margin: default 4000, maximum 5000, exchange limit 6000", () => {
    expect(REQUEST_WEIGHTS).toEqual({ KLINES: 2, EXCHANGE_INFO: 20, SERVER_TIME: 1 });
    expect(DEFAULT_WEIGHT_BUDGET_PER_MINUTE).toBe(4000);
    expect(MAX_WEIGHT_BUDGET_PER_MINUTE).toBe(5000);
    expect(EXCHANGE_WEIGHT_LIMIT_PER_MINUTE - MAX_WEIGHT_BUDGET_PER_MINUTE).toBeGreaterThanOrEqual(1000);
    expect(() => createBinanceRestWeightBudget({ budgetPerMinute: 5001 })).toThrow(/between 100 and 5000/);
    expect(() => createBinanceRestWeightBudget({ budgetPerMinute: 99 })).toThrow(/between 100 and 5000/);
    expect(() => createBinanceRestWeightBudget({ budgetPerMinute: 4000.5 })).toThrow(/between 100 and 5000/);
  });

  test("weight is reserved before dispatch; a reservation that would cross the budget is refused and counted, never granted", () => {
    const clock = fakeClock(1_800_000_000_000);
    const budget = createBinanceRestWeightBudget({ budgetPerMinute: 100, now: clock.now });
    expect(budget.reserve(REQUEST_WEIGHTS.EXCHANGE_INFO)).toBe(true);
    for (let i = 0; i < 40; i += 1) expect(budget.reserve(REQUEST_WEIGHTS.KLINES)).toBe(true);
    expect(budget.stats().used).toBe(100);
    expect(budget.reserve(REQUEST_WEIGHTS.SERVER_TIME)).toBe(false);
    expect(budget.reserve(REQUEST_WEIGHTS.KLINES)).toBe(false);
    expect(budget.stats()).toMatchObject({ reserved: 100, used: 100, remaining: 0, deferrals: 2, reservations: 41 });
    expect(() => budget.reserve(0)).toThrow(/positive/);
  });

  test("concurrent reservations in the same tick are granted first come first served up to the budget, and the rest wait for the minute", () => {
    const clock = fakeClock(1_800_000_000_000);
    const budget = createBinanceRestWeightBudget({ budgetPerMinute: 100, now: clock.now });
    const outcomes = Array.from({ length: 55 }, () => budget.reserve(REQUEST_WEIGHTS.KLINES));
    expect(outcomes.filter(Boolean)).toHaveLength(50);
    expect(outcomes.slice(50)).toEqual([false, false, false, false, false]);
    expect(budget.msUntilReset()).toBe(MINUTE_MS - (1_800_000_000_000 % MINUTE_MS));
    clock.advance(budget.msUntilReset());
    expect(budget.reserve(REQUEST_WEIGHTS.KLINES)).toBe(true);
    expect(budget.stats()).toMatchObject({ reserved: 2, deferrals: 5 });
  });

  test("the exchange's own x-mbx-used-weight-1m raises the count when it is higher and never lowers it", () => {
    const clock = fakeClock(1_800_000_000_000);
    const budget = createBinanceRestWeightBudget({ budgetPerMinute: 1000, now: clock.now });
    budget.reserve(REQUEST_WEIGHTS.KLINES);
    expect(budget.observe({ "X-MBX-USED-WEIGHT-1M": "950" })).toBe(950);
    expect(budget.used()).toBe(950);
    expect(budget.observe({ "x-mbx-used-weight-1m": "10" })).toBe(10);
    expect(budget.used()).toBe(950);
    expect(budget.reserve(60)).toBe(false);
    expect(budget.reserve(50)).toBe(true);
    expect(budget.observe({})).toBeNull();
    expect(budget.observe(null)).toBeNull();
    expect(usedWeightFromHeaders({ "x-mbx-used-weight-1m": "abc" })).toBeNull();
    clock.set(1_800_000_060_000);
    expect(budget.used()).toBe(0);
  });

  test("planCadence keeps the candle polls inside 90 % of the budget, lengthening the interval in whole multiples and reporting the stretch", () => {
    const one = planCadence({ klinePollers: 1, pollMs: 1000, budgetPerMinute: 4000 });
    expect(one).toEqual({ klineCadenceMs: 1000, stretched: false, projectedPerMinute: 121, fits: true });
    const four = planCadence({ klinePollers: 4, pollMs: 1000, budgetPerMinute: 4000 });
    expect(four).toEqual({ klineCadenceMs: 1000, stretched: false, projectedPerMinute: 481, fits: true });
    const tight = planCadence({ klinePollers: 2, pollMs: 1000, budgetPerMinute: 100 });
    expect(tight.klineCadenceMs).toBe(3000);
    expect(tight.stretched).toBe(true);
    expect(tight.projectedPerMinute).toBe(81);
    expect(tight.fits).toBe(true);
    const idle = planCadence({ klinePollers: 0, pollMs: 1000, budgetPerMinute: 4000 });
    expect(idle).toEqual({ klineCadenceMs: 1000, stretched: false, projectedPerMinute: REQUEST_WEIGHTS.SERVER_TIME, fits: true });
    expect(() => planCadence({ klinePollers: 1, pollMs: 0, budgetPerMinute: 4000 })).toThrow(/pollMs/);
    expect(() => planCadence({ klinePollers: -1, pollMs: 1000, budgetPerMinute: 4000 })).toThrow(/klinePollers/);
  });
});
