import { describe, expect, it } from "vitest";
import {
  ABSORBED_MULTIPLE_SLIDER,
  ABSORBED_PERCENT_SLIDER,
  ASKED_MULTIPLES,
  ASKED_PERCENTS,
  ABSORPTION_QUIET_MS,
  CRYPTO_SHARES,
  DEFAULT_ABSORBED_MULTIPLE,
  DEFAULT_ABSORBED_PERCENT,
  DEFAULT_ABSORPTION_SETTINGS,
  DEFAULT_STRONG_PERCENT,
  FLASH_WALL_MS,
  RECORD_MULTIPLE,
  RECORD_PERCENT,
  STRONG_PERCENT_SLIDER,
  THIN_BOOK_SHARES,
  absorbedMultipleOf,
  absorbedPercentOf,
  absorptionBubbleScaleOf,
  absorptionColorOf,
  absorptionFloorFor,
  absorptionTierOf,
  absorptionRulesFor,
  absorptionSharesFor,
  shareOfWall,
  strongPercentOf,
  absorptionHistoryDaysOf,
  absorptionShapeOf,
  absorptionHistoryDaysFromHours,
  ABSORPTION_HISTORY_OPTIONS,
  wallKeyOf,
} from "../absorptionSettings";
import { minSizeFor, strongSizeFor } from "../../institutional-order-blocks-v2/institutionalV2Rules";
import { instrumentKey } from "../../../chart/drawingStore";
import { DEFAULT_LIQUIDITY_SETTINGS, clusterRowsFor, minBandSizeFor, type LiquiditySettings } from "../../passive-liquidity/liquiditySettings";
import { liquidityStyleFor } from "../../passive-liquidity/liquidityStyle";
import { bandMaxSizes, bandSizes, type LiquidityColumn } from "../../passive-liquidity/liquidityGrid";

const bn = (symbol: string, marketKind: "SPOT" | "PERPETUAL") => ({ symbol, provider: "BINANCE" as const, marketKind });
const dx = (symbol: string, assetClass: "FUTURE" | "EQUITY") => ({ symbol, provider: "DXFEED" as const, assetClass });
const M = 60_000;

/** A column over rows 0..39 with one bid band of four rows at `rows`, carrying a typical level of `reference`. */
function column(rows: readonly number[], reference?: number, median?: number): LiquidityColumn {
  const bid = new Float64Array(40);
  const ask = new Float64Array(40);
  rows.forEach((size, i) => { bid[20 + i] = size; });
  ask[30] = 1;
  return { ts: 0, lo: 0, hi: 39, bid, ask, reference, median };
}

