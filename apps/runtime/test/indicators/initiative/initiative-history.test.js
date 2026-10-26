const history = require("../../../src/indicators/initiative/initiative-history");
const exhaustion = require("../../../src/indicators/exhaustion/exhaustion-history");
const { CANDLE_MS, ATR_PERIOD } = require("../../../src/indicators/exhaustion/exhaustion-engine");
const { typicalCount } = require("../../../src/indicators/initiative/initiative-engine");

const { readHours, probeBack, groupOf, isShort, warmHours, afterHours, GROUPS, HOUR_MS, SHORT_MAX_MS, DEFAULT_CONCURRENCY } = history;

describe("indicators/initiative/initiative-history", () => {
  test("the walk over the host's hours is the Exhaustion one, shared, not a copy", () => {
    expect(readHours).toBe(exhaustion.readHours);
    expect(probeBack).toBe(exhaustion.probeBack);
    expect([HOUR_MS, SHORT_MAX_MS, DEFAULT_CONCURRENCY]).toEqual([exhaustion.HOUR_MS, exhaustion.SHORT_MAX_MS, exhaustion.DEFAULT_CONCURRENCY]);
  });

  test("the short candle lengths are 1m to 30m; each warms over the typical and the ATR before a span and reads the same hours after it as Exhaustion; the long ones have no group", () => {
    expect(CANDLE_MS.filter(isShort)).toEqual([60_000, 120_000, 180_000, 300_000, 900_000, 1_800_000]);
    expect(GROUPS.map((group) => [group.maxMs, group.warm, group.after])).toEqual([[180_000, 5, 1], [300_000, 6, 2], [900_000, 9, 5], [1_800_000, 14, 8]]);
    for (const candleMs of CANDLE_MS.filter(isShort)) {
      const group = groupOf(candleMs);
      expect(group.warm * HOUR_MS).toBeGreaterThanOrEqual((typicalCount(candleMs) + ATR_PERIOD) * candleMs);
      expect(group.after).toBe(exhaustion.groupOf(candleMs).after);
    }
    expect([60_000, 120_000, 180_000].map((ms) => groupOf(ms))).toEqual([GROUPS[0], GROUPS[0], GROUPS[0]]);
    expect([3_600_000, 86_400_000, 240_000].map((ms) => groupOf(ms))).toEqual([null, null, null]);
    expect([warmHours([60_000, 300_000]), afterHours([60_000, 1_800_000]), warmHours([]), warmHours([3_600_000]), afterHours([])]).toEqual([6, 8, 0, 0, 0]);
  });
});
