import { beforeEach, describe, expect, it, vi } from "vitest";
import { ta } from "../index";
import {
  beginStreamCreationWindow,
  endStreamCreationWindow,
  resetStreamCreationGuardForTests,
} from "../creationGuard";

beforeEach(() => {
  resetStreamCreationGuardForTests();
  beginStreamCreationWindow();
});

function pushAll(
  stream: { push(value: number, replace: boolean): unknown },
  values: readonly number[],
): unknown[] {
  return values.map((value) => stream.push(value, false));
}

describe("ta -- simple single-value indicators, hand-computed exact values", () => {
  it("sma(3) is the plain moving average, matching the house-standard fixture", () => {
    const results = pushAll(ta.sma(3), [1, 2, 3, 4, 5]);
    expect(results).toEqual([null, null, 2, 3, 4]);
  });

  it("ema(3) seeds from the first value directly (this library's own convention, verified, not TA.01's SMA-seed convention), then applies k=2/(length+1) recursively", () => {
    const results = pushAll(ta.ema(3), [1, 2, 3, 4, 5]);
    const k = 2 / (3 + 1);
    expect(results[0]).toBe(1); // seed = first value
    expect(results[1]).toBeCloseTo(2 * k + 1 * (1 - k), 10);
    expect(results[2]).toBeCloseTo(2.25, 10);
  });

  it("rsi(3) is 100 for a strictly increasing series (zero losses)", () => {
    const results = pushAll(ta.rsi(3), [1, 2, 3, 4, 5]);
    expect(results[3]).toBe(100);
    expect(results[4]).toBe(100);
  });

  it("mom(1) is the plain one-bar difference once stable", () => {
    const s = ta.mom(1);
    s.push(10, false);
    expect(s.push(15, false)).toBe(5);
    expect(s.push(12, false)).toBe(-3);
  });

  it("roc(1) is the one-bar rate of change as a decimal ratio once stable (this library's own convention, verified: 0.1, not 10)", () => {
    const s = ta.roc(1);
    s.push(10, false);
    expect(s.push(11, false)).toBeCloseTo(0.1, 6);
  });
});

