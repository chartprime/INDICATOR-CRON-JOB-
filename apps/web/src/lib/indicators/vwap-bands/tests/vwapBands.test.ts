import { beforeEach, describe, expect, it } from "vitest";
import type { BarFrame, TradeFrame } from "../../../../types/frames";
import { createIndicatorRuntime } from "../../../chart/indicatorRuntime";
import { historicalIndicatorAvailability } from "../../../chart/indicatorRegistry";
import {
  indicatorTicksOf,
  type IndicatorTicks,
} from "../../../chart/indicatorTicks";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import type { LabelData } from "../../../chart/draw/label";
import {
  handlesForOwners,
  resetDrawRegistryForTests,
} from "../../../chart/draw/registry";
import { AggressiveTape } from "../../aggressive-orders/aggressiveTape";
import {
  DEFAULT_SESSION_VWAP_SETTINGS,
  SESSION_VWAP_JOIN_COLOR,
  sessionVwapIndicator,
} from "../../session-vwap/sessionVwap";
import {
  DEFAULT_VWAP_BANDS_SETTINGS,
  barContribution,
  vwapBandsIndicator,
  type VwapBandsSettings,
} from "../vwapBands";
import {
  VWAP_FILL_INNER,
  VWAP_FILL_LOWER_RING,
  VWAP_FILL_UPPER_RING,
  VWAP_LABEL_BAR_OFFSET,
  VWAP_LABEL_OFFSET_X,
  VWAP_LABEL_TEXT_ALIGN,
  VWAP_LOOKBACK_DEFAULT_BARS,
  VWAP_LOOKBACK_MAX_BARS,
  VWAP_LOOKBACK_MIN_BARS,
  normalizedLookbackBars,
  sessionVwapFillColor,
  sessionVwapRingFillColor,
} from "../../session-vwap/sessionVwap";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ID = vwapBandsIndicator.id;

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

function trade(price: number, size: number, ts = 0): TradeFrame {
  return {
    type: "trade",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    ts_exchange: ts,
    price,
    size,
    side: "buy",
    trade_id: `${ts}@${price}@${size}`,
  };
}

/**
 * A print store whose live recording began at `liveSince`, holding `prints`.
 * Built from the real `AggressiveTape`, so the coverage the indicator sees is
 * the coverage the terminal actually reports.
 */
function tapeOf(
  prints: readonly TradeFrame[],
  liveSince = 0,
): AggressiveTape {
  const tape = new AggressiveTape(() => liveSince);
  tape.reset();
  for (const print of prints) tape.add(print);
  return tape;
}

function liveTape(
  prints: readonly TradeFrame[],
  liveSince = 0,
): IndicatorTicks {
  const ticks = indicatorTicksOf(tapeOf(prints, liveSince));
  if (ticks === null) throw new Error("a tape always yields a ticks view");
  return ticks;
}

/**
 * A print store holding only what the server served for the past: `floor` is the
 * size floor it was served above, so 0 means "served in full".
 */
function historyTape(
  prints: readonly TradeFrame[],
  floor: number,
  to = HOUR,
): IndicatorTicks {
  const tape = new AggressiveTape(() => 0);
  tape.reset();
  tape.addHistory([...prints]);
  tape.coverHistory(0, to, floor);
  const ticks = indicatorTicksOf(tape);
  if (ticks === null) throw new Error("a tape always yields a ticks view");
  return ticks;
}

