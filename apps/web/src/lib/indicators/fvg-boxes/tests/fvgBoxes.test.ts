import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import {
  withDrawOwnerScope,
  resetDrawOwnerScopeForTests,
} from "../../../chart/draw/creationScope";
import {
  handlesForOwners,
  resetDrawRegistryForTests,
  type DrawObjectRecord,
} from "../../../chart/draw/registry";
import type { BoxData } from "../../../chart/draw/box";
import type { LineData } from "../../../chart/draw/line";
import {
  fvgBoxesIndicator,
  FVG_BOXES_MAX_ACTIVE_ZONES,
  FVG_BOXES_MAX_REPLAY_BARS,
  type FVGBoxesSettings,
  type FVGBoxesState,
} from "../fvgBoxes";

const OWNER = "fvg-boxes-test";
const T0 = 1_000_000;
const STEP = 60_000;

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

// `undefined` cannot mean "no buy volume" here: a default parameter fires on
// an explicitly passed `undefined` just as it does on an omitted argument, so
// an explicit "no flow" case needs a sentinel the default doesn't intercept.
// `null` is that sentinel; a plain number always means a known split.
function bar(
  index: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
  buyVolume: number | null = 60,
): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    interval_ms: STEP,
    provider: "BINANCE",
    marketKind: "SPOT",
    ts_open: T0 + index * STEP,
    open: close,
    high,
    low,
    close,
    volume,
    ...(buyVolume === null ? {} : { buy_volume: buyVolume }),
    trade_count: 1,
    closed: true,
  };
}

// Three bars whose left/right high/low produce an exact bullish gap
// [bottom, top]: zone bottom is the left bar's high, zone top is the right
// bar's low. The middle bar plays no part in gap detection.
function bullishGapBars(
  fromIndex: number,
  bottom: number,
  top: number,
  volume: number,
  buyVolume: number | null,
): BarFrame[] {
  return [
    bar(fromIndex, bottom, bottom - 1, bottom - 0.5, volume, buyVolume),
    bar(fromIndex + 1, bottom + 0.5, bottom - 0.5, bottom, volume, buyVolume),
    bar(fromIndex + 2, top + 1, top, top + 0.5, volume, buyVolume),
  ];
}

// Zone top is the left bar's low, zone bottom is the right bar's high.
function bearishGapBars(
  fromIndex: number,
  bottom: number,
  top: number,
  volume: number,
  buyVolume: number | null,
): BarFrame[] {
  return [
    bar(fromIndex, top + 1, top, top + 0.5, volume, buyVolume),
    bar(fromIndex + 1, top + 0.5, top - 0.5, top, volume, buyVolume),
    bar(fromIndex + 2, bottom, bottom - 1, bottom - 0.5, volume, buyVolume),
  ];
}

function context(
  state: FVGBoxesState,
  currentBar: BarFrame,
  settings: FVGBoxesSettings,
): IndicatorBarCtx<FVGBoxesState, FVGBoxesSettings> {
  return {
    bar: currentBar,
    trades: [],
    state,
    settings,
    replace: false,
    replaying: false,
    ta: {},
    draw: { fill: () => {} },
    markers: { plotshape: () => {}, plotchar: () => {} },
    pane: { paneIndex: 0 },
  };
}

function createState(settings: FVGBoxesSettings): FVGBoxesState {
  return withDrawOwnerScope(OWNER, () =>
    fvgBoxesIndicator.createState(settings),
  );
}

function boxes(): BoxData[] {
  return handlesForOwners([OWNER])
    .filter((record: DrawObjectRecord) => record.kind === "box")
    .map((record) => record.data as BoxData);
}

function lines(): LineData[] {
  return handlesForOwners([OWNER])
    .filter((record: DrawObjectRecord) => record.kind === "line")
    .map((record) => record.data as LineData);
}

function visibleBoxes(): BoxData[] {
  return boxes().filter((box) => box.backgroundColor !== "transparent");
}

function feed(
  state: FVGBoxesState,
  settings: FVGBoxesSettings,
  bars: BarFrame[],
): void {
  for (const currentBar of bars)
    fvgBoxesIndicator.onBar(context(state, currentBar, settings));
}

