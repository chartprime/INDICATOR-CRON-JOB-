const {
  calibrateVBucket,
  createSealerState,
  ingestTrade,
  createVpinState,
  ingestVpinTrade,
  applyHysteresisStep,
  snapshotVpinState,
  DEFAULT_BUCKETS_PER_DAY,
  DEFAULT_MIN_V_BUCKET,
} = require("../../../src/indicators/vpin/vpin-engine");

function trade(ts, price, size, side) {
  return { ts, price, size, side };
}

function imbalanceTrades(ts, vBucket, imbalance) {
  const buyValue = (vBucket * (1 + imbalance)) / 2;
  const sellValue = (vBucket * (1 - imbalance)) / 2;
  return [trade(ts, 1, buyValue, "buy"), trade(ts + 1, 1, sellValue, "sell")];
}

describe("server/vpin-engine", () => {
  describe("calibrateVBucket", () => {
    test("returns the median daily volume divided by bucketsPerDay, floored at minVBucket", () => {
      expect(calibrateVBucket([900, 1000, 1100], { bucketsPerDay: 100, minVBucket: 1 })).toBe(10);
    });

    test("floors at minVBucket for a thin symbol", () => {
      expect(calibrateVBucket([10, 20, 30], { bucketsPerDay: 100, minVBucket: 5_000 })).toBe(5_000);
    });

    test("floors at minVBucket when given no usable volume data", () => {
      expect(calibrateVBucket([], { minVBucket: 500 })).toBe(500);
      expect(calibrateVBucket([0, -5, NaN, Infinity], { minVBucket: 500 })).toBe(500);
    });

    test("defaults match the documented v4 calibration constants", () => {
      expect(DEFAULT_BUCKETS_PER_DAY).toBe(360);
      expect(DEFAULT_MIN_V_BUCKET).toBe(1_000);
    });

    test("rejects a non-positive bucketsPerDay/minVBucket", () => {
      expect(() => calibrateVBucket([1], { bucketsPerDay: 0 })).toThrow(/bucketsPerDay/);
      expect(() => calibrateVBucket([1], { minVBucket: 0 })).toThrow(/minVBucket/);
    });
  });

  describe("ingestTrade -- bucket sealing", () => {
    test("accumulates value across trades and seals once the total reaches vBucket", () => {
      const sealer = createSealerState({ vBucket: 100 });
      expect(ingestTrade(sealer, trade(1, 10, 5, "buy"))).toEqual([]);
      expect(ingestTrade(sealer, trade(2, 10, 3, "sell"))).toEqual([]);
      const [sealed] = ingestTrade(sealer, trade(3, 10, 3, "buy"));
      expect(sealed.sealTs).toBe(3);
      expect(sealed.durationMs).toBe(2);
      expect(sealed.imbalance).toBeCloseTo((50 + 20 - 30) / 100, 10);
      expect(sealer.buyAcc).toBe(10);
      expect(sealer.sellAcc).toBe(0);
      expect(sealer.totalAcc).toBe(10);
    });

    test("resets accumulators after sealing so the next bucket starts fresh", () => {
      const sealer = createSealerState({ vBucket: 10 });
      ingestTrade(sealer, trade(1, 1, 10, "buy"));
      expect(sealer.buyAcc).toBe(0);
      expect(sealer.sellAcc).toBe(0);
      expect(sealer.totalAcc).toBe(0);
      expect(sealer.openTs).toBeNull();
      const [sealed] = ingestTrade(sealer, trade(2, 1, 10, "sell"));
      expect(sealed.imbalance).toBeCloseTo(-1, 10);
      expect(sealed.durationMs).toBe(0);
    });

    test("an all-buy bucket has imbalance 1, an all-sell bucket has imbalance -1", () => {
      const buySealer = createSealerState({ vBucket: 10 });
      expect(ingestTrade(buySealer, trade(1, 1, 10, "buy"))[0].imbalance).toBe(1);
      const sellSealer = createSealerState({ vBucket: 10 });
      expect(ingestTrade(sellSealer, trade(1, 1, 10, "sell"))[0].imbalance).toBe(-1);
    });

    test("a trade with an undefined (null) aggressor side is skipped entirely, not counted toward the bucket", () => {
      const sealer = createSealerState({ vBucket: 10 });
      expect(ingestTrade(sealer, trade(1, 1, 10, null))).toEqual([]);
      expect(sealer.totalAcc).toBe(0);
      expect(sealer.openTs).toBeNull();
    });

    test("rejects invalid trade fields", () => {
      const sealer = createSealerState({ vBucket: 10 });
      expect(() => ingestTrade(sealer, trade(-1, 1, 1, "buy"))).toThrow(/ts/);
      expect(() => ingestTrade(sealer, trade(1, 0, 1, "buy"))).toThrow(/price/);
      expect(() => ingestTrade(sealer, trade(1, 1, 0, "buy"))).toThrow(/size/);
      expect(() => ingestTrade(sealer, trade(1, 1, 1, "bogus"))).toThrow(/side/);
    });

    test("rejects a non-positive vBucket", () => {
      expect(() => createSealerState({ vBucket: 0 })).toThrow(/vBucket/);
    });

    test("carries a whale trade through every equal-notional bucket without losing its residual", () => {
      const sealer = createSealerState({ vBucket: 100 });
      const sealed = ingestTrade(sealer, trade(10, 1, 250, "buy"));
      expect(sealed).toHaveLength(2);
      expect(sealed.map((bucket) => bucket.imbalance)).toEqual([1, 1]);
      expect(sealer).toMatchObject({ buyAcc: 50, sellAcc: 0, totalAcc: 50, openTs: 10 });
    });

    test("preserves the exact per-bucket side allocation when a trade finishes a mixed bucket", () => {
      const sealer = createSealerState({ vBucket: 100 });
      ingestTrade(sealer, trade(1, 1, 40, "sell"));
      const [sealed] = ingestTrade(sealer, trade(2, 1, 90, "buy"));
      expect(sealed.imbalance).toBeCloseTo(0.2, 12);
      expect(sealer).toMatchObject({ buyAcc: 30, sellAcc: 0, totalAcc: 30, openTs: 2 });
    });
  });

  describe("applyHysteresisStep -- Schmitt-trigger contract", () => {
    function stateWithThresholds(zOn = 1.0, zOff = 0.2) {
      return createVpinState({ vBucket: 1, zOn, zOff });
    }

    test("stays inactive below zOn", () => {
      const state = stateWithThresholds();
      applyHysteresisStep(state, 0.5);
      expect(state.active).toBe(false);
      expect(state.zActive).toBe(0);
    });

    test("activates at zOn, direction matches the sign", () => {
      const state = stateWithThresholds();
      applyHysteresisStep(state, 1.5);
      expect(state.active).toBe(true);
      expect(state.direction).toBe(1);
      expect(state.zActive).toBe(1.5);
    });

    test("holds active while the same-direction reading stays at or above zOff, even well below zOn", () => {
      const state = stateWithThresholds();
      applyHysteresisStep(state, 1.5);
      applyHysteresisStep(state, 0.3);
      expect(state.active).toBe(true);
      expect(state.direction).toBe(1);
      expect(state.zActive).toBe(0.3);
    });

    test("deactivates once the same-direction reading drops below zOff", () => {
      const state = stateWithThresholds();
      applyHysteresisStep(state, 1.5);
      applyHysteresisStep(state, 0.1);
      expect(state.active).toBe(false);
      expect(state.direction).toBe(0);
      expect(state.zActive).toBe(0);
    });

    test("a sign flip deactivates even above zOff, and can immediately reactivate in the new direction if it clears zOn", () => {
      const state = stateWithThresholds();
      applyHysteresisStep(state, 1.5);
      applyHysteresisStep(state, -1.5);
      expect(state.active).toBe(true);
      expect(state.direction).toBe(-1);
      expect(state.zActive).toBe(-1.5);
    });

    test("a sign flip that does not clear zOn deactivates and stays inactive", () => {
      const state = stateWithThresholds();
      applyHysteresisStep(state, 1.5);
      applyHysteresisStep(state, -0.5);
      expect(state.active).toBe(false);
      expect(state.direction).toBe(0);
    });

    test("NaN input leaves the current state untouched (warmup / missing baseline)", () => {
      const state = stateWithThresholds();
      applyHysteresisStep(state, 1.5);
      applyHysteresisStep(state, NaN);
      expect(state.active).toBe(true);
      expect(state.direction).toBe(1);
    });

    test("rejects zOff >= zOn", () => {
      expect(() => stateWithThresholds(1.0, 1.0)).toThrow(/zOff/);
      expect(() => stateWithThresholds(1.0, 1.5)).toThrow(/zOff/);
    });
  });

  describe("ingestVpinTrade -- full pipeline", () => {
    function feed(state, trades) {
      let last = null;
      for (const t of trades) {
        const results = ingestVpinTrade(state, t);
        if (results.length > 0) last = results.at(-1);
      }
      return last;
    }

    test("produces no signed_vpin until w/2 buckets have sealed (warmup)", () => {
      const state = createVpinState({ vBucket: 10, w: 4, nBaseline: 4 });
      const result = feed(state, [trade(1, 1, 10, "buy")]);
      expect(result.sv).toBeNull();
      expect(state.zVpin).toBeNull();
    });

    test("produces signed_vpin once w/2 buckets have sealed, as the mean of the imbalances seen so far", () => {
      const state = createVpinState({ vBucket: 10, w: 4, nBaseline: 4 });
      feed(state, [trade(1, 1, 10, "buy")]);
      const result = feed(state, [trade(2, 1, 10, "sell")]);
      expect(result.sv).toBeCloseTo((1 + -1) / 2, 10);
    });

    test("z_vpin stays null until nBaseline/2 signed_vpin points have accumulated", () => {
      const state = createVpinState({ vBucket: 10, w: 2, nBaseline: 6 });
      feed(state, [trade(1, 1, 10, "buy")]);
      const result = feed(state, [trade(2, 1, 10, "sell")]);
      expect(result.sv).not.toBeNull();
      expect(result.zVpin).toBeNull();
    });

    test("a strong one-sided shift against an established balanced baseline activates the cloud in that direction", () => {
      const state = createVpinState({ vBucket: 10, w: 1, nBaseline: 20, zOn: 1.0, zOff: 0.2 });
      let ts = 0;
      for (let i = 0; i < 20; i += 1) {
        const imbalance = i % 2 === 0 ? 0.1 : -0.1;
        feed(state, imbalanceTrades(ts, 10, imbalance));
        ts += 2;
      }
      const result = feed(state, imbalanceTrades(ts, 10, 0.9));
      expect(result.zVpin).toBeGreaterThan(1.0);
      const snapshot = snapshotVpinState(state);
      expect(snapshot.active).toBe(true);
      expect(snapshot.direction).toBe("buy");
    });

    test("the baseline Z-score uses sample standard deviation (N-1), matching pandas's own .std() default -- not population (N)", () => {
      const state = createVpinState({ vBucket: 10, w: 1, nBaseline: 4, zOn: 0.01, zOff: 0.001 });
      const imbalances = [0.1, -0.1, 0.2, -0.2];
      let result = null;
      let ts = 0;
      for (const imbalance of imbalances) {
        result = feed(state, imbalanceTrades(ts, 10, imbalance));
        ts += 2;
      }
      const sampleStd = Math.sqrt(0.10 / 3);
      const populationStd = Math.sqrt(0.10 / 4);
      expect(result.zVpin).toBeCloseTo(-0.2 / sampleStd, 6);
      expect(result.zVpin).not.toBeCloseTo(-0.2 / populationStd, 3);
    });

    test("the sv/z warmup gate uses floor division (W // 2), matching pandas's own min_periods convention for an odd window", () => {
      const state = createVpinState({ vBucket: 10, w: 3, nBaseline: 100 });
      const result = feed(state, imbalanceTrades(0, 10, 0.5));
      expect(result.sv).not.toBeNull();
    });

    test("the z-score baseline warmup gate also uses floor division (N_BASELINE // 2) for an odd baseline window", () => {
      const state = createVpinState({ vBucket: 10, w: 1, nBaseline: 3 });
      const result = feed(state, imbalanceTrades(0, 10, 0.5));
      expect(result.zVpin).not.toBeNull();
    });

    test("velocity is null until a reading exists at least one lookback window in the past", () => {
      const state = createVpinState({ vBucket: 10, w: 2, nBaseline: 4, velocityLookbackMs: 5_000 });
      let ts = 1;
      for (let i = 0; i < 6; i += 1) {
        feed(state, [trade(ts, 1, 10, i % 2 === 0 ? "buy" : "sell")]);
        ts += 1;
      }
      expect(state.zVelocity).toBeNull();
    });

    test("velocity reflects the change in z_vpin over the lookback window once available", () => {
      const state = createVpinState({ vBucket: 10, w: 1, nBaseline: 20, velocityLookbackMs: 100 });
      let ts = 0;
      for (let i = 0; i < 20; i += 1) {
        const imbalance = i % 2 === 0 ? 0.1 : -0.1;
        feed(state, imbalanceTrades(ts, 10, imbalance));
        ts += 10;
      }
      feed(state, imbalanceTrades(ts, 10, 0.9));
      ts += 10;
      feed(state, imbalanceTrades(ts, 10, 0.9));
      expect(state.zVelocity).not.toBeNull();
      expect(state.zVelocity).toBeGreaterThan(0);
    });

    test("rejects a malformed trade without corrupting the sealer's own accumulated state", () => {
      const state = createVpinState({ vBucket: 100 });
      ingestVpinTrade(state, trade(1, 10, 5, "buy"));
      expect(() => ingestVpinTrade(state, trade(2, -1, 5, "buy"))).toThrow(/price/);
      expect(state.sealer.totalAcc).toBe(50);
    });
  });

  describe("snapshotVpinState", () => {
    test("an inactive state snapshots to inactive with a null direction and zero strength", () => {
      const state = createVpinState({ vBucket: 10 });
      const snapshot = snapshotVpinState(state);
      expect(snapshot.active).toBe(false);
      expect(snapshot.direction).toBeNull();
      expect(snapshot.strength).toBe(0);
    });

    test("an active state snapshots direction as buy/sell and strength in [0, 1]", () => {
      const state = createVpinState({ vBucket: 10, w: 1, nBaseline: 20, zOn: 1.0, zOff: 0.2 });
      let ts = 0;
      for (let i = 0; i < 20; i += 1) {
        const imbalance = i % 2 === 0 ? 0.1 : -0.1;
        for (const t of imbalanceTrades(ts, 10, imbalance)) ingestVpinTrade(state, t);
        ts += 2;
      }
      for (const t of imbalanceTrades(ts, 10, -0.9)) ingestVpinTrade(state, t);
      const snapshot = snapshotVpinState(state);
      expect(snapshot.active).toBe(true);
      expect(snapshot.direction).toBe("sell");
      expect(snapshot.strength).toBeGreaterThan(0);
      expect(snapshot.strength).toBeLessThanOrEqual(1);
    });
  });
});
