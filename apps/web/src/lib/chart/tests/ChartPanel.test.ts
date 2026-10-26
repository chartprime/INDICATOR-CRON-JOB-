import { describe, expect, it } from "vitest";
import {
  toCandlestick,
  defaultVisibleRange,
  preserveVisibleRange,
  toLineData,
} from "../chartData";
import { fvgHoverDataFromUnknown, hitFvgHover } from "../../../components/chart/fvgHoverData";
import { defaultVisibleWindowMs } from "../resampleBars";
import type { BarFrame } from "../../../types/frames";

function makeBar(overrides: Partial<BarFrame> = {}): BarFrame {
  return {
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000, ts_open: 120_000,
    open: 100, high: 105, low: 95, close: 102, volume: 10, trade_count: 4, closed: true,
    ...overrides,
  } as BarFrame;
}

describe("toCandlestick", () => {
  it("converts ts_open from milliseconds to seconds -- lightweight-charts' UTCTimestamp expects seconds", () => {
    const bar = makeBar({ ts_open: 120_000 });
    expect(toCandlestick(bar).time).toBe(120);
  });

  it("carries OHLC through unchanged", () => {
    const bar = makeBar({ open: 1, high: 2, low: 0.5, close: 1.5 });
    const candle = toCandlestick(bar);
    expect(candle.open).toBe(1);
    expect(candle.high).toBe(2);
    expect(candle.low).toBe(0.5);
    expect(candle.close).toBe(1.5);
  });
});

describe("defaultVisibleRange", () => {
  it("ends exactly at the last bar's own close, in seconds", () => {
    const bar = makeBar({ ts_open: 10 * 60 * 60_000, interval_ms: 60_000 }); // 10h mark, 1m bar
    const range = defaultVisibleRange(bar);
    expect(range.to).toBe((10 * 60 * 60_000 + 60_000) / 1000);
  });

  it("starts exactly defaultVisibleWindowMs before the last bar's close for a 1m bar (2h)", () => {
    const tenHoursMs = 10 * 60 * 60_000;
    const bar = makeBar({ ts_open: tenHoursMs, interval_ms: 60_000 });
    const range = defaultVisibleRange(bar);
    const lastCloseMs = tenHoursMs + 60_000;
    const windowMs = defaultVisibleWindowMs(60_000);
    expect(range.from).toBe((lastCloseMs - windowMs) / 1000);
    expect(lastCloseMs - windowMs).toBeGreaterThan(0); // sanity: this test's setup actually exercises the subtraction, not the clamp
  });

  it("clamps `from` to 0 rather than going negative when the loaded history is shorter than the default window", () => {
    // A 1m bar whose close is only 1 hour after epoch -- far less than
    // the 2h default window for 1m, exactly the "just booted, backfill
    // barely started" case.
    const bar = makeBar({ ts_open: 59 * 60_000, interval_ms: 60_000 });
    const range = defaultVisibleRange(bar);
    expect(range.from).toBe(0);
  });

  it("a coarser interval gets a proportionally wider window than a 1m bar for the same close time", () => {
    const closeAnchorMs = 20 * 24 * 60 * 60_000; // comfortably past every tier's window
    const oneMinuteBar = makeBar({ ts_open: closeAnchorMs - 60_000, interval_ms: 60_000 });
    const oneHourBar = makeBar({ ts_open: closeAnchorMs - 60 * 60_000, interval_ms: 60 * 60_000 });

    const oneMinuteRange = defaultVisibleRange(oneMinuteBar);
    const oneHourRange = defaultVisibleRange(oneHourBar);

    expect(oneMinuteRange.to).toBe(oneHourRange.to); // same close instant either way
    expect(oneHourRange.to - oneHourRange.from).toBeGreaterThan(oneMinuteRange.to - oneMinuteRange.from);
  });
});

describe("toLineData", () => {
  it("emits whitespace entries for nulls so the chart renders a real line break", () => {
    const bars = [makeBar({ ts_open: 0 }), makeBar({ ts_open: 60_000 }), makeBar({ ts_open: 120_000 })];
    const result = toLineData(bars, [null, 5, null]);
    expect(result).toEqual([{ time: 0 }, { time: 60, value: 5 }, { time: 120 }]);
  });

  it("converts every non-null entry's ts_open from milliseconds to seconds, same as toCandlestick", () => {
    const bars = [makeBar({ ts_open: 120_000 })];
    const result = toLineData(bars, [42]);
    expect(result).toEqual([{ time: 120, value: 42 }]);
  });

  it("preserves timestamps as whitespace for an all-null computed series", () => {
    const bars = [makeBar({ ts_open: 0 }), makeBar({ ts_open: 60_000 })];
    expect(toLineData(bars, [null, null])).toEqual([{ time: 0 }, { time: 60 }]);
  });

  it("rejects a length mismatch instead of emitting an undefined/NaN point", () => {
    expect(() => toLineData([makeBar()], [])).toThrow(/equal length/);
  });

  it("inserts a bounded whitespace sentinel across a missing interval", () => {
    const result = toLineData([makeBar({ ts_open: 0 }), makeBar({ ts_open: 600_000 })], [1, 2]);
    expect(result).toEqual([{ time: 0, value: 1 }, { time: 60 }, { time: 600, value: 2 }]);
  });

  it("does not render a computed value for an incomplete historical bucket", () => {
    const result = toLineData([
      makeBar({ ts_open: 0, closed: false }),
      makeBar({ ts_open: 60_000, closed: true }),
    ], [1, 2]);
    expect(result[0]).toEqual({ time: 0 });
  });
});

