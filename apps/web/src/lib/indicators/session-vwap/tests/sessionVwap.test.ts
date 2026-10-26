import { beforeEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { createIndicatorRuntime } from "../../../chart/indicatorRuntime";
import { historicalIndicatorAvailability } from "../../../chart/indicatorRegistry";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import type { LabelData } from "../../../chart/draw/label";
import {
  handlesForOwners,
  resetDrawRegistryForTests,
} from "../../../chart/draw/registry";
import {
  DEFAULT_SESSION_VWAP_SETTINGS,
  SESSION_VWAP_JOIN_COLOR,
  SESSION_VWAP_RETAINED_SESSIONS,
  SESSION_VWAP_SESSION_OPTIONS,
  VWAP_FILL_INNER,
  VWAP_FILL_LOWER_RING,
  VWAP_FILL_UPPER_RING,
  VWAP_LABEL_BAR_OFFSET,
  VWAP_LABEL_OFFSET_X,
  VWAP_LABEL_TEXT_ALIGN,
  VWAP_LOOKBACK_DEFAULT_BARS,
  measureBar,
  retainedSessionSums,
  sessionDeviationOf,
  sessionVwapBandColor,
  sessionVwapFillColor,
  sessionVwapIndicator,
  sessionVwapOutput,
  sessionVwapRingFillColor,
  sessionWindowStartFor,
  typicalPriceOf,
  type SessionVwapSettings,
  type SessionVwapSums,
} from "../sessionVwap";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SESSION = HOUR;
const ID = sessionVwapIndicator.id;

/** A candle whose volume is `volume` and whose typical price is `typical`. */
function candle(ts_open: number, typical = 100, volume = 1): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: MINUTE,
    ts_open,
    open: typical,
    high: typical + 10,
    low: typical - 10,
    close: typical,
    volume,
    trade_count: 1,
    closed: true,
  } as BarFrame;
}

/**
 * The chart's own order: activate on the bars already drawn -- the warm-up
 * replay every page load, reconnect and Historical Mode goes through -- then
 * hand the runtime each following bar as it develops.
 */
function chart(settings: Partial<SessionVwapSettings> = {}, warmup: readonly BarFrame[] = []) {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
  const runtime = createIndicatorRuntime([sessionVwapIndicator as never]);
  const bars: BarFrame[] = [...warmup];
  const full: SessionVwapSettings = {
    ...DEFAULT_SESSION_VWAP_SETTINGS,
    sessionPeriodMs: SESSION,
    ...settings,
  };
  runtime.setActive(new Set([ID]), { [ID]: full }, bars);

  function feed(next: BarFrame) {
    bars.push(next);
    runtime.onBar(next, "APPENDED", bars);
  }

  /** The developing bar again with its updated numbers -- a REPLACED_EDGE. */
  function replace(next: BarFrame) {
    bars[bars.length - 1] = next;
    runtime.onBar(next, "REPLACED_EDGE", bars);
  }

  return {
    runtime,
    bars,
    feed,
    replace,
    output: () => runtime.getOutput(ID)!,
    colors: () => runtime.getLineColors(ID)!,
    apply: (patch: Partial<SessionVwapSettings>) =>
      runtime.updateSettings(ID, { ...full, ...patch }, bars),
    /** The five labels, in the kernel's own creation order (vwap, then the bands). */
    labels: (): LabelData[] =>
      handlesForOwners([runtime.getDrawOwnerId(ID)!])
        .filter((record) => record.kind === "label")
        .map((record) => record.data as LabelData),
  };
}

beforeEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