describe("absorptionRulesFor", () => {
  // The rule of 2026-10-07: the walls are the heatmap's walls, read by its band and its paint floor; the sphere needs a
  // share of the wall and a multiple of the book's typical level. No per-asset table: the three numbers are the
  // trader's, the same on every book, and the heatmap settings of the market shape the walls.
  it("bands with the heatmap's cluster rows on this chart, and keys the spheres per band width as before", () => {
    const btc = bn("BTC-USDT", "PERPETUAL");
    const nq = dx("/NQZ26:XCME", "FUTURE");
    const perp = liquidityStyleFor("BINANCE", "BTC-USDT", "PERPETUAL").defaultSettings;
    expect(absorptionRulesFor(btc).bandRows).toBe(clusterRowsFor(perp, M));
    expect(absorptionRulesFor(btc).bandRows).toBe(10);
    expect(absorptionRulesFor(btc, undefined, 15 * M).bandRows).toBe(30);
    expect(absorptionRulesFor(btc, undefined, 60 * M).bandRows).toBe(80);
    expect(absorptionRulesFor(nq).bandRows).toBe(12);
    expect(absorptionRulesFor(nq, undefined, 60 * M).bandRows).toBe(96);
    // A sphere breaks on a close through its wall within three bars: three minutes at the least, an hour at the most.
    expect([1, 5, 15, 60, 240].map((minutes) => absorptionRulesFor(nq, undefined, minutes * M).breakWindowMs / M)).toEqual([3, 15, 45, 60, 60]);
    // The trader's own cluster, and his widening, go with the heatmap settings handed in.
    expect(absorptionRulesFor(btc, undefined, M, { ...perp, clusterRows: 4 }).bandRows).toBe(4);
    expect(absorptionRulesFor(btc, undefined, 60 * M, { ...perp, clusterRows: 4, timeframeWidening: 0.5 }).bandRows).toBe(16);
    expect(absorptionRulesFor(btc).instrument).toBe(instrumentKey(btc));
    expect(absorptionRulesFor(btc, undefined, 5 * M).instrument).toBe(instrumentKey(btc));
    expect(absorptionRulesFor(btc, undefined, 15 * M).instrument).toBe(`${instrumentKey(btc)}@x3`);
    expect(absorptionRulesFor(nq, undefined, 4 * 60 * M).instrument).toBe(`${instrumentKey(nq)}@x30`);
  });

  it("opens a wall at the heatmap's own paint floor for the column, never under the trader's minimum band size", () => {
    const btc = bn("BTC-USDT", "PERPETUAL");
    const perp = liquidityStyleFor("BINANCE", "BTC-USDT", "PERPETUAL");
    const rules = absorptionRulesFor(btc);
    const context = (reference: number) => ({ settings: perp.defaultSettings, clusterRows: 10, ladderMax: 0, reference });
    // Crypto: the heat floor share of the column's level times the cluster (0.4 x 50 x 10 = 200), over the minimum of 100.
    expect(rules.wallFloor(column([10, 10, 10, 10], 50), 1)).toBe(perp.paintFloor(column([10, 10, 10, 10], 50), context(50)));
    expect(rules.wallFloor(column([10, 10, 10, 10], 50), 1)).toBe(200);
    // Under the minimum band size the minimum stands.
    expect(rules.wallFloor(column([10, 10, 10, 10], 10), 1)).toBe(100);
    expect(absorptionRulesFor(btc, undefined, M, { ...perp.defaultSettings, minBandSize: 0 }).wallFloor(column([10, 10, 10, 10], 10), 1)).toBe(40);
    // A column without a level of its own is read against the book's reference.
    expect(rules.wallFloor(column([10, 10, 10, 10]), 50)).toBe(200);
    expect(rules.wallFloor(column([10, 10, 10, 10], 0), 50)).toBe(200);
    // An index: the biggest row must clear the column's floor per row (the heat floor share, the typical row's multiple, the reference share); NQ's minimum of 20 otherwise.
    const nq = dx("/NQZ26:XCME", "FUTURE");
    const nqStyle = liquidityStyleFor("DXFEED", "/NQZ26:XCME");
    const nqRules = absorptionRulesFor(nq);
    expect(nqRules.wallFloor(column([2, 30, 2, 2], 100), 1)).toBe(nqStyle.paintFloor(column([2, 30, 2, 2], 100), { settings: nqStyle.defaultSettings, clusterRows: 12, ladderMax: 0, reference: 100 }));
    expect(nqRules.wallFloor(column([2, 30, 2, 2], 100), 1)).toBe(62.5);
    expect(nqRules.wallFloor(column([2, 30, 2, 2], 8), 1)).toBe(20);
    // The trader's own floor on a fixed scale is the floor here too.
    const fixed: LiquiditySettings = { ...perp.defaultSettings, scaleMode: "fixed", scaleSize: 1000, minBandSize: 0 };
    expect(absorptionRulesFor(btc, undefined, M, fixed).wallFloor(column([10, 10, 10, 10], 50), 1)).toBe(0.4 * 1000 * 10);
    // On the slower charts the crypto minimum grows with the band, the index one does not.
    expect(absorptionRulesFor(btc, undefined, 60 * M).wallFloor(column([10, 10, 10, 10], 1), 1)).toBe(minBandSizeFor(perp.defaultSettings, "crypto", 60 * M));
    expect(absorptionRulesFor(btc, undefined, 60 * M).wallFloor(column([10, 10, 10, 10], 1), 1)).toBe(800);
    expect(absorptionRulesFor(nq, undefined, 60 * M).wallFloor(column([2, 2, 2, 2], 1), 1)).toBe(20);
  });
  it("reads the wall size from the heatmap's style: the full-dark row on an index book, the paint floor on crypto, never under the floor", () => {
    // NQ 2026-10-07: walls showing 12 to 20 contracts took 100 to 500 each, so a share of what the band showed never
    // bit; an attacked wall is measured as at least what the heatmap paints as a whole wall. On NQ that is the
    // full-dark row, four times the wall threshold of 1.5 levels (reference 100: 600; reference 8: 48, over the floor
    // of 20); on the perp it is the paint floor itself, so nothing changes there, and never under the trader's minimum.
    const btc = bn("BTC-USDT", "PERPETUAL");
    const perp = liquidityStyleFor("BINANCE", "BTC-USDT", "PERPETUAL");
    const rules = absorptionRulesFor(btc);
    expect(rules.wallSize(column([10, 10, 10, 10], 50), 1)).toBe(rules.wallFloor(column([10, 10, 10, 10], 50), 1));
    expect(rules.wallSize(column([10, 10, 10, 10], 50), 1)).toBe(200);
    expect(absorptionRulesFor(btc, undefined, M, { ...perp.defaultSettings, minBandSize: 100 }).wallSize(column([10, 10, 10, 10], 10), 1)).toBe(100);
    const nqRules = absorptionRulesFor(dx("/NQZ26:XCME", "FUTURE"));
    expect(nqRules.wallSize(column([2, 30, 2, 2], 100), 1)).toBe(600);
    expect(nqRules.wallSize(column([2, 30, 2, 2], 8), 1)).toBe(48);
    expect(nqRules.wallSize(column([2, 30, 2, 2], 2), 1)).toBe(20);
  });

  it("reads a band the market's way: summed rows on crypto, the biggest row on an index", () => {
    const btc = absorptionRulesFor(bn("BTC-USDT", "PERPETUAL"), undefined, M, { ...DEFAULT_LIQUIDITY_SETTINGS, clusterRows: 4 });
    const nq = absorptionRulesFor(dx("/NQZ26:XCME", "FUTURE"), undefined, M, { ...DEFAULT_LIQUIDITY_SETTINGS, clusterRows: 4 });
    const col = column([10, 20, 30, 40]);
    expect(btc.bandSize(col, "bid", 5)).toBe(bandSizes(col, 5, 4).bid);
    expect(btc.bandSize(col, "bid", 5)).toBe(100);
    expect(nq.bandSize(col, "bid", 5)).toBe(bandMaxSizes(col, 5, 4).bid);
    expect(nq.bandSize(col, "bid", 5)).toBe(40);
    expect(btc.bandSize(col, "ask", 5)).toBe(0);
  });

  it("keys the wall on the heatmap settings that make its floor, and on nothing else", () => {
    const btc = bn("BTC-USDT", "PERPETUAL");
    const perp = liquidityStyleFor("BINANCE", "BTC-USDT", "PERPETUAL").defaultSettings;
    const base = absorptionRulesFor(btc).wallKey;
    expect(base).toBe(wallKeyOf("btc-perp", 10, 100, perp));
    expect(absorptionRulesFor(btc, undefined, M, { ...perp, bidColor: "#ff0000", showLadder: false }).wallKey).toBe(base);
    for (const other of [{ clusterRows: 4 }, { minBandSize: 50 }, { heatFloor: 0.5 }, { scaleMode: "fixed" as const }, { scaleSize: 20 }]) {
      expect(absorptionRulesFor(btc, undefined, M, { ...perp, ...other }).wallKey).not.toBe(base);
    }
    expect(absorptionRulesFor(btc, undefined, 15 * M).wallKey).not.toBe(base);
    expect(absorptionRulesFor(bn("BTC-USDT", "SPOT")).wallKey).not.toBe(base);
  });

  it("carries the trader's three numbers, the strong share never under the absorbed share, and the quiet spell of the chart", () => {
    const btc = bn("BTC-USDT", "PERPETUAL");
    expect(absorptionRulesFor(btc)).toMatchObject({ absorbedPercent: 200, strongPercent: 300, absorbedMultiple: 40, quietMs: 120_000 });
    expect(absorptionRulesFor(btc, { absorbedPercent: 250, strongPercent: 500, absorbedMultiple: 60 })).toMatchObject({ absorbedPercent: 250, strongPercent: 500, absorbedMultiple: 60 });
    expect(absorptionRulesFor(btc, { absorbedPercent: 400, strongPercent: 300 })).toMatchObject({ absorbedPercent: 400, strongPercent: 400 });
    expect(absorptionRulesFor(dx("/NQZ26:XCME", "FUTURE"))).toMatchObject({ absorbedPercent: 200, strongPercent: 300, absorbedMultiple: 40 });
    expect(absorptionRulesFor(btc, undefined, 60 * M).quietMs).toBe(450_000);
    expect(absorptionRulesFor(btc, undefined, 4 * 60 * M).quietMs).toBe(1_800_000);
    expect(ABSORPTION_QUIET_MS).toBe(120_000);
  });
});