describe("ta -- OHLC/composite indicators, adapter shape and sanity", () => {
  function bar(high: number, low: number, close: number) {
    return { high, low, close };
  }

  it("atr accepts a high/low/close candle and stays null before it's stable", () => {
    const s = ta.atr(3);
    expect(s.push(bar(10, 5, 8), false)).toBeNull();
    expect(s.push(bar(11, 6, 9), false)).toBeNull();
    const value = s.push(bar(12, 7, 10), false);
    expect(typeof value).toBe("number");
    expect(Number.isFinite(value as number)).toBe(true);
  });

  it("bollinger returns a {lower, middle, upper} band once stable, middle equal to the plain SMA", () => {
    const bands = ta.bollinger(3, 2);
    bands.push(1, false);
    bands.push(2, false);
    const result = bands.push(3, false)!;
    expect(result.middle).toBeCloseTo(2, 10);
    expect(result.upper).toBeGreaterThan(result.middle);
    expect(result.lower).toBeLessThan(result.middle);
  });

  it("macd wraps three internal EMAs and returns a {macd, signal, histogram} result once stable", () => {
    const m = ta.macd(2, 4, 2);
    let result: { macd: number; signal: number; histogram: number } | null =
      null;
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      result = m.push(value, false);
    expect(result).not.toBeNull();
    expect(typeof result!.macd).toBe("number");
    expect(typeof result!.signal).toBe("number");
    expect(result!.histogram).toBeCloseTo(result!.macd - result!.signal, 10);
  });

  it("stoch accepts a candle and returns a {stochK, stochD, stochJ} result once stable", () => {
    const s = ta.stoch(3, 1, 3);
    let result: { stochK: number; stochD: number; stochJ: number } | null =
      null;
    for (const [h, l, c] of [
      [10, 5, 8],
      [11, 6, 9],
      [12, 7, 10],
      [13, 8, 11],
      [14, 9, 12],
    ]) {
      result = s.push(bar(h, l, c), false);
    }
    expect(result).not.toBeNull();
    expect(typeof result!.stochK).toBe("number");
  });

  it("keltner returns a {lower, middle, upper} band, accepting a candle", () => {
    const k = ta.keltner(3, 3, 2);
    let result: { lower: number; middle: number; upper: number } | null = null;
    for (const [h, l, c] of [
      [10, 5, 8],
      [11, 6, 9],
      [12, 7, 10],
      [13, 8, 11],
    ]) {
      result = k.push(bar(h, l, c), false);
    }
    expect(result).not.toBeNull();
    expect(result!.upper).toBeGreaterThan(result!.lower);
  });

  it("adx accepts a candle and produces a finite reading once stable", () => {
    const a = ta.adx(3);
    let result: number | null = null;
    for (const [h, l, c] of [
      [10, 5, 8],
      [12, 6, 10],
      [14, 8, 12],
      [16, 10, 14],
      [18, 12, 16],
      [20, 14, 18],
      [22, 16, 20],
    ]) {
      result = a.push(bar(h, l, c), false);
    }
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
  });

  it("psar accepts a high/low candle and produces a finite reading once stable", () => {
    const p = ta.psar(0.02, 0.2);
    let result: number | null = null;
    for (const [h, l] of [
      [10, 8],
      [11, 9],
      [12, 10],
      [13, 11],
    ]) {
      result = p.push({ high: h, low: l }, false);
    }
    expect(typeof result).toBe("number");
  });

  it("vwap accepts a high/low/close/volume candle and produces a finite reading", () => {
    const v = ta.vwap();
    const result = v.push({ high: 10, low: 8, close: 9, volume: 100 }, false);
    expect(typeof result).toBe("number");
  });

  it("obv accepts an open/high/low/close/volume candle", () => {
    const o = ta.obv(3);
    const result = o.push(
      { open: 8, high: 10, low: 7, close: 9, volume: 100 },
      false,
    );
    expect(result === null || typeof result === "number").toBe(true);
  });

  it("mfi accepts a high/low/close/volume candle and stays null before it's stable", () => {
    const m = ta.mfi(3);
    expect(
      m.push({ high: 10, low: 8, close: 9, volume: 100 }, false),
    ).toBeNull();
  });

  it("vwma, wma, rma, alma, cci accept their documented input shapes without throwing", () => {
    expect(() =>
      ta.vwma(2).push({ high: 10, low: 8, close: 9, volume: 100 }, false),
    ).not.toThrow();
    expect(() => ta.wma(2).push(5, false)).not.toThrow();
    expect(() => ta.rma(2).push(5, false)).not.toThrow();
    expect(() => ta.alma(2).push(5, false)).not.toThrow();
    expect(() => ta.cci(2).push(bar(10, 8, 9), false)).not.toThrow();
  });
});