describe("session windows", () => {
  it("uses Session Delta Profile's own UTC-aligned windows", () => {
    // floor(ts_open / periodMs) * periodMs, the rule in ChartPanel.tsx's
    // applySessionDeltaProfileVisibility.
    expect(sessionWindowStartFor(4 * HOUR + 1, 4 * HOUR)).toBe(4 * HOUR);
    expect(sessionWindowStartFor(4 * HOUR, 4 * HOUR)).toBe(4 * HOUR);
    expect(sessionWindowStartFor(4 * HOUR - 1, 4 * HOUR)).toBe(0);
    expect(sessionWindowStartFor(0, 4 * HOUR)).toBe(0);
  });

  it("offers exactly the session lengths the session profile offers", () => {
    expect(SESSION_VWAP_SESSION_OPTIONS.map((option) => [option.value, option.label])).toEqual([
      [HOUR, "1 Hour"],
      [2 * HOUR, "2 Hours"],
      [3 * HOUR, "3 Hours"],
      [4 * HOUR, "4 Hours"],
      [6 * HOUR, "6 Hours"],
      [12 * HOUR, "12 Hours"],
      [24 * HOUR, "1 Day"],
      [48 * HOUR, "2 Days"],
      [72 * HOUR, "3 Days"],
      [168 * HOUR, "1 Week"],
    ]);
  });

  it("keeps a bounded set of session accumulators", () => {
    const sums = (sessionStartTs: number): SessionVwapSums => ({
      sessionStartTs,
      volume: 1,
      priceVolume: 1,
      priceSquaredVolume: 1,
    });
    const latest = (SESSION_VWAP_RETAINED_SESSIONS + 2) * HOUR;
    const sessions = Array.from({ length: SESSION_VWAP_RETAINED_SESSIONS + 3 }, (_, index) => sums(index * HOUR));
    const kept = retainedSessionSums(sessions, latest, HOUR);
    expect(kept).toHaveLength(SESSION_VWAP_RETAINED_SESSIONS);
    expect(kept[kept.length - 1].sessionStartTs).toBe(latest);
    expect(kept[0].sessionStartTs).toBe(latest - (SESSION_VWAP_RETAINED_SESSIONS - 1) * HOUR);
  });
});

describe("the weighted average and its deviation", () => {
  it("weights a candle by its own volume at its typical price", () => {
    // (110 + 90 + 100) / 3 = 100 over 4 units.
    expect(typicalPriceOf(candle(0, 100))).toBe(100);
    expect(measureBar(candle(0, 100, 4))).toEqual({ volume: 4, priceVolume: 400, priceSquaredVolume: 40_000 });
    // A close away from the middle of the range: (130 + 100 + 106) / 3 = 112, not the close.
    expect(typicalPriceOf({ ...candle(0, 100), high: 130, low: 100, close: 106 })).toBe(112);
  });

  it("ignores a candle that traded nothing or whose price is unusable", () => {
    expect(measureBar(candle(0, 100, 0))).toEqual({ volume: 0, priceVolume: 0, priceSquaredVolume: 0 });
    expect(measureBar(candle(0, 100, Number.NaN))).toEqual({ volume: 0, priceVolume: 0, priceSquaredVolume: 0 });
    expect(measureBar(candle(0, -5, 3))).toEqual({ volume: 0, priceVolume: 0, priceSquaredVolume: 0 });
  });

  it("computes the volume-weighted average and deviation from the running sums", () => {
    // 4 @ 100 and 4 @ 120: 880 / 8 = 110, and
    // σ² = (4·100² + 4·120²)/8 − 110² = 100.
    const sums: SessionVwapSums = { sessionStartTs: 0, volume: 8, priceVolume: 880, priceSquaredVolume: 97_600 };
    expect(sessionDeviationOf(sums)).toBeCloseTo(10, 9);
    expect(sessionVwapOutput(sums, 1, 2)).toEqual({
      vwap: 110,
      upper1: 120,
      lower1: 100,
      upper2: 130,
      lower2: 90,
    });
  });

  it("collapses the bands onto the average when every bar traded at one price", () => {
    const sums: SessionVwapSums = { sessionStartTs: 0, volume: 11, priceVolume: 550, priceSquaredVolume: 27_500 };
    expect(sessionVwapOutput(sums, 1, 2)).toEqual({ vwap: 50, upper1: 50, lower1: 50, upper2: 50, lower2: 50 });
  });

  it("orders the two band widths so the inner band is never outside the outer one", () => {
    const sums: SessionVwapSums = { sessionStartTs: 0, volume: 2, priceVolume: 300, priceSquaredVolume: 50_000 };
    const deviation = sessionDeviationOf(sums);
    const crossed = sessionVwapOutput(sums, 3, 1);
    expect(crossed.upper1).toBeCloseTo(150 + deviation, 9);
    expect(crossed.upper2).toBeCloseTo(150 + 3 * deviation, 9);
  });

  it("clamps each band width into the range the settings offer", () => {
    const sums: SessionVwapSums = { sessionStartTs: 0, volume: 2, priceVolume: 300, priceSquaredVolume: 50_000 };
    const deviation = sessionDeviationOf(sums);
    const wild = sessionVwapOutput(sums, 0.1, 10);
    expect(wild.upper1).toBeCloseTo(150 + 0.5 * deviation, 9);
    expect(wild.upper2).toBeCloseTo(150 + 4 * deviation, 9);
  });

  it("has no reading before any volume has been observed", () => {
    expect(sessionVwapOutput({ sessionStartTs: 0, volume: 0, priceVolume: 0, priceSquaredVolume: 0 }, 1, 2)).toEqual({
      vwap: null,
      upper1: null,
      lower1: null,
      upper2: null,
      lower2: null,
    });
  });
});