describe("preserveVisibleRange", () => {
  const bars = [makeBar({ ts_open: 0 }), makeBar({ ts_open: 60_000 }), makeBar({ ts_open: 120_000 })];

  it("preserves a valid user range exactly", () => {
    expect(preserveVisibleRange({ from: 30, to: 150 }, bars)).toEqual({ from: 30, to: 150 });
  });

  it("clamps a reconnect range to newly available history while preserving its width", () => {
    expect(preserveVisibleRange({ from: 120, to: 240 }, bars)).toEqual({ from: 60, to: 180 });
  });

  it("falls back when there is no valid prior range", () => {
    expect(preserveVisibleRange(null, bars)).toBeNull();
    expect(preserveVisibleRange({ from: 5, to: 5 }, bars)).toBeNull();
  });
});

describe("fvgHoverDataFromUnknown", () => {
  it("accepts only complete finite FVG hover payloads so malformed provider output cannot throw from crosshair movement", () => {
    const valid = {
      kind: "bullish" as const,
      time: 1_000,
      levelPrice: 100,
      topPrice: 120,
      bottomPrice: 80,
      displayMode: "boxes" as const,
      bubblePrice: 99,
      buyVolume: 60,
      sellVolume: 40,
      delta: 20,
      score: 7,
    };

    expect(fvgHoverDataFromUnknown([
      valid,
      null,
      { ...valid, kind: "sideways" },
      { ...valid, score: Number.NaN },
      { ...valid, topPrice: Number.NaN },
      { ...valid, topPrice: 80 },
      { ...valid, displayMode: "invalid" },
      { time: 1_000 },
    ])).toEqual([valid]);
    expect(fvgHoverDataFromUnknown({ ...valid })).toEqual([]);
  });

  it("hits the whole visible box, while line mode retains midpoint-only hit testing", () => {
    const event = {
      kind: "bullish" as const,
      time: 1_000,
      levelPrice: 100,
      topPrice: 120,
      bottomPrice: 80,
      bubblePrice: 105,
      buyVolume: 60,
      sellVolume: 40,
      delta: 20,
      score: 7,
      displayMode: "boxes" as const,
    };
    const input = {
      crosshairTimeMs: 1_500,
      cursorY: 82,
      intervalMs: 100,
      lastBarTime: 2_000,
      priceToCoordinate: (price: number) => price,
    };
    expect(hitFvgHover(event, input)).toEqual({ distance: 18, y: 82 });
    expect(hitFvgHover({ ...event, displayMode: "lines" }, input)).toBeNull();
    expect(hitFvgHover(event, { ...input, cursorY: 121 })).toBeNull();
    expect(hitFvgHover(event, { ...input, cursorY: 80 })).toEqual({ distance: 20, y: 80 });
    expect(hitFvgHover(event, { ...input, cursorY: 120 })).toEqual({ distance: 20, y: 120 });
    expect(hitFvgHover(event, { ...input, crosshairTimeMs: 2_001 })).toBeNull();
    expect(hitFvgHover({ ...event, kind: "bearish" }, input)).toEqual({ distance: 18, y: 82 });
    expect(hitFvgHover(event, { ...input, cursorY: 100 })).toEqual({ distance: 0, y: 100 });
    expect(hitFvgHover({ ...event, displayMode: "lines" }, { ...input, cursorY: 100 })).toEqual({ distance: 0, y: 100 });
    expect(hitFvgHover(event, { ...input, crosshairTimeMs: 1_000, cursorY: 105 })).toEqual({ distance: 0, y: 105 });
    expect(hitFvgHover(event, { ...input, priceToCoordinate: () => null })).toBeNull();
    expect(hitFvgHover(event, {
      ...input,
      priceToCoordinate: (price) => price === event.bubblePrice ? null : price,
    })).toEqual({ distance: 18, y: 82 });
    expect(hitFvgHover(event, {
      ...input,
      priceToCoordinate: (price) => 200 - price,
      cursorY: 118,
    })).toEqual({ distance: 18, y: 118 });
  });
});