function chart(
  settings: Partial<VwapBandsSettings> = {},
  warmup: readonly BarFrame[] = [],
  ticks: IndicatorTicks | null = null,
) {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
  const runtime = createIndicatorRuntime([vwapBandsIndicator as never]);
  const bars: BarFrame[] = [...warmup];
  runtime.setActive(
    new Set([ID]),
    { [ID]: { ...DEFAULT_VWAP_BANDS_SETTINGS, sessionPeriodMs: HOUR, ...settings } },
    bars,
  );
  runtime.setTicks(ticks, bars);

  function feed(next: BarFrame) {
    bars.push(next);
    runtime.onBar(next, "APPENDED", bars);
  }

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

describe("which reading of the store drew a bar", () => {
  it("prices a bar from the prints of its own window, not from its candle", () => {
    const { contribution, source } = barContribution(candle(0, 500, 9), liveTape([trade(200, 3, 0)]));
    expect(source).toBe("prints");
    // The candle would have said 9 @ 500.
    expect(contribution).toEqual({ volume: 3, priceVolume: 600, priceSquaredVolume: 120_000 });
  });

  it("marks a bar priced by floor-filtered history as thin, and still uses it", () => {
    const { contribution, source } = barContribution(candle(0, 500, 9), historyTape([trade(200, 3, 0)], 5));
    expect(source).toBe("thin");
    expect(contribution).toEqual({ volume: 3, priceVolume: 600, priceSquaredVolume: 120_000 });
  });

  it("calls history served in full complete, not thin", () => {
    expect(barContribution(candle(0, 500, 9), historyTape([trade(200, 3, 0)], 0)).source).toBe("prints");
  });

  it("only counts the prints inside the bar's own window", () => {
    const ticks = liveTape([
      trade(10, 7, 0),
      trade(200, 3, MINUTE - 1),
      trade(999, 5, MINUTE),
    ]);
    const { contribution, source } = barContribution(candle(0, 500, 9), ticks);
    expect(source).toBe("prints");
    expect(contribution.volume).toBe(10);
    expect(contribution.priceVolume).toBe(10 * 7 + 200 * 3);
  });

  it("adds nothing at all for a window the store does not cover, rather than a candle", () => {
    // The store holds history over [0, HOUR) only.
    const ticks = historyTape([trade(200, 3, 0)], 5);
    const { contribution, source } = barContribution(candle(2 * HOUR, 500, 9), ticks);
    expect(source).toBe("none");
    expect(contribution).toEqual({ volume: 0, priceVolume: 0, priceSquaredVolume: 0 });
  });

  it("adds nothing when there is no store at all, which is Historical Mode", () => {
    const { contribution, source } = barContribution(candle(0, 500, 9), undefined);
    expect(source).toBe("none");
    expect(contribution).toEqual({ volume: 0, priceVolume: 0, priceSquaredVolume: 0 });
  });

  it("treats a covered window that printed nothing as covered, not as uncovered", () => {
    // The store's word is final for a window it covers: an empty window inside
    // the live stretch really did print nothing, so the bar adds nothing and
    // must not fall through to a source that would invent volume for it.
    const ticks = liveTape([trade(200, 3, MINUTE)]);
    const { contribution, source } = barContribution(candle(0, 500, 9), ticks);
    expect(source).toBe("prints");
    expect(contribution.volume).toBe(0);
  });
});

describe("drawing a session from the terminal's print store", () => {
  it("prices the bars from the store's prints rather than from the candles", () => {
    const ticks = liveTape([trade(100, 1, 0), trade(200, 3, 0)]);
    const { feed, output } = chart({}, [], ticks);
    // No trades are handed to the bar at all: the store alone prices it.
    feed(candle(0, 100, 1));
    // 700 / 4 = 175, where the candle would have said 100.
    expect(output().vwap).toEqual([175]);
  });

  it("gives each bar the prints of its own window", () => {
    const ticks = liveTape([trade(100, 1, 0), trade(300, 1, MINUTE)]);
    const { feed, output } = chart({}, [], ticks);
    feed(candle(0, 100, 1));
    feed(candle(MINUTE, 100, 1));
    expect(output().vwap).toEqual([100, 200]);
  });

  it("uses floor-filtered history, which is the only tape there is for a live pair's past", () => {
    const ticks = historyTape([trade(100, 1, 0), trade(300, 2, 0)], 5);
    const { feed, output } = chart({}, [], ticks);
    feed(candle(0, 100, 9));
    // 700 / 3 from the two prints the server kept, not 100 from the candle.
    expect(output().vwap).toEqual([700 / 3]);
  });

  it("takes the store's prices back out when the store goes away, rather than keeping stale numbers", () => {
    const ticks = liveTape([trade(100, 1, 0), trade(200, 3, 0)]);
    const { feed, output, runtime, bars } = chart({}, [], ticks);
    feed(candle(0, 100, 1));
    expect(output().vwap).toEqual([175]);
    // The pair changed, or the feed went off: the replay starts from nothing
    // and the bars it cannot price go blank, rather than holding the old value.
    runtime.setTicks(null, bars);
    expect(output().vwap).toEqual([null]);
  });

  it("says what the line is made of in the settings", () => {
    const hint = (vwapBandsIndicator.settingsSchema ?? []).find((field) => field.kind === "staticHint");
    expect(hint?.text).toContain("L1 prints");
    expect(hint?.text).toContain("size floor");
    expect(hint?.text).toContain("no candle fallback");
  });
});

describe("drawing the session", () => {
  it("builds the average and the deviation from print prices", () => {
    const ticks = liveTape([trade(100, 1, 0), trade(200, 3, 0)]);
    const { feed, output } = chart({}, [], ticks);
    feed(candle(0, 100, 1));
    // 700 / 4 = 175, from the prints, not 100 from the candle.
    expect(output().vwap).toEqual([175]);
    // σ² = (1·100² + 3·200²)/4 − 175² = 1875.
    expect(output().upper1[0]).toBeCloseTo(175 + Math.sqrt(1875), 6);
  });

  it("draws nothing before the tape begins, and starts where it does", () => {
    const ticks = liveTape([trade(100, 2, HOUR)], HOUR);
    const { feed, output } = chart({}, [], ticks);
    feed(candle(0, 100, 4));
    feed(candle(HOUR, 100, 4));
    // The first bar's window is all before the store's own start, so its
    // session has no volume at all and no line; the second is priced from it.
    expect(output().vwap).toEqual([null, 100]);
  });

  it("carries the session's average flat across a bar the store cannot see", () => {
    const ticks = historyTape([trade(100, 1, 0)], 5);
    const { feed, output } = chart({}, [], ticks);
    feed(candle(0, 100, 4));
    feed(candle(MINUTE, 100, 4));
    // The uncovered bar adds nothing, exactly as a bar of zero volume does, so
    // the average carries across it instead of restarting or being invented.
    expect(output().vwap).toEqual([100, 100]);
  });

  it("takes a developing bar's earlier prints back out when it is re-delivered", () => {
    const ticks = liveTape([trade(100, 1, 0), trade(200, 3, 0)]);
    const { feed, replace, output } = chart({}, [], ticks);
    feed(candle(0, 100, 1));
    // The same bar a moment later, with the store now holding the print that
    // arrived in between: the window is measured once, not twice.
    replace(candle(0, 100, 1));
    expect(output().vwap).toEqual([175]);
    expect(output().vwap).toHaveLength(1);
  });

  it("forgets the accumulation when the instrument changes underneath it", () => {
    const ticks = liveTape([trade(100, 1, 0), trade(300, 1, MINUTE)]);
    const { feed, output, bars, runtime } = chart({}, [], ticks);
    feed(candle(0, 100, 1));
    const other = { ...candle(MINUTE, 300, 1), symbol: "ETH-USDT" } as BarFrame;
    bars.push(other);
    runtime.onBar(other, "APPENDED", bars);
    // The new instrument starts from its own window's prints rather than
    // carrying the accumulated session of the one before it.
    expect(output().vwap).toEqual([100, 300]);
  });

  it("hides the segment that would join one session to the next", () => {
    const ticks = liveTape([
      trade(100, 1, 0),
      trade(100, 1, 59 * MINUTE),
      trade(200, 1, HOUR),
    ]);
    const { feed, output, colors } = chart({}, [], ticks);
    feed(candle(0, 100, 1));
    feed(candle(59 * MINUTE, 100, 1));
    feed(candle(HOUR, 200, 1));
    expect(output().vwap).toEqual([100, 100, 200]);
    // The session's last bar is transparent, exactly as Session VWAP does it:
    // the join segment takes the colour of the point it starts from.
    expect(colors().vwap[1]).toBe(SESSION_VWAP_JOIN_COLOR);
    expect(colors().upper2[1]).toBe(SESSION_VWAP_JOIN_COLOR);
    expect(colors().vwap[2]).toBe(DEFAULT_VWAP_BANDS_SETTINGS.vwapColor);
  });
});

describe("the lookback anchor", () => {
  /** Bars one minute apart, each with its own print at its own price. */
  function series(count: number): { bars: BarFrame[]; prints: TradeFrame[] } {
    return {
      bars: Array.from({ length: count }, (_, index) => candle(index * MINUTE, 100, 1)),
      prints: Array.from({ length: count }, (_, index) =>
        trade(100 + index, 1, index * MINUTE),
      ),
    };
  }

  it("rounds the lookback to whole bars and clamps it to what the slider offers", () => {
    expect(normalizedLookbackBars(300.4)).toBe(300);
    expect(normalizedLookbackBars(0)).toBe(VWAP_LOOKBACK_MIN_BARS);
    expect(normalizedLookbackBars(Number.NaN)).toBe(VWAP_LOOKBACK_DEFAULT_BARS);
    expect(normalizedLookbackBars(1e9)).toBe(VWAP_LOOKBACK_MAX_BARS);
  });

  it("starts the window `lookbackBars` back from the newest bar and develops to it", () => {
    const { bars, prints } = series(12);
    // Twelve bars are fed at once, so the newest one is the twelfth: a ten-bar
    // lookback anchors on the third. The two priced bars before it are drawn as
    // nothing, because they are outside the window.
    const { output } = chart(
      { anchor: "lookback", lookbackBars: 10 },
      bars,
      liveTape(prints),
    );
    expect(output().vwap).toEqual(
      bars.map((_, index) => (index < 2 ? null : (202 + index) / 2)),
    );
  });

  it("keeps the anchor put while new bars arrive, instead of rolling", () => {
    const { bars, prints } = series(12);
    const tape = tapeOf(prints);
    const { feed, output } = chart(
      { anchor: "lookback", lookbackBars: 10 },
      bars,
      indicatorTicksOf(tape)!,
    );
    expect(output().vwap).toHaveLength(12);
    tape.add(trade(200, 1, 12 * MINUTE));
    feed(candle(12 * MINUTE, 100, 1));
    // The window grows from where it was anchored: (102 + … + 111 + 200) / 11.
    // A rolling ten-bar window would have dropped the anchor bar and read
    // (103 + … + 111 + 200) / 10 instead.
    expect(output().vwap[12]).toBeCloseTo(1265 / 11, 6);
    expect(output().vwap).toHaveLength(13);
  });

  it("anchors on the first bar when the chart holds fewer bars than the lookback", () => {
    const { bars, prints } = series(3);
    const { output } = chart(
      { anchor: "lookback", lookbackBars: 50 },
      bars,
      liveTape(prints),
    );
    // 100, then (100 + 101) / 2, then (100 + 101 + 102) / 3.
    expect(output().vwap).toEqual([100, 100.5, 101]);
  });

  it("carries the average flat across a bar inside the window that priced nothing", () => {
    // The store holds history over [0, 12 * MINUTE) but only two prints in it,
    // so the window is priced by bars three and four and nothing after them.
    const { bars } = series(12);
    const ticks = historyTape(
      [trade(102, 1, 2 * MINUTE), trade(103, 1, 3 * MINUTE)],
      5,
      12 * MINUTE,
    );
    const { output } = chart({ anchor: "lookback", lookbackBars: 10 }, bars, ticks);
    expect(output().vwap).toEqual([
      null,
      null,
      102,
      102.5,
      102.5,
      102.5,
      102.5,
      102.5,
      102.5,
      102.5,
      102.5,
      102.5,
    ]);
  });

  it("takes the developing bar's earlier numbers back out when it is re-delivered", () => {
    const { bars, prints } = series(12);
    const { replace, output } = chart(
      { anchor: "lookback", lookbackBars: 10 },
      bars,
      liveTape(prints),
    );
    const before = output().vwap[11];
    // Counting the re-delivered bar twice would divide by eleven instead of ten.
    replace(candle(11 * MINUTE, 100, 1));
    expect(output().vwap[11]).toBe(before);
  });

  it("hides no session join, because a lookback window is not a session", () => {
    const ticks = liveTape([
      trade(100, 1, 0),
      trade(200, 1, 59 * MINUTE),
      trade(300, 1, HOUR),
    ]);
    const { output, colors } = chart(
      { anchor: "lookback", lookbackBars: 50 },
      [candle(0, 100, 1), candle(59 * MINUTE, 100, 1), candle(HOUR, 100, 1)],
      ticks,
    );
    // The middle bar ends a one-hour session, but nothing joins here.
    expect(output().vwap).toEqual([100, 150, 200]);
    expect(colors().vwap).not.toContain(SESSION_VWAP_JOIN_COLOR);
  });
});

describe("bars that arrive in pieces, and bars longer than a session", () => {
  it("a bar that opened with no prints and then trades takes nothing of the bar before it back out", () => {
    const tape = tapeOf([trade(100, 1, 0)]);
    const ticks = indicatorTicksOf(tape);
    if (ticks === null) throw new Error("a tape always yields a ticks view");
    const { feed, replace, output } = chart({}, [candle(0, 100, 1)], ticks);
    feed(candle(MINUTE, 120, 1));
    tape.add(trade(120, 1, MINUTE));
    replace(candle(MINUTE, 120, 1));
    expect(output().vwap.at(-1)).toBe(110);
  });

  it("leaves a bar alone when it is longer than the session itself", () => {
    const fourHour = { ...candle(0, 100, 1), interval_ms: 4 * HOUR };
    const { colors } = chart({}, [fourHour], liveTape([trade(100, 1, 0)]));
    expect(colors().vwap).not.toContain(SESSION_VWAP_JOIN_COLOR);
  });
});

describe("the labels beside the lines", () => {
  it("names the average's price and each band's sigma on the newest bar", () => {
    const ticks = liveTape([trade(100, 1, 0), trade(200, 3, 0)]);
    const { feed, labels } = chart({}, [], ticks);
    // 700 / 4 = 175, and σ² = (1·100² + 3·200²)/4 − 175² = 1875.
    feed(candle(0, 100, 1));
    const deviation = Math.sqrt(1875);
    expect(labels().map((label) => label.text)).toEqual([
      "VWAP: 175.00",
      "+1",
      "-1",
      "+2",
      "-2",
    ]);
    // Every label rides the newest bar, at its own line's price.
    expect(labels().map((label) => label.time)).toEqual(Array(5).fill(0));
    expect(labels()[0].price).toBe(175);
    expect(labels()[1].price).toBeCloseTo(175 + deviation, 9);
    expect(labels()[2].price).toBeCloseTo(175 - deviation, 9);
    expect(labels()[3].price).toBeCloseTo(175 + 2 * deviation, 9);
    expect(labels()[4].price).toBeCloseTo(175 - 2 * deviation, 9);
  });

  it("anchors every label's text on its left, one bar past the newest bar", () => {
    const ticks = liveTape([trade(100, 1, 0)]);
    const { feed, labels } = chart({}, [], ticks);
    feed(candle(0, 100, 1));
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

  it("has nothing to say for a bar the store cannot price", () => {
    const ticks = liveTape([trade(100, 1, 0)]);
    const { feed, labels, runtime, bars } = chart({}, [], ticks);
    feed(candle(0, 100, 1));
    expect(labels()[0].text).toBe("VWAP: 100.00");
    // The pair changed or the feed went off: the line goes blank with it.
    runtime.setTicks(null, bars);
    expect(labels().map((label) => label.text)).toEqual(["", "", "", "", ""]);
  });
});

describe("the fills between the bands", () => {
  it("fills the inner pair and both rings, each band keeping a point per bar", () => {
    const ticks = liveTape([trade(100, 1, 0), trade(200, 3, 0)]);
    const { feed, runtime } = chart({}, [], ticks);
    feed(candle(0, 100, 1));
    // 700 / 4 = 175, and σ² = (1·100² + 3·200²)/4 − 175² = 1875.
    const deviation = Math.sqrt(1875);
    expect(runtime.getFillKeys(ID)).toEqual([
      VWAP_FILL_INNER,
      VWAP_FILL_UPPER_RING,
      VWAP_FILL_LOWER_RING,
    ]);
    const inner = runtime.getFillPoints(ID, VWAP_FILL_INNER)!.points[0];
    expect(inner?.valueA).toBeCloseTo(175 + deviation, 9);
    expect(inner?.valueB).toBeCloseTo(175 - deviation, 9);
    const upperRing = runtime.getFillPoints(ID, VWAP_FILL_UPPER_RING)!.points[0];
    expect(upperRing?.valueA).toBeCloseTo(175 + deviation, 9);
    expect(upperRing?.valueB).toBeCloseTo(175 + 2 * deviation, 9);
    const lowerRing = runtime.getFillPoints(ID, VWAP_FILL_LOWER_RING)!.points[0];
    expect(lowerRing?.valueA).toBeCloseTo(175 - deviation, 9);
    expect(lowerRing?.valueB).toBeCloseTo(175 - 2 * deviation, 9);
  });

  it("paints each fill from its own settings colour, the ring fainter than the inner band", () => {
    const ticks = liveTape([trade(100, 1, 0)]);
    const { feed, runtime } = chart({}, [], ticks);
    feed(candle(0, 100, 1));
    expect(runtime.getFillPoints(ID, VWAP_FILL_INNER)!.options?.colorAbove).toBe(
      sessionVwapFillColor(DEFAULT_VWAP_BANDS_SETTINGS.fillColor),
    );
    expect(runtime.getFillPoints(ID, VWAP_FILL_UPPER_RING)!.options?.colorAbove).toBe(
      sessionVwapRingFillColor(DEFAULT_VWAP_BANDS_SETTINGS.ringFillColor),
    );
  });

  it("drops every fill for a bar the store cannot price", () => {
    const ticks = liveTape([trade(100, 1, 0)]);
    const { feed, runtime, bars } = chart({}, [], ticks);
    feed(candle(0, 100, 1));
    expect(runtime.getFillPoints(ID, VWAP_FILL_INNER)!.points[0]).not.toBeNull();
    runtime.setTicks(null, bars);
    expect(runtime.getFillPoints(ID, VWAP_FILL_INNER)!.points[0]).toBeNull();
  });
});

describe("registration", () => {
  it("is registered as an L1 overlay named VWAP Bands", () => {
    expect(vwapBandsIndicator.id).toBe("vwapBands");
    expect(vwapBandsIndicator.label).toBe("VWAP Bands");
    expect(vwapBandsIndicator.category).toBe("l1");
    expect(vwapBandsIndicator.placement).toEqual({ kind: "overlay" });
    expect(vwapBandsIndicator.lines.map((line) => line.key)).toEqual(["vwap", "upper1", "lower1", "upper2", "lower2"]);
  });

  it("declares that it reads the print store, which is what makes the runtime replay it", () => {
    // Without this the store would arrive after the bars were drawn and never
    // reach them: only the indicators that declare it are replayed.
    expect(vwapBandsIndicator.ticksWanted).toBe(true);
  });

  it("starts session-anchored, with the lookback waiting for the other anchor", () => {
    expect(DEFAULT_VWAP_BANDS_SETTINGS.anchor).toBe("session");
    expect(DEFAULT_VWAP_BANDS_SETTINGS.lookbackBars).toBe(300);
  });

  it("offers the anchor as a dropdown, and the lookback input only while it is selected", () => {
    const schema = vwapBandsIndicator.settingsSchema ?? [];
    const anchor = schema.find(
      (field) => field.kind === "select" && field.key === "anchor",
    );
    expect(anchor?.kind === "select" ? anchor.options.map((option) => option.label) : null).toEqual([
      "Session VWAP",
      "Lookback VWAP",
    ]);

    const lookback = schema.find(
      (field) => field.kind === "slider" && field.key === "lookbackBars",
    );
    // A slider over the whole range the setting is clamped to, so the input can
    // never ask for a window the setting would refuse.
    expect(lookback?.kind === "slider" ? [lookback.min, lookback.max, lookback.step] : null).toEqual([
      VWAP_LOOKBACK_MIN_BARS,
      VWAP_LOOKBACK_MAX_BARS,
      1,
    ]);
    expect(lookback?.visibleIf?.({ ...DEFAULT_VWAP_BANDS_SETTINGS, anchor: "lookback" })).toBe(true);
    expect(lookback?.visibleIf?.(DEFAULT_VWAP_BANDS_SETTINGS)).toBe(false);

    // ...and the session length is only meaningful for the other anchor.
    const session = schema.find(
      (field) => field.kind === "select" && field.key === "sessionPeriodMs",
    );
    expect(session?.visibleIf?.({ ...DEFAULT_VWAP_BANDS_SETTINGS, anchor: "lookback" })).toBe(false);
    expect(session?.visibleIf?.(DEFAULT_VWAP_BANDS_SETTINGS)).toBe(true);
  });

  it("shares its line keys with Session VWAP, which the runtime allows", () => {
    // Line keys only have to be unique within one indicator
    // (assertRuntimeDefinitions builds its set per def), and both VWAPs are
    // created as their own series, so the names can and should match.
    expect(vwapBandsIndicator.lines.map((line) => line.key)).toEqual(
      sessionVwapIndicator.lines.map((line) => line.key),
    );
  });

  it("keeps the same session windows and band defaults as Session VWAP", () => {
    expect(vwapBandsIndicator.defaultSettings.sessionPeriodMs).toBe(DEFAULT_SESSION_VWAP_SETTINGS.sessionPeriodMs);
    expect(vwapBandsIndicator.defaultSettings.band1Sigma).toBe(DEFAULT_SESSION_VWAP_SETTINGS.band1Sigma);
    expect(vwapBandsIndicator.defaultSettings.band2Sigma).toBe(DEFAULT_SESSION_VWAP_SETTINGS.band2Sigma);
  });

  it("is not offered in Historical Mode, where a replay carries no prints", () => {
    // With no candle fallback there is nothing to draw from an archive, so the
    // honest answer is that the indicator is unavailable rather than an empty
    // line the user cannot explain.
    const availability = historicalIndicatorAvailability("vwapBands", new Set(["ohlcv"]), "DATABENTO");
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("no candle fallback");
  });
});

/** The r, g and b channels of a line colour, hex or rgba alike. */
describe("VWAP Bands takes history that lands after the store was handed over (PR #29 review)", () => {
  it("prices the bars already drawn once the runtime replays over the history, exactly as a fresh chart does", () => {
    const tape = new AggressiveTape(() => 10 * MINUTE);
    tape.reset();
    tape.add(trade(300, 1, 15 * MINUTE));
    const bars = Array.from({ length: 20 }, (_, i) => candle(i * MINUTE, 100, 1));
    const late = chart({}, bars, indicatorTicksOf(tape));
    expect(late.output().vwap.slice(0, 10).every((value) => value === null)).toBe(true);
    tape.addHistory(Array.from({ length: 8 }, (_, i) => trade(100 + i, 1, (i + 1) * MINUTE + 1_000)));
    tape.coverHistory(0, 10 * MINUTE, 0);
    late.runtime.refreshTicks(bars);
    const fresh = chart({}, bars, indicatorTicksOf(tape)).output().vwap;
    expect(late.output().vwap).toEqual(fresh);
    expect(fresh.slice(1, 9)).toEqual([100, 100.5, 101, 101.5, 102, 102.5, 103, 103.5]);
  });
});

function channelsOf(color: string): [number, number, number] {
  const text = color.replace(/\s/g, "");
  const rgba = /rgba?\((\d+),(\d+),(\d+)/.exec(text);
  if (rgba !== null) {
    return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
  }
  const hex = /^#([0-9a-fA-F]{6})$/.exec(text);
  if (hex === null) throw new Error(`not a colour: ${color}`);
  return [
    parseInt(hex[1].slice(0, 2), 16),
    parseInt(hex[1].slice(2, 4), 16),
    parseInt(hex[1].slice(4, 6), 16),
  ];
}

/** The alpha of a rendered line colour. */
function alphaOf(color: string): number {
  const match = /rgba\([^)]*,([^,)]+)\)$/.exec(color.replace(/\s/g, ""));
  if (match === null) throw new Error(`not an rgba colour: ${color}`);
  return Number(match[1]);
}

describe("the two VWAPs are told apart by colour", () => {
  /** Both indicators on one chart, each fed its own kind of source. */
  function bothVwaps() {
    resetDrawRegistryForTests();
    resetDrawOwnerScopeForTests();
    const runtime = createIndicatorRuntime([
      sessionVwapIndicator,
      vwapBandsIndicator,
    ] as never);
    const bars = [candle(0, 100, 1)];
    runtime.setActiveAndReplay(
      new Set(["sessionVwap", ID]),
      {
        sessionVwap: { ...DEFAULT_SESSION_VWAP_SETTINGS, sessionPeriodMs: HOUR },
        [ID]: { ...DEFAULT_VWAP_BANDS_SETTINGS, sessionPeriodMs: HOUR },
      },
      bars,
    );
    runtime.setTicks(liveTape([trade(100, 1, 0)]), bars);
    return runtime;
  }

  it("gives the bar-priced Session VWAP blue and the print-priced VWAP Bands orange", () => {
    const runtime = bothVwaps();
    const barPriced = runtime.getLineColors("sessionVwap")!.vwap[0]!;
    const printPriced = runtime.getLineColors(ID)!.vwap[0]!;
    const [barRed, , barBlue] = channelsOf(barPriced);
    expect(barBlue).toBeGreaterThan(barRed);
    expect(printPriced).toBe(DEFAULT_VWAP_BANDS_SETTINGS.vwapColor);
    expect(printPriced).not.toBe(barPriced);
  });

  it("gives VWAP Bands deviations a hue of their own, so the average is never mistaken for one", () => {
    const colors = bothVwaps().getLineColors(ID)!;
    expect(colors.vwap[0]).not.toBe(colors.upper1[0]);
    // The average is the warm orange, the deviations the cool blue: a different
    // colour, not the average turned translucent. The two bands then differ from
    // each other by weight rather than by hue.
    const [averageRed, , averageBlue] = channelsOf(colors.vwap[0]!);
    const [bandRed, , bandBlue] = channelsOf(colors.upper1[0]!);
    expect(averageRed).toBeGreaterThan(averageBlue);
    expect(bandBlue).toBeGreaterThan(bandRed);
    expect(colors.upper1[0]).not.toBe(colors.upper2[0]);
  });

  it("leaves Session VWAP one blue in three weights, since only the L1 bands asked for a second hue", () => {
    const colors = bothVwaps().getLineColors("sessionVwap")!;
    const [averageRed, , averageBlue] = channelsOf(colors.vwap[0]!);
    const [bandRed, , bandBlue] = channelsOf(colors.upper1[0]!);
    expect(bandBlue).toBeGreaterThan(bandRed);
    expect(averageBlue).toBeGreaterThan(averageRed);
  });

  it("fades both bands down the same ladder, the outer one faintest, in both indicators", () => {
    const runtime = bothVwaps();
    const ladders = ["sessionVwap", ID].map((id) => {
      const colors = runtime.getLineColors(id)!;
      return [alphaOf(colors.upper1[0]!), alphaOf(colors.upper2[0]!)];
    });
    // One ladder, shared: the inner band is faded and the outer band fainter
    // still, so the average stays the solid line of the three.
    expect(ladders[0]).toEqual(ladders[1]);
    expect(ladders[0][0]).toBeGreaterThan(ladders[0][1]);
    expect(ladders[0][1]).toBeGreaterThan(0);
  });

  it("keeps the average itself opaque, so it is never mistaken for a band", () => {
    const runtime = bothVwaps();
    // The main line is the chosen hex untouched; only bands go through the
    // ladder, which is what makes the deviations read as deviations.
    expect(runtime.getLineColors("sessionVwap")!.vwap[0]).toBe(DEFAULT_SESSION_VWAP_SETTINGS.vwapColor);
    expect(runtime.getLineColors(ID)!.vwap[0]).toBe(DEFAULT_VWAP_BANDS_SETTINGS.vwapColor);
  });
});