describe("drawing a session", () => {
  it("draws a whole session from the bars a warm-up replay hands it", () => {
    // Every bar of a replay arrives with no live trades at all, which is also
    // every bar of Historical Mode: the bar's own volume is what draws it.
    const { output } = chart({}, [candle(0, 100, 4), candle(MINUTE, 120, 4)]);
    expect(output().vwap).toEqual([100, 110]);
    expect(output().upper1[1]).toBeCloseTo(120, 9);
    expect(output().lower2[1]).toBeCloseTo(90, 9);
  });

  it("starts each session's average from that session's own bars", () => {
    const { output } = chart({}, [candle(0, 100, 4), candle(HOUR, 50, 2), candle(HOUR + MINUTE, 50, 2)]);
    expect(output().vwap).toEqual([100, 50, 50]);
  });

  it("paints the bar that walks up to a session's end transparent, so the two sessions never join", () => {
    const { output, colors } = chart({}, [
      candle(0, 100, 1),
      candle(59 * MINUTE, 100, 1),
      candle(HOUR, 200, 2),
      candle(HOUR + MINUTE, 300, 2),
    ]);
    // Every value is plotted. Only the colour of the session's LAST bar changes:
    // lightweight-charts strokes a segment with the colour of the point it starts
    // from (walkLine switches style after the stroke), so hiding the new session's
    // first bar instead would hide the wrong segment and leave the steep join.
    expect(output().vwap).toEqual([100, 100, 200, 250]);
    expect(colors().vwap).toEqual([
      DEFAULT_SESSION_VWAP_SETTINGS.vwapColor,
      SESSION_VWAP_JOIN_COLOR,
      DEFAULT_SESSION_VWAP_SETTINGS.vwapColor,
      DEFAULT_SESSION_VWAP_SETTINGS.vwapColor,
    ]);
    expect(colors().upper2[1]).toBe(SESSION_VWAP_JOIN_COLOR);
    expect(colors().lower1[1]).toBe(SESSION_VWAP_JOIN_COLOR);
    expect(colors().upper1[2]).toBe(sessionVwapBandColor(DEFAULT_SESSION_VWAP_SETTINGS.band1Color, 1));
  });

  it("leaves a bar alone when it is longer than the session itself", () => {
    // A four-hour bar cannot resolve a one-hour boundary, so nothing is hidden
    // rather than blanking the whole line.
    const fourHour = { ...candle(0, 100, 1), interval_ms: 4 * HOUR };
    const { colors } = chart({ sessionPeriodMs: HOUR }, [fourHour]);
    expect(colors().vwap).toEqual([DEFAULT_SESSION_VWAP_SETTINGS.vwapColor]);
  });

  it("carries the running average forward as the session develops", () => {
    const { feed, output } = chart();
    feed(candle(0, 100, 4));
    feed(candle(MINUTE, 150, 4));
    expect(output().vwap).toEqual([100, 125]);
  });

  it("keeps the hidden join while that bar develops", () => {
    const { feed, replace, output, colors } = chart();
    feed(candle(0, 100, 1));
    feed(candle(59 * MINUTE, 200, 1));
    // Both bars are still in the first session: (1 @ 100 + 1 @ 200) / 2.
    expect(output().vwap).toEqual([100, 150]);
    expect(colors().vwap[1]).toBe(SESSION_VWAP_JOIN_COLOR);
    // The bar's own numbers change as it trades, and it stays the join.
    replace(candle(59 * MINUTE, 220, 3));
    expect(output().vwap).toEqual([100, 190]);
    expect(colors().vwap[1]).toBe(SESSION_VWAP_JOIN_COLOR);
    expect(output().vwap).toHaveLength(2);
  });

  it("takes a developing bar's earlier numbers back out when it is re-delivered", () => {
    const { feed, replace, output } = chart();
    feed(candle(0, 100, 2));
    expect(output().vwap).toEqual([100]);
    // The same bar a minute later: 4 units at 120, not 2 at 100 plus 4 at 120.
    replace(candle(0, 120, 4));
    expect(output().vwap).toEqual([120]);
    expect(output().vwap).toHaveLength(1);
  });

  it("a bar that opened with no volume and then trades takes nothing of the bar before it back out", () => {
    const { feed, replace, output } = chart({}, [candle(0, 100, 1)]);
    feed(candle(MINUTE, 120, 0));
    replace(candle(MINUTE, 120, 1));
    expect(output().vwap.at(-1)).toBe(110);
  });

  it("holds the average on a bar that traded nothing rather than breaking the line", () => {
    const { feed, output } = chart();
    feed(candle(0, 100, 2));
    feed(candle(MINUTE, 100, 0));
    feed(candle(2 * MINUTE, 200, 2));
    expect(output().vwap).toEqual([100, 100, 150]);
  });

  it("forgets the accumulation when the instrument changes underneath it", () => {
    const { feed, output, bars, runtime } = chart();
    feed(candle(0, 100, 1));
    const other = { ...candle(MINUTE, 300, 1), symbol: "ETH-USDT" } as BarFrame;
    bars.push(other);
    runtime.onBar(other, "APPENDED", bars);
    expect(output().vwap).toEqual([100, 300]);
  });
});

