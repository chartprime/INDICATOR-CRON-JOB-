import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import {
  handlesForOwners,
  resetDrawRegistryForTests,
} from "../../../chart/draw/registry";
import {
  swingAlphabetProfileIndicator,
  type SwingAlphabetProfileSettings,
  type SwingAlphabetProfileState,
} from "../swingAlphabetProfile";

const SETTINGS: SwingAlphabetProfileSettings = {
  swingLength: 2,
  showSwings: true,
  swingLineColor: "#787b86",
  maxSwingLines: 10,
  showProfile: true,
  profileResolution: 0.35,
  profileWidthLen: 20,
  profileTextColor: "#787b86",
  maxProfileBins: 50,
  showValueArea: true,
  valueAreaPercent: 50,
  valueAreaColor: "#1491da",
  valueAreaLineWidth: 4,
  showPoc: true,
  pocColor: "#1491da",
  pocLineWidth: 2,
  showBubbles: true,
  bubbleMinPercent: 50,
  bullBubbleColor: "#26a69a",
  bearBubbleColor: "#ef5350",
};

function bar(index: number, high: number, low: number): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: 60_000,
    ts_open: index * 60_000,
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: 1,
    trade_count: 1,
    closed: true,
  } as BarFrame;
}

function context(
  state: SwingAlphabetProfileState,
  nextBar: BarFrame,
  settings: SwingAlphabetProfileSettings = SETTINGS,
  replace = false,
): IndicatorBarCtx<SwingAlphabetProfileState, SwingAlphabetProfileSettings> {
  return {
    bar: nextBar,
    trades: [],
    tradeAvailability: "HISTORICAL_UNAVAILABLE",
    state,
    settings,
    replace,
    replaying: false,
    ta: {},
    draw: { fill: () => {} },
    markers: { plotshape: () => {}, plotchar: () => {} },
    pane: { paneIndex: 0 },
  };
}

function makeState(
  settings: SwingAlphabetProfileSettings = SETTINGS,
): SwingAlphabetProfileState {
  return withDrawOwnerScope("swing-alphabet-profile-test", () =>
    swingAlphabetProfileIndicator.createState(settings),
  );
}

function feed(
  state: SwingAlphabetProfileState,
  bars: readonly BarFrame[],
  settings: SwingAlphabetProfileSettings = SETTINGS,
): void {
  for (const nextBar of bars) {
    swingAlphabetProfileIndicator.onBar(context(state, nextBar, settings));
  }
}

beforeEach(() => {
  resetDrawRegistryForTests();
});

afterEach(() => {
  resetDrawRegistryForTests();
});