describe("ta -- TA.02b coverage extension, adapter shape and sanity (same generic adapter, no new mechanism)", () => {
  function bar(high: number, low: number, close: number) {
    return { high, low, close };
  }
  function barV(high: number, low: number, close: number, volume: number) {
    return { high, low, close, volume };
  }
  // A realistic-enough OHLC(V) walk to warm up every wrapped indicator's own
  // lookback, whatever it is -- not tuned per indicator.
  const CANDLES = Array.from({ length: 60 }, (_, index) => {
    const close = 100 + index + Math.sin(index / 3) * 4;
    return {
      high: close + 2,
      low: close - 2,
      close,
      volume: 1_000 + index * 7,
    };
  });

  it("hma, tema, dema, kama, trix, cmo, dpo, ulcerIndex, tr, ad, nvi, pvi (plain price/candle -> single number) settle to a finite number", () => {
    let trResult: number | null = null;
    let adResult: number | null = null;
    let nviResult: number | null = null;
    let pviResult: number | null = null;
    const hma = ta.hma(3);
    const tema = ta.tema(3);
    const dema = ta.dema(3);
    const kama = ta.kama(3);
    const trix = ta.trix(3);
    const cmo = ta.cmo(3);
    const dpo = ta.dpo(3);
    const ulcerIndex = ta.ulcerIndex(3);
    const tr = ta.tr();
    const ad = ta.ad();
    const nvi = ta.nvi();
    const pvi = ta.pvi();
    let hmaResult: number | null = null;
    let temaResult: number | null = null;
    let demaResult: number | null = null;
    let kamaResult: number | null = null;
    let trixResult: number | null = null;
    let cmoResult: number | null = null;
    let dpoResult: number | null = null;
    let ulcerResult: number | null = null;
    for (const candle of CANDLES) {
      hmaResult = hma.push(candle.close, false);
      temaResult = tema.push(candle.close, false);
      demaResult = dema.push(candle.close, false);
      kamaResult = kama.push(candle.close, false);
      trixResult = trix.push(candle.close, false);
      cmoResult = cmo.push(candle.close, false);
      dpoResult = dpo.push(candle.close, false);
      ulcerResult = ulcerIndex.push(candle.close, false);
      trResult = tr.push(candle, false);
      adResult = ad.push(
        barV(candle.high, candle.low, candle.close, candle.volume),
        false,
      );
      nviResult = nvi.push(
        barV(candle.high, candle.low, candle.close, candle.volume),
        false,
      );
      pviResult = pvi.push(
        barV(candle.high, candle.low, candle.close, candle.volume),
        false,
      );
    }
    for (const value of [
      hmaResult,
      temaResult,
      demaResult,
      kamaResult,
      trixResult,
      cmoResult,
      dpoResult,
      ulcerResult,
      trResult,
      adResult,
      nviResult,
      pviResult,
    ]) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value as number)).toBe(true);
    }
  });

  it("williamsR, ao, ultimateOscillator, fisherTransform, stochasticRsi, cvi, natr, cmf, kvo, emv, forceIndex (HighLow(Close)(Volume) -> single number) settle to a finite number", () => {
    const williamsR = ta.williamsR(3);
    const ao = ta.ao(2, 4);
    const ultimateOscillator = ta.ultimateOscillator(3, 5, 7);
    const fisherTransform = ta.fisherTransform(3);
    const stochasticRsi = ta.stochasticRsi(3);
    const cvi = ta.cvi(3);
    const natr = ta.natr(3);
    const cmf = ta.cmf(3);
    const kvo = ta.kvo(2, 4);
    const emv = ta.emv(3);
    const forceIndex = ta.forceIndex(3);
    let results: (number | null)[] = [];
    for (const candle of CANDLES) {
      results = [
        williamsR.push(candle, false),
        ao.push(candle, false),
        ultimateOscillator.push(candle, false),
        fisherTransform.push(candle, false),
        stochasticRsi.push(candle.close, false),
        cvi.push(candle, false),
        natr.push(candle, false),
        cmf.push(
          barV(candle.high, candle.low, candle.close, candle.volume),
          false,
        ),
        kvo.push(
          barV(candle.high, candle.low, candle.close, candle.volume),
          false,
        ),
        emv.push(
          barV(candle.high, candle.low, candle.close, candle.volume),
          false,
        ),
        forceIndex.push(
          barV(candle.high, candle.low, candle.close, candle.volume),
          false,
        ),
      ];
    }
    for (const value of results) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value as number)).toBe(true);
    }
  });

  it("kst, ppo, pvo, adosc and zigzag accept their documented input without throwing", () => {
    expect(() =>
      ta
        .kst({
          roc1: 1,
          roc2: 2,
          roc3: 3,
          roc4: 4,
          sma1: 1,
          sma2: 1,
          sma3: 1,
          sma4: 1,
        })
        .push(100, false),
    ).not.toThrow();
    expect(() => ta.ppo(2, 4).push(100, false)).not.toThrow();
    expect(() => ta.pvo(2, 4).push(1_000, false)).not.toThrow();
    expect(() =>
      ta.adosc(3, 10).push(barV(102, 98, 100, 1_000), false),
    ).not.toThrow();
    expect(() => ta.zigzag(5).push(bar(102, 98, 100), false)).not.toThrow();
  });

  it("linreg returns its documented prediction, slope and intercept object -- it is not a scalar line", () => {
    const linreg = ta.linreg(3);
    linreg.push(1, false);
    linreg.push(2, false);
    const result = linreg.push(3, false);
    expect(result).toEqual({ prediction: 4, slope: 1, intercept: 1 });
  });

  it("emv forwards its optional scale control, which materially changes the output unit", () => {
    const defaultScale = ta.emv(2);
    const unitScale = ta.emv(2, 1);
    let defaultResult: number | null = null;
    let unitResult: number | null = null;
    for (const candle of CANDLES) {
      defaultResult = defaultScale.push(candle, false);
      unitResult = unitScale.push(candle, false);
    }
    expect(defaultResult).not.toBeNull();
    expect(unitResult).not.toBeNull();
    expect(unitResult).not.toBe(defaultResult);
  });

  it("superTrend returns a {supertrend, trend} result once stable, trend is one of the library's two signal strings", () => {
    const s = ta.superTrend(3, 2);
    let result: { supertrend: number; trend: string } | null = null;
    for (const candle of CANDLES) result = s.push(candle, false);
    expect(result).not.toBeNull();
    expect(typeof result!.supertrend).toBe("number");
    expect(["BULLISH", "BEARISH"]).toContain(result!.trend);
  });

  it("ichimoku returns a {base, conversion, spanA, spanB} result once stable, accepting a high/low candle", () => {
    const i = ta.ichimoku(3, 2, 5);
    let result: {
      base: number;
      conversion: number;
      spanA: number;
      spanB: number;
    } | null = null;
    for (const candle of CANDLES) result = i.push(candle, false);
    expect(result).not.toBeNull();
    for (const key of ["base", "conversion", "spanA", "spanB"] as const) {
      expect(typeof result![key]).toBe("number");
    }
  });

  it("aroon returns a {aroonDown, aroonUp} result once stable, each within the documented 0-100 range", () => {
    const a = ta.aroon(3);
    let result: { aroonDown: number; aroonUp: number } | null = null;
    for (const candle of CANDLES) result = a.push(candle, false);
    expect(result).not.toBeNull();
    for (const key of ["aroonDown", "aroonUp"] as const) {
      expect(result![key]).toBeGreaterThanOrEqual(0);
      expect(result![key]).toBeLessThanOrEqual(100);
    }
  });

  it("vortex returns a {plus, minus} result once stable, accepting a high/low/close candle", () => {
    const v = ta.vortex(3);
    let result: { plus: number; minus: number } | null = null;
    for (const candle of CANDLES) result = v.push(candle, false);
    expect(result).not.toBeNull();
    expect(typeof result!.plus).toBe("number");
    expect(typeof result!.minus).toBe("number");
  });

  it("elderRay returns a {bullPower, bearPower} result once stable, accepting a high/low/close candle", () => {
    const e = ta.elderRay(3);
    let result: { bullPower: number; bearPower: number } | null = null;
    for (const candle of CANDLES) result = e.push(candle, false);
    expect(result).not.toBeNull();
    expect(typeof result!.bullPower).toBe("number");
    expect(typeof result!.bearPower).toBe("number");
  });

  it("donchian returns a {lower, middle, upper} band once stable, lower <= middle <= upper", () => {
    const d = ta.donchian(3);
    let result: { lower: number; middle: number; upper: number } | null = null;
    for (const candle of CANDLES) result = d.push(candle, false);
    expect(result).not.toBeNull();
    expect(result!.lower).toBeLessThanOrEqual(result!.middle);
    expect(result!.middle).toBeLessThanOrEqual(result!.upper);
  });

  it("ttmSqueeze returns a {isSqueezed, momentum} result once stable, accepting a high/low/close candle", () => {
    const t = ta.ttmSqueeze(20, 2, 20, 1.5);
    let result: { isSqueezed: boolean; momentum: number } | null = null;
    for (const candle of CANDLES) result = t.push(candle, false);
    expect(result).not.toBeNull();
    expect(typeof result!.isSqueezed).toBe("boolean");
    expect(typeof result!.momentum).toBe("number");
  });
});