describe("the lookback anchor", () => {
  /** Bars one minute apart, each with its own typical price and the same volume. */
  function series(count: number): BarFrame[] {
    return Array.from({ length: count }, (_, index) =>
      candle(index * MINUTE, 100 + index, 2),
    );
  }

  it("measures the window from the anchor to the newest bar, and nothing before it", () => {
    const bars = series(12);
    const { output } = chart({ anchor: "lookback", lookbackBars: 10 }, bars);
    // The newest bar is the twelfth, so a ten-bar lookback anchors on the third:
    // the two bars before it are drawn as nothing, and the rest is the running
    // average of the typical prices (equal volumes).
    expect(output().vwap).toEqual(
      bars.map((_, index) => (index < 2 ? null : 101 + index / 2)),
    );
  });

  it("keeps the anchor put while new bars arrive, instead of rolling", () => {
    const { feed, output } = chart(
      { anchor: "lookback", lookbackBars: 10 },
      series(12),
    );
    expect(output().vwap[11]).toBeCloseTo(106.5, 6);
    feed(candle(12 * MINUTE, 200, 2));
    // The window keeps growing from where it was anchored: (102 + … + 111 + 200)
    // / 11, not the rolling (103 + … + 111 + 200) / 10.
    expect(output().vwap[12]).toBeCloseTo(1265 / 11, 6);
  });

  it("hides no session join, because a lookback window is not a session", () => {
    const { output, colors } = chart({ anchor: "lookback", lookbackBars: 50 }, [
      candle(0, 100, 1),
      candle(59 * MINUTE, 100, 1),
      candle(HOUR, 100, 1),
    ]);
    // The middle bar ends a one-hour session, but nothing joins here.
    expect(output().vwap).toEqual([100, 100, 100]);
    expect(colors().vwap).not.toContain(SESSION_VWAP_JOIN_COLOR);
  });
});