describe("swingAlphabetProfileIndicator", () => {
  it("connects a confirmed swing high to a confirmed swing low with one line", () => {
    const state = makeState();
    feed(state, [
      bar(0, 10, 8),
      bar(1, 12, 9),
      bar(2, 11, 6),
      bar(3, 9, 7),
      bar(4, 10, 8),
    ]);

    expect(state.segments).toHaveLength(1);
    expect(state.segments[0]).toEqual(
      expect.objectContaining({ price1: 12, price2: 6 }),
    );

    const records = handlesForOwners(["swing-alphabet-profile-test"]);
    const lines = records.filter((record) => record.kind === "line");
    expect(lines.map((record) => record.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          price1: 12,
          price2: 6,
          color: "#787b86",
        }),
      ]),
    );
  });

  it("hides swing lines when showSwings is false", () => {
    const hiddenSettings: SwingAlphabetProfileSettings = {
      ...SETTINGS,
      showSwings: false,
    };
    const state = makeState(hiddenSettings);
    feed(
      state,
      [
        bar(0, 10, 8),
        bar(1, 12, 9),
        bar(2, 11, 6),
        bar(3, 9, 7),
        bar(4, 10, 8),
      ],
      hiddenSettings,
    );

    expect(state.segments).toHaveLength(1);
    const records = handlesForOwners(["swing-alphabet-profile-test"]);
    const lines = records.filter((record) => record.kind === "line");
    expect(
      lines.every(
        (record) =>
          (record.data as { color: string }).color === "rgba(0, 0, 0, 0)",
      ),
    ).toBe(true);
  });

  it("caps stored segments at maxSwingLines", () => {
    const cappedSettings: SwingAlphabetProfileSettings = {
      ...SETTINGS,
      maxSwingLines: 1,
    };
    const state = makeState(cappedSettings);
    feed(
      state,
      [
        bar(0, 10, 8),
        bar(1, 12, 9),
        bar(2, 11, 6),
        bar(3, 9, 7),
        bar(4, 10, 8),
        bar(5, 13, 9),
        bar(6, 12, 5),
        bar(7, 8, 6),
        bar(8, 9, 7),
      ],
      cappedSettings,
    );

    expect(state.segments.length).toBeLessThanOrEqual(1);
  });

  it("renders letter-profile boxes for a finalized leg once ATR has warmed up", () => {
    const state = makeState();
    const warmup: BarFrame[] = [];
    for (let index = 0; index < 205; index += 1) {
      warmup.push(
        index % 2 === 0 ? bar(index, 10.5, 9.5) : bar(index, 9.5, 8.5),
      );
    }
    feed(state, warmup);

    const base = warmup.length;
    feed(state, [
      bar(base, 10, 8),
      bar(base + 1, 12, 9),
      bar(base + 2, 11, 6),
      bar(base + 3, 9, 7),
      bar(base + 4, 10, 8),
    ]);

    expect(state.profileBins.length).toBeGreaterThan(0);
    expect(state.profileBins.every((bin) => bin.text.length > 0)).toBe(true);

    const records = handlesForOwners(["swing-alphabet-profile-test"]);
    // Only the finalized profile's box pool -- the developing/real-time
    // profile's own box pool is created right after it and would otherwise
    // also show up here with non-empty text.
    const boxes = records
      .filter((record) => record.kind === "box")
      .slice(0, SETTINGS.maxProfileBins);
    const visibleBoxes = boxes.filter(
      (record) => (record.data as { text: string }).text.length > 0,
    );
    expect(visibleBoxes.length).toBe(state.profileBins.length);
    expect(
      visibleBoxes.every((record) =>
        ["#787b86", "#1491da", "#8fcaec"].includes(
          (record.data as { textColor: string }).textColor,
        ),
      ),
    ).toBe(true);
    state.profileBins.forEach((bin, index) => {
      const expectedColor = bin.isPoc
        ? "#8fcaec"
        : bin.isInValueArea
          ? "#1491da"
          : "#787b86";
      expect((boxes[index].data as { textColor: string }).textColor).toBe(
        expectedColor,
      );
    });
  });

  it("keeps the same number of retained profiles (whole legs) as maxSwingLines, not a raw bin count", () => {
    const cappedSettings: SwingAlphabetProfileSettings = {
      ...SETTINGS,
      maxSwingLines: 2,
    };
    const state = makeState(cappedSettings);
    const warmup: BarFrame[] = [];
    for (let index = 0; index < 220; index += 1) {
      warmup.push(
        index % 2 === 0 ? bar(index, 10.5, 9.5) : bar(index, 9.5, 8.5),
      );
    }
    feed(state, warmup, cappedSettings);

    expect(state.legBinCounts.length).toBeLessThanOrEqual(2);
    const expectedTotalBins = state.legBinCounts.reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(state.profileBins.length).toBe(expectedTotalBins);
  });

  it("draws a dotted full-range outline plus a fatter aqua VAH/VAL line at the swing's x1", () => {
    const state = makeState();
    const warmup: BarFrame[] = [];
    for (let index = 0; index < 205; index += 1) {
      warmup.push(
        index % 2 === 0 ? bar(index, 10.5, 9.5) : bar(index, 9.5, 8.5),
      );
    }
    feed(state, warmup);

    const base = warmup.length;
    feed(state, [
      bar(base, 10, 8),
      bar(base + 1, 12, 9),
      bar(base + 2, 11, 6),
      bar(base + 3, 9, 7),
      bar(base + 4, 10, 8),
    ]);

    expect(state.valueAreaRecords.length).toBeGreaterThan(0);
    const record = state.valueAreaRecords[state.valueAreaRecords.length - 1];
    expect(record.vahPrice).not.toBeNull();
    expect(record.valPrice).not.toBeNull();

    const records = handlesForOwners(["swing-alphabet-profile-test"]);
    const lines = records.filter((entry) => entry.kind === "line");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            time1: record.time,
            price1: record.sTop,
            time2: record.time,
            price2: record.sBottom,
            color: "#1491da",
            style: "dotted",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            time1: record.time,
            time2: record.time,
            color: "#1491da",
            width: 4,
          }),
        }),
      ]),
    );
  });

  it("draws a POC line from the profile box's right edge to the leg's end at the highest-volume bin's price", () => {
    const state = makeState();
    const warmup: BarFrame[] = [];
    for (let index = 0; index < 205; index += 1) {
      warmup.push(
        index % 2 === 0 ? bar(index, 10.5, 9.5) : bar(index, 9.5, 8.5),
      );
    }
    feed(state, warmup);

    const base = warmup.length;
    feed(state, [
      bar(base, 10, 8),
      bar(base + 1, 12, 9),
      bar(base + 2, 11, 6),
      bar(base + 3, 9, 7),
      bar(base + 4, 10, 8),
    ]);

    expect(state.pocRecords.length).toBeGreaterThan(0);
    const pocRecord = state.pocRecords[state.pocRecords.length - 1];
    expect(pocRecord.price).not.toBeNull();

    const pocBin = state.profileBins
      .filter((bin) => bin.time2 === pocRecord.time1)
      .find((bin) => bin.isPoc);
    expect(pocBin).toBeDefined();
    expect(pocRecord.price).toBeCloseTo(
      (pocBin!.priceLow + pocBin!.priceHigh) / 2,
      10,
    );
    expect(pocRecord.time1).toBe(pocBin!.time2);

    const records = handlesForOwners(["swing-alphabet-profile-test"]);
    const lines = records.filter((entry) => entry.kind === "line");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            time1: pocRecord.time1,
            time2: pocRecord.time2,
            price1: pocRecord.price,
            price2: pocRecord.price,
            color: "#1491da",
            width: 2,
          }),
        }),
      ]),
    );
  });

  it("fills the POC bin's box with a solid pocColor background and white text", () => {
    const state = makeState();
    const warmup: BarFrame[] = [];
    for (let index = 0; index < 205; index += 1) {
      warmup.push(
        index % 2 === 0 ? bar(index, 10.5, 9.5) : bar(index, 9.5, 8.5),
      );
    }
    feed(state, warmup);

    const base = warmup.length;
    feed(state, [
      bar(base, 10, 8),
      bar(base + 1, 12, 9),
      bar(base + 2, 11, 6),
      bar(base + 3, 9, 7),
      bar(base + 4, 10, 8),
    ]);

    const pocBin = state.profileBins.find((bin) => bin.isPoc);
    expect(pocBin).toBeDefined();

    const records = handlesForOwners(["swing-alphabet-profile-test"]);
    const boxes = records.filter((entry) => entry.kind === "box");
    expect(boxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            price1: pocBin!.priceHigh,
            price2: pocBin!.priceLow,
            backgroundColor: "#1491da",
            textColor: "#8fcaec",
          }),
        }),
      ]),
    );

    // Box creation order (and therefore handlesForOwners' order) is
    // index-aligned 1:1 with state.profileBins -- more robust than matching
    // by price, since the repeated warmup oscillation can give two different
    // legs' bins the exact same price range.
    state.profileBins.forEach((bin, index) => {
      expect(
        (boxes[index].data as { backgroundColor: string }).backgroundColor,
      ).toBe(bin.isPoc ? "#1491da" : "rgba(0, 0, 0, 0)");
    });
  });

  it("keeps a real-time developing profile updated for the still-forming leg", () => {
    const state = makeState();
    const warmup: BarFrame[] = [];
    for (let index = 0; index < 205; index += 1) {
      warmup.push(
        index % 2 === 0 ? bar(index, 10.5, 9.5) : bar(index, 9.5, 8.5),
      );
    }
    feed(state, warmup);

    expect(state.highSwing).not.toBeNull();
    expect(state.lowSwing).not.toBeNull();

    const devBoxesAfterWarmup = handlesForOwners([
      "swing-alphabet-profile-test",
    ])
      .filter((record) => record.kind === "box")
      .slice(SETTINGS.maxProfileBins);
    const visibleAfterWarmup = devBoxesAfterWarmup.filter(
      (record) => (record.data as { text: string }).text.length > 0,
    );
    expect(visibleAfterWarmup.length).toBeGreaterThan(0);

    // A still-open (not yet closed) live tick should still recompute and
    // redraw the developing profile, extending it further.
    const liveTick: BarFrame = { ...bar(205, 11, 9), closed: false };
    swingAlphabetProfileIndicator.onBar({
      bar: liveTick,
      trades: [],
      tradeAvailability: "HISTORICAL_UNAVAILABLE",
      state,
      settings: SETTINGS,
      replace: false,
      replaying: false,
      ta: {},
      draw: { fill: () => {} },
      markers: { plotshape: () => {}, plotchar: () => {} },
      pane: { paneIndex: 0 },
    });

    const devBoxesAfterLiveTick = handlesForOwners([
      "swing-alphabet-profile-test",
    ])
      .filter((record) => record.kind === "box")
      .slice(SETTINGS.maxProfileBins);
    const visibleAfterLiveTick = devBoxesAfterLiveTick.filter(
      (record) => (record.data as { text: string }).text.length > 0,
    );
    expect(visibleAfterLiveTick.length).toBeGreaterThan(0);
  });

  it("registers swing points only from closed bars, so an early live tick cannot leave a swing the closed bar disproves", () => {
    const closedOnly = makeState();
    const live = makeState();
    const history = [bar(0, 10, 8), bar(1, 12, 9)];
    feed(closedOnly, history);
    feed(live, history);

    feed(closedOnly, [bar(2, 13, 9)]);
    expect(closedOnly.highSwing).toBeNull();

    swingAlphabetProfileIndicator.onBar(
      context(live, { ...bar(2, 11, 9), closed: false }),
    );
    expect(live.highSwing).toBeNull();
    swingAlphabetProfileIndicator.onBar(
      context(live, bar(2, 13, 9), SETTINGS, true),
    );
    expect(live.highSwing).toBeNull();
    expect(live.isDownMove).toBe(closedOnly.isDownMove);

    feed(closedOnly, [bar(3, 9, 7), bar(4, 10, 8)]);
    feed(live, [bar(3, 9, 7), bar(4, 10, 8)]);
    expect(live.segments).toEqual(closedOnly.segments);
    expect(live.highSwing).toEqual(closedOnly.highSwing);
  });

  it("keeps a leg's whole price range when the requested resolution would need more bins than the pool holds", () => {
    const fine: SwingAlphabetProfileSettings = {
      ...SETTINGS,
      profileResolution: 0.05,
      maxSwingLines: 1,
      maxProfileBins: 40,
    };
    const state = makeState(fine);
    const warmup: BarFrame[] = [];
    for (let index = 0; index < 205; index += 1) {
      warmup.push(
        index % 2 === 0 ? bar(index, 10.5, 9.5) : bar(index, 9.5, 8.5),
      );
    }
    feed(state, warmup, fine);
    const base = warmup.length;
    feed(
      state,
      [bar(base, 10, 8), bar(base + 1, 60, 9), bar(base + 2, 59, 6), bar(base + 3, 9, 7), bar(base + 4, 10, 8)],
      fine,
    );

    expect(state.segments).toHaveLength(1);
    const leg = state.segments[0];
    const legTop = Math.max(leg.price1, leg.price2);
    const legBottom = Math.min(leg.price1, leg.price2);
    expect(state.profileBins.length).toBeGreaterThan(1);
    expect(state.profileBins.length).toBeLessThanOrEqual(40);
    expect(Math.min(...state.profileBins.map((bin) => bin.priceLow))).toBeCloseTo(legBottom, 8);
    expect(Math.max(...state.profileBins.map((bin) => bin.priceHigh))).toBeCloseTo(legTop, 8);

    const devBoxes = handlesForOwners(["swing-alphabet-profile-test"])
      .filter((record) => record.kind === "box")
      .slice(fine.maxProfileBins)
      .map((record) => record.data as { text: string; price1: number });
    const shownDev = devBoxes.filter((box) => box.text.length > 0);
    expect(shownDev.length).toBeGreaterThan(0);
    expect(shownDev.length).toBeLessThanOrEqual(500);
  });

  it("never lets profile bins drift from the per-leg counts that drop them, however small maxProfileBins is", () => {
    const tight: SwingAlphabetProfileSettings = {
      ...SETTINGS,
      maxSwingLines: 3,
      maxProfileBins: 12,
    };
    const state = makeState(tight);
    const warmup: BarFrame[] = [];
    for (let index = 0; index < 205; index += 1) {
      warmup.push(
        index % 2 === 0 ? bar(index, 10.5, 9.5) : bar(index, 9.5, 8.5),
      );
    }
    feed(state, warmup, tight);

    let index = warmup.length;
    for (let leg = 0; leg < 6; leg += 1) {
      feed(
        state,
        [bar(index, 10, 8), bar(index + 1, 14, 9), bar(index + 2, 13, 6), bar(index + 3, 9, 7), bar(index + 4, 10, 8)],
        tight,
      );
      index += 5;
      const counted = state.legBinCounts.reduce((sum, count) => sum + count, 0);
      expect(state.profileBins.length).toBe(counted);
      expect(state.profileBins.length).toBeLessThanOrEqual(tight.maxProfileBins);
      expect(state.legBinCounts.length).toBe(state.valueAreaRecords.length);
      expect(state.legBinCounts.length).toBe(state.pocRecords.length);
      expect(state.profileBins[0]?.time1).toBe(
        state.valueAreaRecords[0].time + 60_000,
      );
    }
    expect(state.legBinCounts).toHaveLength(3);
    expect(state.profileBins.length).toBeGreaterThan(0);
  });
});