describe("the rule's numbers", () => {
  it("start at 200% of the wall, 300% for the strong ring and 40 times the book's typical level, measured on NQ", () => {
    expect([DEFAULT_ABSORBED_PERCENT, DEFAULT_STRONG_PERCENT, DEFAULT_ABSORBED_MULTIPLE]).toEqual([200, 300, 40]);
    expect(ABSORBED_PERCENT_SLIDER).toEqual({ min: 50, max: 500, step: 10 });
    expect(STRONG_PERCENT_SLIDER).toEqual({ min: 150, max: 1000, step: 10 });
    expect(ABSORBED_MULTIPLE_SLIDER).toEqual({ min: 3, max: 200, step: 1 });
  });

  it("record an attack from the sliders' lowest numbers, all of the wall and five times the level, so any setting reads the records without asking the host again", () => {
    expect([RECORD_PERCENT, RECORD_MULTIPLE]).toEqual([ABSORBED_PERCENT_SLIDER.min, ABSORBED_MULTIPLE_SLIDER.min]);
    expect([RECORD_PERCENT, RECORD_MULTIPLE]).toEqual([50, 3]);
  });

  it("ask the engine for every number the Absorbed and Minimum absorbed sliders can make, so a record's trail holds the column each is met at (PR #48 review)", () => {
    expect(ASKED_PERCENTS).toEqual(Array.from({ length: 46 }, (_, i) => 50 + 10 * i));
    expect(ASKED_MULTIPLES).toEqual(Array.from({ length: 198 }, (_, i) => 3 + i));
    expect([ASKED_PERCENTS[0], ASKED_MULTIPLES[0]]).toEqual([RECORD_PERCENT, RECORD_MULTIPLE]);
    const rules = absorptionRulesFor({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" });
    expect(rules.askedPercents).toBe(ASKED_PERCENTS);
    expect(rules.askedMultiples).toBe(ASKED_MULTIPLES);
  });

  it("read as saved, held to their sliders, and as the defaults when missing or nonsense", () => {
    expect(absorbedPercentOf(undefined)).toBe(200);
    expect(absorbedPercentOf({})).toBe(200);
    expect(absorbedPercentOf({ absorbedPercent: 250 })).toBe(250);
    expect(absorbedPercentOf({ absorbedPercent: 30 })).toBe(50);
    expect(absorbedPercentOf({ absorbedPercent: 50 })).toBe(50);
    expect(absorbedPercentOf({ absorbedPercent: 900 })).toBe(500);
    expect([0, -5, Number.NaN, Infinity].map((value) => absorbedPercentOf({ absorbedPercent: value }))).toEqual([200, 200, 200, 200]);
    expect(strongPercentOf(undefined)).toBe(300);
    expect(strongPercentOf({ strongPercent: 700 })).toBe(700);
    expect(strongPercentOf({ strongPercent: 2000 })).toBe(1000);
    expect(strongPercentOf({ strongPercent: 100 })).toBe(200);
    expect(strongPercentOf({ absorbedPercent: 400, strongPercent: 300 })).toBe(400);
    expect(strongPercentOf({ absorbedPercent: 400 })).toBe(400);
    expect(absorbedMultipleOf(undefined)).toBe(40);
    expect(absorbedMultipleOf({ absorbedMultiple: 60 })).toBe(60);
    expect(absorbedMultipleOf({ absorbedMultiple: 2 })).toBe(3);
    expect(absorbedMultipleOf({ absorbedMultiple: 3 })).toBe(3);
    expect(absorbedMultipleOf({ absorbedMultiple: 1000 })).toBe(200);
    expect(absorbedMultipleOf({ absorbedMultiple: Number.NaN })).toBe(40);
  });

  it("read a saved number at its slider's nearest step, so every setting is one the records were kept for (PR #48 review)", () => {
    expect(absorbedPercentOf({ absorbedPercent: 204 })).toBe(200);
    expect(absorbedPercentOf({ absorbedPercent: 206 })).toBe(210);
    expect(absorbedPercentOf({ absorbedPercent: 497 })).toBe(500);
    expect(strongPercentOf({ strongPercent: 333 })).toBe(330);
    expect(absorbedMultipleOf({ absorbedMultiple: 41.4 })).toBe(41);
    expect(absorbedMultipleOf({ absorbedMultiple: 3.6 })).toBe(4);
    expect(absorbedMultipleOf({ absorbedMultiple: 199.7 })).toBe(200);
  });
});

describe("Session Levels' floor and share", () => {
  // The levels indicator still judges "absorbed" by the per-chart floor and first share the spheres used until
  // 2026-10-07: a number per chart from the second order-blocks indicator's tables (BTC perp 100 and 150 on 1m and 5m,
  // 325 on 15m; NQ 75; NVDA 5,000), twice the wall on a thin book, a quarter on crypto.
  it("is the trader's own number on each crypto pair's 1m and 5m charts, and from 15m the base times the band factor, never under the 5m number", () => {
    expect([1, 3, 5, 14, 15, 60, 240, 1440].map((m) => absorptionFloorFor(bn("ETH-USDT", "PERPETUAL"), m * M))).toEqual([5000, 5000, 10_000, 10_000, 10_000, 19_200, 72_000, 192_000]);
    expect([1, 5, 15, 60].map((m) => absorptionFloorFor(bn("ETH-USDT", "SPOT"), m * M))).toEqual([500, 500, 1080, 2880]);
    expect([1, 3, 5, 14, 15, 30, 60, 240].map((m) => absorptionFloorFor(bn("BTC-USDT", "PERPETUAL"), m * M))).toEqual([100, 100, 150, 150, 325, 325, 600, 2250]);
    expect([1, 5, 15, 60].map((m) => absorptionFloorFor(bn("BTC-USDT", "SPOT"), m * M))).toEqual([30, 30, 60, 160]);
    expect([1, 5, 15].map((m) => absorptionFloorFor(bn("SOL-USDT", "PERPETUAL"), m * M))).toEqual([10, 10, 30]);
    expect([1, 5, 15, 60, 240].map((m) => absorptionFloorFor(dx("/NQZ26:XCME", "FUTURE"), m * M))).toEqual([75, 75, 225, 600, 2250]);
    expect([1, 60].map((m) => absorptionFloorFor(dx("/ESZ26:XCME", "FUTURE"), m * M))).toEqual([300, 2400]);
    expect([1, 60].map((m) => absorptionFloorFor(dx("NVDA", "EQUITY"), m * M))).toEqual([5000, 40_000]);
    expect(absorptionTierOf(M)).toBe("1m");
    expect(absorptionTierOf(5 * M)).toBe("5m");
    expect(absorptionTierOf(14 * M)).toBe("5m");
    expect(absorptionTierOf(15 * M)).toBe("x3");
    expect(absorptionTierOf(60 * M)).toBe("x8");
  });

  it("is the OB floor on crypto and the stocks, the strong size on the index futures, and NVDA's own 5,000, except BTC perp and NQ at their own 75, and the pairs with numbers of their own on the minute chart", () => {
    expect(absorptionFloorFor(bn("ETH-USDT", "PERPETUAL"))).toBe(5000);
    expect(absorptionFloorFor(bn("ETH-USDT", "SPOT"))).toBe(500);
    expect(absorptionFloorFor(bn("BTC-USDT", "PERPETUAL"))).toBe(100);
    expect(absorptionFloorFor(bn("BTC-USDT", "SPOT"))).toBe(30);
    expect(absorptionFloorFor(dx("/NQZ26:XCME", "FUTURE"))).toBe(75);
    expect(absorptionFloorFor(dx("/MNQZ26:XCME", "FUTURE"))).toBeGreaterThan(75);
    expect(absorptionFloorFor(dx("/ESZ26:XCME", "FUTURE"))).toBe(300);
    expect(absorptionFloorFor(dx("AAPL", "EQUITY"))).toBe(2000);
    expect(absorptionFloorFor(dx("TSLA", "EQUITY"))).toBe(2000);
    expect(absorptionFloorFor(dx("NVDA", "EQUITY"))).toBe(5000);
    for (const identity of [bn("SOL-USDT", "PERPETUAL"), dx("AAPL", "EQUITY")]) expect(absorptionFloorFor(identity)).toBe(minSizeFor(identity));
    for (const identity of [dx("/ESZ26:XCME", "FUTURE")]) expect(absorptionFloorFor(identity)).toBe(strongSizeFor(identity));
    expect(absorptionFloorFor(dx("/CLZ26:XNYM", "FUTURE"))).toBe(Infinity);
  });

  it("is a quarter of the wall on crypto and twice the wall on the index and stock books", () => {
    expect(CRYPTO_SHARES).toEqual([0.25, 0.6]);
    expect(THIN_BOOK_SHARES).toEqual([2, 3]);
    expect(absorptionSharesFor(bn("ETH-USDT", "PERPETUAL"))).toBe(CRYPTO_SHARES);
    expect(absorptionSharesFor(dx("/NQZ26:XCME", "FUTURE"))).toBe(THIN_BOOK_SHARES);
    // The historical archive's book is the same thin index and stock book.
    expect(absorptionSharesFor({ provider: "DATABENTO", assetClass: "FUTURE" })).toBe(THIN_BOOK_SHARES);
    expect(absorptionSharesFor({ provider: "DATABENTO", assetClass: "EQUITY" })).toBe(THIN_BOOK_SHARES);
  });
});

describe("settings", () => {
  it("are opacity, the spheres' size, the two colours, the strong-only switch, the rule's three numbers, History and the shape", () => {
    // The colours start as the heatmap's, so the spheres read as that side's wall until the trader picks his own.
    expect(DEFAULT_ABSORPTION_SETTINGS).toEqual({ opacity: 0.7, bubbleScale: 0.5, bidColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor, askColor: DEFAULT_LIQUIDITY_SETTINGS.askColor, showBroken: true, absorbedPercent: 200, strongPercent: 300, absorbedMultiple: 40, historyDays: 1, shape: "circle" });
    expect(Object.keys(DEFAULT_ABSORPTION_SETTINGS)).toEqual(["opacity", "bubbleScale", "bidColor", "askColor", "showBroken", "absorbedPercent", "strongPercent", "absorbedMultiple", "historyDays", "shape"]);
    expect(absorptionShapeOf(DEFAULT_ABSORPTION_SETTINGS)).toBe("circle");
    expect(absorptionShapeOf({ shape: "triangle" })).toBe("triangle");
    expect(absorptionShapeOf({ shape: "square" })).toBe("square");
    expect(absorptionShapeOf({ shape: "blob" as never })).toBe("circle");
    expect(absorptionShapeOf({})).toBe("circle");
    expect(absorptionHistoryDaysOf(DEFAULT_ABSORPTION_SETTINGS)).toBe(1);
    expect(absorptionHistoryDaysOf({ historyDays: 5 })).toBe(5);
    expect(absorptionHistoryDaysOf({ historyDays: 2 })).toBe(1);
    expect(absorptionHistoryDaysOf({ historyDays: 500 })).toBe(1);
    expect(absorptionHistoryDaysOf({})).toBe(1);
  });

  it("offers history off beside the heatmap's reaches, and turns the hours saved before the reaches into the nearest one, the shorter of two as near, so the old default of 48 hours is the new default of a day (PR #47 review)", () => {
    expect(ABSORPTION_HISTORY_OPTIONS.map(([days, label]) => `${days}:${label}`)).toEqual(["0:Off", "1:1 day", "3:3 days", "5:5 days", "7:1 week"]);
    expect(absorptionHistoryDaysOf({ historyDays: 0 })).toBe(0);
    expect(absorptionHistoryDaysFromHours(0)).toBe(0);
    expect([-5, Number.NaN].map((hours) => absorptionHistoryDaysFromHours(hours))).toEqual([1, 1]);
    const hours = [1, 12, 24, 36, 48, 50, 72, 96, 100, 120, 144, 150, 168, 500];
    expect(hours.map((saved) => absorptionHistoryDaysFromHours(saved))).toEqual([1, 1, 1, 1, 1, 3, 3, 3, 5, 5, 5, 7, 7, 7]);
  });

  it("reads a missing or unusable colour as the heatmap's, and a chosen one as chosen", () => {
    expect(absorptionColorOf({ opacity: 1 }, "bid")).toBe(DEFAULT_LIQUIDITY_SETTINGS.bidColor);
    expect(absorptionColorOf({ opacity: 1, askColor: "" }, "ask")).toBe(DEFAULT_LIQUIDITY_SETTINGS.askColor);
    expect(absorptionColorOf({ opacity: 1, bidColor: "#ff8800" }, "bid")).toBe("#ff8800");
    expect(absorptionColorOf({ opacity: 1, askColor: "#123456" }, "ask")).toBe("#123456");
  });

  it("reads the bubble scale as one when it is missing or nonsense", () => {
    expect(absorptionBubbleScaleOf({ opacity: 1 })).toBe(1);
    expect(absorptionBubbleScaleOf({ opacity: 1, bubbleScale: 0 })).toBe(1);
    expect(absorptionBubbleScaleOf({ opacity: 1, bubbleScale: Number.NaN })).toBe(1);
    expect(absorptionBubbleScaleOf({ opacity: 1, bubbleScale: 1.5 })).toBe(1.5);
  });

  it("keeps the flash-wall span the first order-blocks indicator imports", () => {
    expect(FLASH_WALL_MS).toBe(180_000);
  });
});

describe("shareOfWall", () => {
  it("words a fraction as of the wall and a multiple as the wall, for the switch's hint", () => {
    expect(shareOfWall(0.25)).toBe("a quarter of the wall");
    expect(shareOfWall(0.6)).toBe("sixty percent of the wall");
    expect(shareOfWall(2)).toBe("twice the wall");
    expect(shareOfWall(3)).toBe("three times the wall");
  });
});