describe("the labels beside the lines", () => {
  it("names the average's price and each band's sigma on the newest bar", () => {
    const { feed, labels } = chart();
    // 1 @ 100 and 1 @ 200: 150 ± 50.
    feed(candle(0, 100, 1));
    feed(candle(MINUTE, 200, 1));
    expect(labels().map((label) => label.text)).toEqual([
      "VWAP: 150.00",
      "+1",
      "-1",
      "+2",
      "-2",
    ]);
    // Every label rides the newest bar, at its own line's price.
    expect(labels().map((label) => label.time)).toEqual(Array(5).fill(MINUTE));
    expect(labels().map((label) => label.price)).toEqual([150, 200, 100, 250, 50]);
  });

  it("anchors every label's text on its left, one bar past the newest bar", () => {
    const { feed, labels } = chart();
    feed(candle(0, 100, 4));
    for (const label of labels()) {
      // "left" puts the text's own left edge at the anchor, so the text starts
      // at the line's end and reads away to the right, with no x offset -- and
      // one bar further on, into the empty space beside the last candle.
      expect(label.textAlign).toBe(VWAP_LABEL_TEXT_ALIGN);
      expect(label.textAlign).toBe("left");
      expect(label.offsetX).toBe(VWAP_LABEL_OFFSET_X);
      expect(label.offsetX).toBe(0);
      expect(label.barOffset).toBe(VWAP_LABEL_BAR_OFFSET);
      expect(label.barOffset).toBe(1);
    }
  });

  it("clears a band's label when the bands are switched off, keeping the average's", () => {
    const { feed, labels, apply } = chart();
    feed(candle(0, 100, 1));
    feed(candle(MINUTE, 200, 1));
    apply({ showBands: false });
    // Labels follow the settings on the next bar, the same live path the line
    // colours take; the average's own label never hides.
    feed(candle(2 * MINUTE, 200, 1));
    const texts = labels().map((label) => label.text);
    expect(texts[0]).not.toBe("");
    expect(texts.slice(1)).toEqual(["", "", "", ""]);
  });

  it("renames the bands from the sigmas they were actually plotted at", () => {
    const { feed, labels, apply } = chart();
    feed(candle(0, 100, 1));
    feed(candle(MINUTE, 200, 1));
    // Crossing the two sliders must not leave a label claiming the wrong band:
    // the inner pair always carries the smaller sigma, exactly as it is plotted.
    apply({ band1Sigma: 3, band2Sigma: 0.5 });
    expect(labels().map((label) => label.text)).toEqual([
      "VWAP: 150.00",
      "+0.5",
      "-0.5",
      "+3",
      "-3",
    ]);
  });

  it("follows the newest bar as it arrives, and has nothing to say without volume", () => {
    const { feed, labels } = chart();
    feed(candle(0, 100, 0));
    expect(labels().map((label) => label.text)).toEqual(["", "", "", "", ""]);
    feed(candle(MINUTE, 120, 4));
    expect(labels()[0].time).toBe(MINUTE);
    expect(labels()[0].text).toBe("VWAP: 120.00");
  });
});