describe("ta -- live replace semantics forward correctly through the adapter", () => {
  it("a replace:true push on sma revises the same slot rather than appending a new one -- matches a straight push of the same final value, not one bar longer", () => {
    const withReplace = ta.sma(3);
    withReplace.push(1, false);
    withReplace.push(2, false);
    withReplace.push(3, false);
    const revised = withReplace.push(999, true); // revise bar index 2 (the "3") to 999

    const straight = ta.sma(3);
    straight.push(1, false);
    straight.push(2, false);
    const straightAtSameSlot = straight.push(999, false); // bar index 2 pushed straight as 999

    expect(revised).toBe(straightAtSameSlot);
  });
});

describe("ta -- the persistence-footgun guard is wired through every factory, not just the sampled ones", () => {
  // Args that satisfy each factory's own signature. Any factory added to `ta`
  // without an entry here fails the completeness check below, so a new factory
  // cannot silently ship unguarded.
  const factoryArgs: Record<keyof typeof ta, unknown[]> = {
    sma: [3],
    ema: [3],
    wma: [3],
    rma: [3],
    vwma: [3],
    alma: [3],
    rsi: [3],
    macd: [2, 4, 2],
    stoch: [3, 1, 3],
    cci: [3],
    roc: [3],
    mom: [3],
    atr: [3],
    bollinger: [3, 2],
    keltner: [3, 3, 2],
    adx: [3],
    psar: [0.02, 0.2],
    vwap: [],
    obv: [3],
    mfi: [3],
    hma: [3],
    tema: [3],
    dema: [3],
    superTrend: [3, 2],
    ichimoku: [9, 26, 52],
    aroon: [3],
    zigzag: [5],
    kama: [3],
    vortex: [3],
    linreg: [3],
    williamsR: [3],
    ao: [2, 4],
    ultimateOscillator: [3, 5, 7],
    trix: [3],
    cmo: [3],
    fisherTransform: [3],
    stochasticRsi: [3],
    elderRay: [3],
    dpo: [3],
    kst: [],
    ppo: [2, 4],
    donchian: [3],
    cvi: [3],
    ulcerIndex: [3],
    ttmSqueeze: [20, 2, 20, 1.5],
    natr: [3],
    tr: [],
    cmf: [3],
    ad: [],
    kvo: [2, 4],
    nvi: [],
    pvi: [],
    emv: [3],
    forceIndex: [3],
    pvo: [2, 4],
    adosc: [3, 10],
    stdev: [3],
    highest: [3],
    lowest: [3],
    pivotHigh: [2, 2],
    pivotLow: [2, 2],
    prev: [1],
    crossover: [],
    crossunder: [],
  };

  it("covers every key actually exported on `ta` -- no factory left unchecked", () => {
    expect(Object.keys(factoryArgs).sort()).toEqual(Object.keys(ta).sort());
  });

  it("every single factory logs the guard error, naming itself, when called outside a creation window", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const [name, args] of Object.entries(factoryArgs)) {
      error.mockClear();
      endStreamCreationWindow();
      const factory = ta[name as keyof typeof ta] as (
        ...a: unknown[]
      ) => unknown;

      expect(() => factory(...args)).not.toThrow();

      expect(
        error,
        `ta.${name}() did not warn outside a creation window`,
      ).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain(`ta.${name}()`);
    }

    error.mockRestore();
    beginStreamCreationWindow();
  });

  it("no factory warns when called inside a legitimate creation window", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const [name, args] of Object.entries(factoryArgs)) {
      beginStreamCreationWindow();
      (ta[name as keyof typeof ta] as (...a: unknown[]) => unknown)(...args);
    }

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