describe("fvgBoxesIndicator", () => {
  describe("which candles make and keep a zone", () => {
    const settings = fvgBoxesIndicator.defaultSettings;
    const redeliver = (state: FVGBoxesState, next: BarFrame) =>
      fvgBoxesIndicator.onBar({ ...context(state, next, settings), replace: true });

    it("places a bearish zone between the left candle's low and the right candle's high", () => {
      const state = createState(settings);
      feed(state, settings, bearishGapBars(0, 10, 12, 100, 60));
      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({ kind: "bearish", levelTop: 12, levelBottom: 10, mitigationPrice: 10 });
    });

    it("draws nothing for a gap of no size, where one candle's low is exactly the other's high", () => {
      const state = createState(settings);
      feed(state, settings, bullishGapBars(0, 10, 10, 100, 60));
      expect(state.events).toHaveLength(0);
    });

    it("waits for the third candle to close before making a zone, and counts a re-delivered candle once", () => {
      const state = createState(settings);
      const [left, middle, right] = bullishGapBars(0, 10, 12, 100, 60);
      feed(state, settings, [left, middle, { ...right, closed: false }]);
      expect(state.events).toHaveLength(0);
      redeliver(state, { ...right, closed: false });
      redeliver(state, right);
      expect(state.barTimes).toHaveLength(3);
      expect(state.events).toHaveLength(1);
      redeliver(state, right);
      expect(state.events).toHaveLength(1);
    });

    it("lets a mitigated zone no longer hide a new zone overlapping it", () => {
      const hiding = { ...settings, hideOverlappedFVGs: true };
      const state = createState(hiding);
      feed(state, hiding, bullishGapBars(0, 10, 12, 100, 60));
      feed(state, hiding, [bar(3, 13, 11, 12)]);
      expect(state.events[0].active).toBe(false);
      feed(state, hiding, bullishGapBars(4, 11, 13, 100, 60));
      expect(state.events).toContainEqual(expect.objectContaining({ levelBottom: 11, levelTop: 13, active: true }));
    });

    it("when the store is full, drops a mitigated zone before any live one", () => {
      const state = createState(settings);
      feed(state, settings, bullishGapBars(0, 10, 12, 100, 60));
      const template = state.events[0];
      state.events = Array.from({ length: 2_000 }, (_unused, index) => ({ ...template, id: `filler-${index}`, active: index !== 7 }));
      // The jump to 40 opens three gaps (each new candle against the one two back),
      // so three zones go in: the first evicts the one mitigated filler, the next
      // two the oldest live ones.
      feed(state, settings, bullishGapBars(3, 40, 42, 100, 60));
      expect(state.events).toHaveLength(2_000);
      expect(state.events.some((event) => event.id === "filler-7")).toBe(false);
      expect(state.events[0].id).toBe("filler-2");
    });
  });

  describe("volume-threshold warm-up", () => {
    it("compares a candidate against the real high seen so far, not a null 100-bar window", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      feed(state, settings, bullishGapBars(0, 10, 12, 100, 60));

      expect(state.events).toHaveLength(1);
      expect(state.events[0].kind).toBe("bullish");
    });

    it("still filters a low-relative-volume candidate during warm-up", () => {
      const settings = { ...fvgBoxesIndicator.defaultSettings, volumeThreshold: 0.5 };
      const state = createState(settings);
      // First gap sets a high-volume bar on the tape; the second gap's
      // right-index bar has much lower volume and should be rejected
      // relative to the highest volume seen so far.
      feed(state, settings, bullishGapBars(0, 10, 12, 1_000, 60));
      feed(state, settings, bullishGapBars(3, 20, 22, 50, 60));

      expect(state.events.filter((event) => event.startTime === T0 + 3 * STEP)).toHaveLength(0);
    });

    it("keeps working the same way once past the 100-bar window", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      const warmup = Array.from({ length: 100 }, (_unused, index) =>
        bar(index, 200 + index, 199 + index, 199.5 + index),
      );
      feed(state, settings, warmup);
      feed(state, settings, bullishGapBars(100, 310, 312, 100, 60));

      expect(
        state.events.filter((event) => event.startTime === T0 + 100 * STEP),
      ).toHaveLength(1);
    });
  });

  describe("buy/sell activity honesty", () => {
    it("shows an exact split when the candle reports buy volume", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      feed(state, settings, bullishGapBars(0, 10, 12, 100, 60));

      expect(state.events[0].buyVolume).toBe(60);
      expect(state.events[0].sellVolume).toBe(40);
      expect(visibleBoxes().find((box) => box.text === "60% (60) ")).toBeDefined();
      expect(visibleBoxes().find((box) => box.text === "40% (40) ")).toBeDefined();
    });

    it("shows no directional split or label when buy volume is absent", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      feed(state, settings, bullishGapBars(0, 10, 12, 100, null));

      expect(state.events[0].buyVolume).toBeNull();
      expect(state.events[0].sellVolume).toBeNull();
      // The zone itself still renders from OHLCV; only buy/sell are hidden.
      expect(visibleBoxes()).toHaveLength(1);
      expect(boxes().some((box) => box.text.length > 0)).toBe(false);
    });

    it("never derives a sell figure from total volume without a known buy volume", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      feed(state, settings, bullishGapBars(0, 10, 12, 100, null));

      expect(state.events[0].sellVolume).not.toBe(100);
      expect(state.events[0].sellVolume).toBeNull();
    });
  });

  describe("mitigation is on touch, not full traversal", () => {
    it("does not mitigate a bullish zone while price stays above its near (upper) edge", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      feed(state, settings, bullishGapBars(0, 10, 12, 100, 60));
      // Zone is [10, 12]; the near (top) edge is 12.
      feed(state, settings, [bar(3, 14, 12.5, 13)]);

      expect(state.events[0].active).toBe(true);
    });

    it("mitigates a bullish zone the instant price exactly touches its near (upper) edge", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      feed(state, settings, bullishGapBars(0, 10, 12, 100, 60));
      feed(state, settings, [bar(3, 14, 12, 13)]);

      expect(state.events[0].active).toBe(false);
    });

    it("also mitigates on a deeper traversal through the near edge", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      feed(state, settings, bullishGapBars(0, 10, 12, 100, 60));
      feed(state, settings, [bar(3, 13, 9, 10)]);

      expect(state.events[0].active).toBe(false);
    });

    it("a bar that forms a new FVG does not mitigate the FVG it just formed", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      feed(state, settings, bullishGapBars(0, 10, 12, 100, 60));

      expect(state.events).toHaveLength(1);
      expect(state.events[0].active).toBe(true);
    });

    it("mitigates a bearish zone the instant price exactly touches its near (lower) edge", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      feed(state, settings, bearishGapBars(0, 10, 12, 100, 60));

      expect(state.events).toHaveLength(1);
      expect(state.events[0].kind).toBe("bearish");
      // Zone is [10, 12]; the near (bottom) edge is 10.
      feed(state, settings, [bar(3, 11, 9, 10)]);

      expect(state.events[0].active).toBe(false);
    });

    it("does not mitigate a bearish zone while price stays below its near (lower) edge", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      feed(state, settings, bearishGapBars(0, 10, 12, 100, 60));
      feed(state, settings, [bar(3, 9.5, 8, 9)]);

      expect(state.events[0].active).toBe(true);
    });
  });

  describe("hideOverlappedFVGs uses real interval overlap", () => {
    // A real candidate whose bounds overlap an active zone will, via the
    // same formation bars, also mitigate that zone: a bullish zone's
    // mitigation price is its own levelTop, a bar's low can never exceed
    // its high, and any candidate whose bottom reaches at/below that
    // levelTop necessarily carries a bar whose low does too -- so the zone
    // is deactivated in the same onBar call, before the overlap check ever
    // sees it as active. That means genuine same-direction overlap can't be
    // observed by streaming two realistic gap groups back to back. To test
    // the interval-overlap check on its own (already exercised for
    // mitigation separately, above), the "existing zone" is injected
    // directly into state.events with a mitigation price no real bar can
    // ever reach, isolating levelTop/levelBottom overlap from mitigation.
    function activeZoneSettings(): FVGBoxesSettings {
      return { ...fvgBoxesIndicator.defaultSettings, hideOverlappedFVGs: true, volumeThreshold: 0 };
    }

    function injectActiveZone(
      state: FVGBoxesState,
      kind: "bullish" | "bearish",
      bottom: number,
      top: number,
    ): void {
      state.events.push({
        id: `fixture:${kind}:${bottom}:${top}`,
        kind,
        startTime: T0,
        levelTop: top,
        levelBottom: bottom,
        mitigationPrice:
          kind === "bullish" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
        buyVolume: null,
        sellVolume: null,
        active: true,
        slot: null,
        zoneBox: null,
        buyBox: null,
        sellBox: null,
        meanLine: null,
      });
    }

    function hasZone(state: FVGBoxesState, bottom: number, top: number): boolean {
      return state.events.some(
        (event) => event.levelBottom === bottom && event.levelTop === top,
      );
    }

    it("admits a disjoint candidate", () => {
      const settings = activeZoneSettings();
      const state = createState(settings);
      injectActiveZone(state, "bullish", 10, 12);
      feed(state, settings, bullishGapBars(0, 30, 32, 100, 60)); // zone [30, 32], disjoint

      expect(hasZone(state, 30, 32)).toBe(true);
    });

    it("rejects a candidate fully inside an existing active zone", () => {
      const settings = activeZoneSettings();
      const state = createState(settings);
      injectActiveZone(state, "bullish", 10, 22); // wide zone [10, 22]
      feed(state, settings, bullishGapBars(0, 13, 17, 100, 60)); // candidate [13, 17], contained

      expect(hasZone(state, 13, 17)).toBe(false);
    });

    it("rejects a candidate that fully contains an existing active zone", () => {
      const settings = activeZoneSettings();
      const state = createState(settings);
      injectActiveZone(state, "bullish", 10, 12); // zone [10, 12]
      feed(state, settings, bullishGapBars(0, 5, 20, 100, 60)); // candidate [5, 20] spans past it both sides

      expect(hasZone(state, 5, 20)).toBe(false);
    });

    it("rejects a one-sided partial overlap", () => {
      const settings = activeZoneSettings();
      const state = createState(settings);
      injectActiveZone(state, "bullish", 10, 12); // zone [10, 12]
      feed(state, settings, bullishGapBars(0, 11, 16, 100, 60)); // candidate [11, 16] overlaps only at the low end

      expect(hasZone(state, 11, 16)).toBe(false);
    });

    it("treats an exact edge touch as overlap", () => {
      const settings = activeZoneSettings();
      const state = createState(settings);
      injectActiveZone(state, "bullish", 10, 12); // zone [10, 12]
      feed(state, settings, bullishGapBars(0, 12, 16, 100, 60)); // candidate bottom sits exactly at 12

      expect(hasZone(state, 12, 16)).toBe(false);
    });

    it("admits the candidate once hideOverlappedFVGs is off", () => {
      const settings = { ...fvgBoxesIndicator.defaultSettings, hideOverlappedFVGs: false, volumeThreshold: 0 };
      const state = createState(settings);
      injectActiveZone(state, "bullish", 10, 12);
      feed(state, settings, bullishGapBars(0, 11, 16, 100, 60));

      expect(hasZone(state, 11, 16)).toBe(true);
    });
  });

  describe("visible objects: one zone, one buy box, one sell box, one mean line per visible FVG", () => {
    it("plots a bullish FVG's four objects with the right coordinates and colors", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      feed(state, settings, bullishGapBars(0, 10, 12, 100, 60));

      expect(visibleBoxes()).toHaveLength(3); // zone + buy + sell
      const visibleLines = lines().filter((line) => line.color !== "transparent");
      expect(visibleLines).toHaveLength(1); // mean line

      const zone = visibleBoxes().find((box) => box.text === "");
      expect(zone).toMatchObject({ price1: 12, price2: 10, borderColor: "transparent" });
      const buy = visibleBoxes().find((box) => box.text === "60% (60) ");
      expect(buy).toMatchObject({ price1: 12, price2: 11 });
      const sell = visibleBoxes().find((box) => box.text === "40% (40) ");
      expect(sell).toMatchObject({ price1: 11, price2: 10 });
      expect(visibleLines[0]).toMatchObject({ price1: 11, price2: 11 });
    });

    it("keeps only the newest maxDisplayedFVGs zones visible, hiding the rest", () => {
      const settings = {
        ...fvgBoxesIndicator.defaultSettings,
        maxDisplayedFVGs: 2,
        volumeThreshold: 0,
      };
      const state = createState(settings);
      let bars: BarFrame[] = [];
      for (let zone = 0; zone < 13; zone += 1) {
        bars = bars.concat(bullishGapBars(zone * 3, 20 + zone * 5, 22 + zone * 5, 100, 60));
      }
      feed(state, settings, bars);

      expect(state.events.length).toBeGreaterThan(FVG_BOXES_MAX_ACTIVE_ZONES);
      expect(state.events.filter((event) => event.slot !== null)).toHaveLength(2);
      expect(visibleBoxes()).toHaveLength(2 * 3);
    });
  });

  describe("historical replay is bounded", () => {
    it("declares a replay cap, matching the bound every other stateful overlay declares", () => {
      expect(fvgBoxesIndicator.maxReplayBars).toBe(FVG_BOXES_MAX_REPLAY_BARS);
    });

    it("processing a full cap's worth of bars stays fast enough for interactive settings changes", () => {
      const settings = fvgBoxesIndicator.defaultSettings;
      const state = createState(settings);
      const bars: BarFrame[] = [];
      for (let index = 0; index < FVG_BOXES_MAX_REPLAY_BARS; index += 1) {
        const base = 100 + (index % 50);
        bars.push(bar(index, base + 2, base - 2, base, 100 + (index % 10), 60));
      }
      const startedAt = performance.now();
      feed(state, settings, bars);
      const elapsedMs = performance.now() - startedAt;

      // A generous ceiling for the repository's pinned test environment --
      // this is a regression guard against reintroducing an unbounded or
      // quadratic replay cost, not a production throughput claim.
      expect(elapsedMs).toBeLessThan(2_000);
      expect(state.events.length).toBeGreaterThan(0);
    });
  });
});