describe("the fills between the bands", () => {
  it("fills the inner pair and both rings, each band keeping a point per bar", () => {
    const { feed, runtime } = chart();
    feed(candle(0, 100, 1));
    feed(candle(MINUTE, 200, 1));
    expect(runtime.getFillKeys(ID)).toEqual([
      VWAP_FILL_INNER,
      VWAP_FILL_UPPER_RING,
      VWAP_FILL_LOWER_RING,
    ]);
    // 1 @ 100 and 1 @ 200: 150 ± 50, so the inner pair is 200 / 100 and the
    // outer pair 250 / 50.
    expect(runtime.getFillPoints(ID, VWAP_FILL_INNER)!.points).toEqual([
      { time: 0, valueA: 100, valueB: 100 },
      { time: MINUTE, valueA: 200, valueB: 100 },
    ]);
    expect(runtime.getFillPoints(ID, VWAP_FILL_UPPER_RING)!.points[1]).toEqual({
      time: MINUTE,
      valueA: 200,
      valueB: 250,
    });
    expect(runtime.getFillPoints(ID, VWAP_FILL_LOWER_RING)!.points[1]).toEqual({
      time: MINUTE,
      valueA: 100,
      valueB: 50,
    });
  });

  it("paints each fill from its own settings colour, the ring fainter than the inner band", () => {
    const { feed, runtime, apply } = chart();
    feed(candle(0, 100, 1));
    expect(runtime.getFillPoints(ID, VWAP_FILL_INNER)!.options?.colorAbove).toBe(
      sessionVwapFillColor(DEFAULT_SESSION_VWAP_SETTINGS.fillColor),
    );
    const ring = runtime.getFillPoints(ID, VWAP_FILL_UPPER_RING)!.options;
    expect(ring?.colorAbove).toBe(
      sessionVwapRingFillColor(DEFAULT_SESSION_VWAP_SETTINGS.ringFillColor),
    );
    expect(ring?.colorBelow).toBe(ring?.colorAbove);
    // The two colour inputs are recompute fields, so an edit reaches the fill.
    apply({ fillColor: "#123456" });
    expect(runtime.getFillPoints(ID, VWAP_FILL_INNER)!.options?.colorAbove).toBe(
      sessionVwapFillColor("#123456"),
    );
  });

  it("drops every fill while the bands are switched off, keeping each band aligned", () => {
    const { feed, runtime, apply } = chart();
    feed(candle(0, 100, 1));
    apply({ showBands: false });
    feed(candle(MINUTE, 200, 1));
    for (const key of runtime.getFillKeys(ID)!) {
      const points = runtime.getFillPoints(ID, key)!.points;
      expect(points).toHaveLength(2);
      expect(points[1]).toBeNull();
    }
  });
  it("drops one region at a time when its own toggle is switched off", () => {
    const { feed, runtime, apply } = chart();
    feed(candle(0, 100, 1));
    apply({ showFill: false });
    feed(candle(MINUTE, 200, 1));
    expect(runtime.getFillPoints(ID, VWAP_FILL_INNER)!.points[1]).toBeNull();
    expect(
      runtime.getFillPoints(ID, VWAP_FILL_UPPER_RING)!.points[1],
    ).not.toBeNull();
    apply({ showRingFill: false });
    feed(candle(2 * MINUTE, 200, 1));
    expect(runtime.getFillPoints(ID, VWAP_FILL_UPPER_RING)!.points[2]).toBeNull();
    // The colours survive the toggle, so switching a region back on needs no
    // colour edit: the settings are the same, only the answer to "draw it?"
    // changed.
    expect(runtime.getFillPoints(ID, VWAP_FILL_INNER)!.options?.colorAbove).toBe(
      sessionVwapFillColor(DEFAULT_SESSION_VWAP_SETTINGS.fillColor),
    );
  });
});

describe("registration", () => {
  it("is registered as a technical overlay whose lines never shadow another indicator's", () => {
    expect(sessionVwapIndicator.id).toBe("sessionVwap");
    expect(sessionVwapIndicator.category).toBe("technical");
    expect(sessionVwapIndicator.placement).toEqual({ kind: "overlay" });
    expect(sessionVwapIndicator.lines.map((line) => line.key)).toEqual(["vwap", "upper1", "lower1", "upper2", "lower2"]);
  });

  it("starts session-anchored, with the lookback waiting for the other anchor", () => {
    expect(DEFAULT_SESSION_VWAP_SETTINGS.anchor).toBe("session");
    expect(DEFAULT_SESSION_VWAP_SETTINGS.lookbackBars).toBe(VWAP_LOOKBACK_DEFAULT_BARS);
  });

  it("works in Historical Mode, where candles are all there is", () => {
    // It needs nothing but OHLCV, so every archived instrument can draw it.
    expect(historicalIndicatorAvailability("sessionVwap", new Set(["ohlcv"]), "DATABENTO")).toEqual({ available: true, reason: null });
    expect(historicalIndicatorAvailability("sessionVwap", new Set([]), "DATABENTO").available).toBe(false);
  });
});
