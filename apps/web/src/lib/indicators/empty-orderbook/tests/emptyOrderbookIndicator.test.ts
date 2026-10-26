import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { historicalL2, type IndicatorL2 } from "../../../chart/indicatorL2";
import type { IndicatorLiquidity } from "../../../chart/indicatorLiquidity";
import { INDICATOR_REGISTRY, historicalIndicatorAvailability } from "../../../chart/indicatorRegistry";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import { withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import { handlesForOwners, resetDrawRegistryForTests } from "../../../chart/draw/registry";
import type { BoxData } from "../../../chart/draw/box";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import { withAlpha } from "../../classic-order-blocks/orderBlockRender";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../passive-liquidity/liquiditySettings";
import { bandMaxSizes, bandSizes, type LiquidityColumn, type LiquiditySide } from "../../passive-liquidity/liquidityGrid";
import { stepEmptyBook } from "../emptyBookModel";
import { EMPTY_BOOK_STATUS_TEXT, MAX_MODEL_SLOTS, MIN_ROWS_PER_SIDE, REPLAY_MS, ROW_CAP_SLACK, SENSITIVITY, STALE_MS, ZONE_SLOTS, clearedSince, emptyOrderbookIndicator, heatmapRowsOf, leftEdgeOf, modelFor, resetModelsForTests, type EmptyOrderbookState } from "../emptyOrderbookIndicator";
import { FLASH_ALPHA, FLASH_FLOOR, ZONE_BORDER_ALPHA, ZONE_FILL_ALPHA, flashAlpha, keptZones, restingIn, sizeText } from "../emptyOrderbookRender";
import { DEFAULT_EMPTY_ORDERBOOK_SETTINGS, heightRowsOf, marketFieldsFor, refillMultipleOf, thinShareOf, type EmptyOrderbookSettings } from "../emptyOrderbookSettings";
import { settingsSchemaFor } from "../../../chart/settingsSchemaFor";

vi.mock("../emptyBookModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../emptyBookModel")>();
  return { ...actual, stepEmptyBook: vi.fn(actual.stepEmptyBook) };
});

const T0 = 1_700_000_040_000;
const S = 1_000;
const M = 60_000;
const ROW = 4;
const BID = 10_000;
const LAST = T0 + 239 * S;
const SETTINGS = DEFAULT_EMPTY_ORDERBOOK_SETTINGS;
const JOINED = T0 + 119 * S;

type Edit = readonly [side: LiquiditySide, lo: number, hi: number, size: number];

function makeBar(ts_open: number, interval_ms = M): BarFrame {
  return { type: "bar", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", interval_ms, ts_open, open: 40_000, high: 40_004, low: 39_996, close: 40_000, volume: 100, trade_count: 10, closed: false };
}

function nqBar(ts_open: number): BarFrame {
  return { type: "bar", provider: "DXFEED", assetClass: "FUTURE", symbol: "/NQZ26:XCME", interval_ms: M, ts_open, open: 40_000, high: 40_004, low: 39_996, close: 40_000, volume: 100, trade_count: 10, closed: false };
}

/** Every row holds 10 on its side of the touch, 220 rows each way, then the edits on top. */
function book(ts: number, edits: readonly Edit[]): LiquidityColumn {
  const lo = BID - 220;
  const hi = BID + 221;
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  for (let row = lo; row <= BID; row += 1) bid[row - lo] = 10;
  for (let row = BID + 1; row <= hi; row += 1) ask[row - lo] = 10;
  const column = { ts, lo, hi, bid, ask };
  for (const [side, from, to, size] of edits) for (let row = from; row <= to; row += 1) column[side][row - lo] = size;
  return column;
}

const THIN: Edit = ["ask", 10_020, 10_039, 1];

/** Four minutes of one-second columns from T0; `last` replaces the edits on the newest column. */
function columnsOf(edits: readonly Edit[] = [THIN], last: readonly Edit[] = edits, from = T0, count = 240, step = S): LiquidityColumn[] {
  return Array.from({ length: count }, (_, i) => book(from + i * step, i === count - 1 ? last : edits));
}

function feedOf(columns: LiquidityColumn[], epoch = 1, columnMs = S): ColumnFeed {
  return { epoch, deep: null, fine: { columns, columnMs } };
}

function liquidityOf(feed: ColumnFeed, heatmapClusterRows: number | null = 2): IndicatorLiquidity {
  return { get feed() { return feed; }, rowWidth: ROW, baseAsset: "BTC", version: 1, heatmapClusterRows };
}

function context(state: EmptyOrderbookState, bar: BarFrame, settings: EmptyOrderbookSettings, liquidity?: IndicatorLiquidity, l2?: IndicatorL2, drawNow = true): IndicatorBarCtx<EmptyOrderbookState, EmptyOrderbookSettings> {
  return { bar, trades: [], tradeAvailability: "LIVE_COMPLETE", liquidity, l2, state, settings, replace: false, replaying: false, drawNow, ta: {}, draw: { fill: vi.fn() }, markers: { plotshape: vi.fn(), plotchar: vi.fn() }, pane: { paneIndex: 0 } };
}

function stateFor(owner: string, settings = SETTINGS): EmptyOrderbookState {
  return withDrawOwnerScope(owner, () => withStreamCreationWindow(() => emptyOrderbookIndicator.createState(settings)));
}

const FIRST_BAR = T0 - 7 * M;

/** Steps ten closed bars without drawing, the first seven from before the book, then draws the live bar at T0 + 3 min. */
function run(owner: string, liquidity: IndicatorLiquidity, settings = SETTINGS, state = stateFor(owner, settings)): EmptyOrderbookState {
  for (let bar = FIRST_BAR; bar < T0 + 3 * M; bar += M) emptyOrderbookIndicator.onBar(context(state, makeBar(bar), settings, liquidity, undefined, false));
  emptyOrderbookIndicator.onBar(context(state, makeBar(T0 + 3 * M), settings, liquidity));
  return state;
}

/** Like run, with some candles' low and high set by open time, and some minutes with no candle at all. */
function runWith(owner: string, liquidity: IndicatorLiquidity, ranges: Readonly<Record<number, readonly [low: number, high: number]>>, settings = SETTINGS, missing: readonly number[] = []): EmptyOrderbookState {
  const state = stateFor(owner, settings);
  for (let open = FIRST_BAR; open <= T0 + 3 * M; open += M) {
    if (missing.includes(open)) continue;
    const [low, high] = ranges[open] ?? [39_996, 40_004];
    emptyOrderbookIndicator.onBar(context(state, { ...makeBar(open), low, high }, settings, liquidity, undefined, open === T0 + 3 * M));
  }
  return state;
}

/** Draws the live candle with every column but the last, then again once the last column arrives, as the chart does once a second. */
function runAndStep(owner: string, columns: readonly LiquidityColumn[], settings = SETTINGS, ranges: Readonly<Record<number, readonly [low: number, high: number]>> = {}, epoch = 1): EmptyOrderbookState {
  const book = columns.slice(0, -1);
  const liquidity = liquidityOf(feedOf(book, epoch));
  const state = runWith(owner, liquidity, ranges, settings);
  book.push(columns[columns.length - 1]);
  const [low, high] = ranges[T0 + 3 * M] ?? [39_996, 40_004];
  emptyOrderbookIndicator.onBar(context(state, { ...makeBar(T0 + 3 * M), low, high }, settings, liquidity));
  return state;
}

function drawn(owner: string): BoxData[] {
  return handlesForOwners([owner]).filter((record) => record.kind === "box").map((record) => record.data as BoxData).filter((box) => box.time1 !== 0);
}

function zones(owner: string): BoxData[] {
  return drawn(owner).filter((box) => box.text !== "");
}

function flashes(owner: string): BoxData[] {
  return drawn(owner).filter((box) => box.text === "" && box.backgroundColor !== "transparent");
}

beforeEach(() => {
  resetDrawRegistryForTests();
  resetModelsForTests();
  vi.mocked(stepEmptyBook).mockClear();
  vi.spyOn(Date, "now").mockReturnValue(LAST + S);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emptyOrderbookIndicator", () => {
  it("offers Size per Zone, Refill Size, Fixed Zone Height, Rows Clear of Price, Zone Length, Keep the Levels, Zones per Side, the flash switch and the two colours, every number on a slider, and no Sensitivity", () => {
    const schema = emptyOrderbookIndicator.settingsSchema ?? [];
    expect(schema.map((field) => ("key" in field ? [field.key, field.kind] : null))).toEqual([
      ["thinPctCrypto", "slider"],
      ["thinPctIndex", "slider"],
      ["refillPctCrypto", "slider"],
      ["refillPctIndex", "slider"],
      ["fixedHeight", "boolean"],
      ["heightRows", "slider"],
      ["clearRows", "slider"],
      ["zoneLengthMin", "slider"],
      ["levelsBy", "radioGroup"],
      ["zonesPerSide", "slider"],
      ["showFlash", "boolean"],
      ["askColor", "color"],
      ["bidColor", "color"],
    ]);
    expect(schema.find((field) => "key" in field && field.key === "zoneLengthMin")).toMatchObject({ min: 1, max: 240, step: 1, label: "Zone Length (min)" });
    expect(schema.find((field) => "key" in field && field.key === "zonesPerSide")).toMatchObject({ min: 1, max: 8, step: 1 });
    expect(schema.find((field) => "key" in field && field.key === "clearRows")).toMatchObject({ min: 0, max: 20, step: 1, label: "Rows Clear of Price" });
    const height = schema.find((field) => "key" in field && field.key === "heightRows");
    expect(height).toMatchObject({ min: 1, max: 20, step: 1, label: "Zone Height (rows)" });
    expect(height?.visibleIf?.(SETTINGS)).toBe(false);
    expect(height?.visibleIf?.({ ...SETTINGS, fixedHeight: true })).toBe(true);
    expect(schema.find((field) => "key" in field && field.key === "fixedHeight")).toMatchObject({ label: "Fixed Zone Height" });
    for (const key of ["thinPctCrypto", "thinPctIndex"]) expect(schema.find((field) => "key" in field && field.key === key)).toMatchObject({ min: 10, max: 100, step: 5, label: "Size per Zone (%)" });
    for (const key of ["refillPctCrypto", "refillPctIndex"]) expect(schema.find((field) => "key" in field && field.key === key)).toMatchObject({ min: 100, max: 300, step: 10, label: "Refill Size (%)" });
    expect(DEFAULT_EMPTY_ORDERBOOK_SETTINGS).toEqual({ thinPctCrypto: 50, thinPctIndex: 75, refillPctCrypto: 100, refillPctIndex: 100, fixedHeight: false, heightRows: 1, clearRows: 4, zoneLengthMin: 30, levelsBy: "nearest", zonesPerSide: 3, showFlash: true, askColor: DEFAULT_LIQUIDITY_SETTINGS.askColor, bidColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor });
  });

  it("is an L2 overlay in the registry, right after Order Flow Gaps, unavailable on a historical chart", () => {
    expect(emptyOrderbookIndicator).toMatchObject({ kind: "runtime", id: "emptyOrderbook", label: "Empty Orderbook", category: "l2", lines: [], placement: { kind: "overlay" } });
    const ids = INDICATOR_REGISTRY.map((def) => def.id);
    expect(ids.indexOf("emptyOrderbook")).toBe(ids.indexOf("liquidityVoids") + 1);
    expect(historicalIndicatorAvailability("emptyOrderbook", new Set(["ohlcv", "buy_volume", "trade_families"]), "BINANCE")).toEqual({
      available: false,
      reason: "Needs published, verified historical L2 states for this instrument. Zoom to an available August 2026 hour.",
    });
  });

  it("draws a thin stretch as a box lightly filled in its side's colour, from the bar it began in to the live bar, with the side, the rows, what rests there now, the price range and the age in its corner", () => {
    const state = run("zone", liquidityOf(feedOf(columnsOf())));
    expect(zones("zone")).toEqual([
      expect.objectContaining({
        time1: T0 + M,
        time2: T0 + 3 * M,
        price1: 40_160,
        price2: 40_080,
        extendRight: true,
        borderColor: withAlpha(SETTINGS.askColor, ZONE_BORDER_ALPHA),
        backgroundColor: withAlpha(SETTINGS.askColor, ZONE_FILL_ALPHA),
        text: "Empty Book Ask · 10 rows · 20.0 BTC · from 40,080 to 40,160 · 2m",
        textFallbacks: ["Empty Book Ask · 10 rows · 20.0 BTC · from 40,080 to 40,160", "Empty Book Ask · 10 rows · 20.0 BTC", "Empty Book Ask · 10 rows", "Empty Book Ask"],
        textAlign: "right",
        textVAlign: "bottom",
      }),
    ]);
    expect(state.model?.zones.ask).toEqual([expect.objectContaining({ lo: 5_010, hi: 5_019, since: JOINED, shown: true })]);
    expect(flashes("zone")).toEqual([]);
    expect(state.shownStatus).toBeNull();
  });

  it("uses the heatmap's Row Size: one-row rows make the same stretch twenty rows tall", () => {
    run("fine", liquidityOf(feedOf(columnsOf()), 1));
    expect(zones("fine").map((box) => box.text)).toEqual(["Empty Book Ask · 20 rows · 20.0 BTC · from 40,080 to 40,160 · 2m"]);
  });

  it("falls back to the instrument's own heatmap Row Size before the heatmap's settings arrive, and scales the rows with the timeframe like the heatmap", () => {
    const wide = { ts: T0, lo: BID - 1_023, hi: BID + 1_024, bid: new Float64Array(2_048), ask: new Float64Array(2_048) };
    const feed = feedOf([wide]);
    const at = (interval: number, rows: number | null) => heatmapRowsOf({ bar: makeBar(T0, interval), liquidity: liquidityOf(feed, rows) });
    expect(at(M, null)).toBe(10);
    expect(at(M, 2)).toBe(2);
    expect(at(15 * M, 2)).toBe(6);
    expect(at(60 * M, 2)).toBe(16);
  });

  it("never makes the rows so coarse that the book holds fewer than 30 a side: finer rows than the heatmap on the higher timeframes", () => {
    expect(MIN_ROWS_PER_SIDE).toBe(30);
    const wide = { ts: T0, lo: BID - 1_023, hi: BID + 1_024, bid: new Float64Array(2_048), ask: new Float64Array(2_048) };
    const at = (interval: number, rows: number, columns: LiquidityColumn[] = [wide]) => heatmapRowsOf({ bar: makeBar(T0, interval), liquidity: liquidityOf(feedOf(columns), rows) });
    expect(at(240 * M, 10)).toBe(34);
    expect(at(1_440 * M, 10)).toBe(34);
    expect(at(60 * M, 10)).toBe(34);
    expect(at(60 * M, 2)).toBe(16);
    expect(at(M, 10, columnsOf())).toBe(7);
    expect(at(M, 10, [{ ...wide, lo: BID, hi: BID + 10 }])).toBe(1);
    expect(at(240 * M, 10, [])).toBe(300);
  });

  it("keeps the row size it drew with while the book narrows by a row or two, so the boxes do not flip between two row sizes", () => {
    expect(ROW_CAP_SLACK).toBe(2);
    const of = (side: number): LiquidityColumn => ({ ts: T0, lo: BID - side, hi: BID + side, bid: new Float64Array(2 * side + 1), ask: new Float64Array(2 * side + 1) });
    const at = (side: number, previous?: number, interval = 240 * M) => heatmapRowsOf({ bar: makeBar(T0, interval), liquidity: liquidityOf(feedOf([of(side)]), 10) }, previous);
    expect(at(629)).toBe(20);
    expect(at(629, 21)).toBe(21);
    expect(at(629, 22)).toBe(22);
    expect(at(629, 23)).toBe(20);
    expect(at(629, 19)).toBe(20);
    expect(at(630, 20)).toBe(21);
    expect(at(629, 12, M)).toBe(10);
    const state = stateFor("steady");
    const draw = (side: number) => emptyOrderbookIndicator.onBar(context(state, makeBar(T0 + 3 * M, 240 * M), SETTINGS, liquidityOf(feedOf([of(side)]), 10)));
    draw(630);
    expect(state.clusterRows).toBe(21);
    draw(629);
    expect(state.clusterRows).toBe(21);
  });

  it("with Fixed Zone Height on, takes the slider's rows as the zone's least height: one thin row is a zone at 1, three rows are not enough at 4", () => {
    expect(heightRowsOf(SETTINGS)).toBeNull();
    expect(heightRowsOf({ ...SETTINGS, fixedHeight: true })).toBe(1);
    expect(heightRowsOf({ ...SETTINGS, fixedHeight: true, heightRows: 30 })).toBe(20);
    expect(heightRowsOf({ ...SETTINGS, fixedHeight: true, heightRows: 0 })).toBe(1);
    expect(heightRowsOf({ ...SETTINGS, fixedHeight: true, heightRows: Number.NaN })).toBe(1);
    const lone = liquidityOf(feedOf(columnsOf([["ask", 10_020, 10_021, 1]])));
    run("off", lone);
    expect(zones("off")).toEqual([]);
    run("one", lone, { ...SETTINGS, fixedHeight: true, heightRows: 1 });
    expect(zones("one").map((box) => box.text)).toEqual(["Empty Book Ask · 1 row · 2.00 BTC · from 40,080 to 40,088 · 2m"]);
    const three = liquidityOf(feedOf(columnsOf([["ask", 10_020, 10_025, 1]]), 2));
    run("three-at-four", three, { ...SETTINGS, fixedHeight: true, heightRows: 4 });
    expect(zones("three-at-four")).toEqual([]);
    run("three-at-three", three, { ...SETTINGS, fixedHeight: true, heightRows: 3 });
    expect(zones("three-at-three").map((box) => [box.price2, box.price1])).toEqual([[40_080, 40_104]]);
  });

  it("draws a zone from the bar it began in, no further back than the Zone Length, and keeps the real age on its label", () => {
    const liquidity = liquidityOf(feedOf(columnsOf()));
    run("long", liquidity, { ...SETTINGS, zoneLengthMin: 240 });
    expect(zones("long")).toEqual([expect.objectContaining({ time1: T0 + M, text: "Empty Book Ask · 10 rows · 20.0 BTC · from 40,080 to 40,160 · 2m" })]);
    run("short", liquidity, { ...SETTINGS, zoneLengthMin: 1 });
    expect(zones("short")).toEqual([expect.objectContaining({ time1: T0 + 2 * M, text: "Empty Book Ask · 10 rows · 20.0 BTC · from 40,080 to 40,160 · 2m" })]);
    const hourly = [{ open: 0 }, { open: 60 * M }, { open: 120 * M }, { open: 180 * M }];
    expect(leftEdgeOf(hourly, 70 * M, 200 * M, 240 * M, 180 * M, 60 * M)).toBe(60 * M);
    expect(leftEdgeOf(hourly, 70 * M, 200 * M, 30 * M, 180 * M, 60 * M)).toBe(120 * M);
    expect(leftEdgeOf(hourly, 190 * M, 200 * M, 240 * M, 180 * M, 60 * M)).toBe(180 * M);
  });

  it("writes what rests in the zone right now as the ladder reads its rows, in the instrument's unit: whole contracts and shares, coins like the ladder", () => {
    const column = book(T0, [["ask", 10_020, 10_023, 2.5], ["ask", 10_021, 10_021, 4]]);
    expect(restingIn(column, { side: "ask", lo: 5_010, hi: 5_011 }, 2, bandSizes)).toBe(11.5);
    expect(restingIn(column, { side: "ask", lo: 5_010, hi: 5_011 }, 2, bandMaxSizes)).toBe(6.5);
    expect(restingIn(column, { side: "bid", lo: 5_010, hi: 5_011 }, 2, bandSizes)).toBe(0);
    expect(restingIn(column, { side: "ask", lo: 5_105, hi: 5_120 }, 2, bandSizes)).toBe(120);
    expect(restingIn(column, { side: "ask", lo: 5_105, hi: 5_120 }, 2, bandMaxSizes)).toBe(60);
    expect(sizeText(12.4, "contracts")).toBe("12 contracts");
    expect(sizeText(0, "contracts")).toBe("0 contracts");
    expect(sizeText(1_250, "shares")).toBe("1,250 shares");
    expect(sizeText(3.456, "BTC")).toBe("3.46 BTC");
    expect(sizeText(0, "BTC")).toBe("0 BTC");
    run("newest", liquidityOf(feedOf(columnsOf([THIN], [["ask", 10_020, 10_039, 0.5]]))));
    expect(zones("newest").map((box) => box.text)).toEqual(["Empty Book Ask · 10 rows · 10.0 BTC · from 40,080 to 40,160 · 2m"]);
  });

  it("adds up the ladder's numbers on indexes, the biggest order of each row, where crypto adds up every order in the zone", () => {
    const liquidity = liquidityOf(feedOf(columnsOf([THIN], [THIN, ["ask", 10_020, 10_020, 3]])));
    const state = stateFor("nq");
    for (let open = FIRST_BAR; open <= T0 + 3 * M; open += M) emptyOrderbookIndicator.onBar(context(state, nqBar(open), SETTINGS, liquidity, undefined, open === T0 + 3 * M));
    expect(zones("nq").map((box) => box.text)).toEqual(["Empty Book Ask · 10 rows · 12 contracts · from 40,080 to 40,160 · 2m"]);
    run("btc", liquidity);
    expect(zones("btc").map((box) => box.text)).toEqual(["Empty Book Ask · 10 rows · 22.0 BTC · from 40,080 to 40,160 · 2m"]);
  });

  it("shows one Size per Zone and one Refill Size slider, the crypto ones on a crypto pair and the index and stock ones on dxFeed, so each market keeps its own", () => {
    const shown = (identity: Parameters<typeof settingsSchemaFor>[1], label: string) =>
      settingsSchemaFor(emptyOrderbookIndicator, identity).filter((field) => "label" in field && field.label === label && (field.visibleIf?.(SETTINGS) ?? true)).map((field) => ("key" in field ? field.key : null));
    expect(shown({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" }, "Size per Zone (%)")).toEqual(["thinPctCrypto"]);
    expect(shown({ provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" }, "Size per Zone (%)")).toEqual(["thinPctIndex"]);
    expect(shown({ provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }, "Size per Zone (%)")).toEqual(["thinPctIndex"]);
    expect(shown({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" }, "Refill Size (%)")).toEqual(["refillPctCrypto"]);
    expect(shown({ provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" }, "Refill Size (%)")).toEqual(["refillPctIndex"]);
    expect(Object.keys(marketFieldsFor({ provider: "BINANCE" }))).toEqual(["thinPctIndex", "refillPctIndex"]);
    expect(Object.keys(marketFieldsFor({ provider: "DXFEED" }))).toEqual(["thinPctCrypto", "refillPctCrypto"]);
  });

  it("calls a row thin under 50 % of a typical row on crypto and 75 % on indexes and stocks by default, each moved by its own slider, kept between 10 and 100 %", () => {
    expect(thinShareOf(SETTINGS, { provider: "BINANCE" })).toBe(0.5);
    expect(thinShareOf(SETTINGS, { provider: "DXFEED" })).toBe(0.75);
    expect(thinShareOf({ ...SETTINGS, thinPctCrypto: 65 }, { provider: "BINANCE" })).toBe(0.65);
    expect(thinShareOf({ ...SETTINGS, thinPctCrypto: 65 }, { provider: "DXFEED" })).toBe(0.75);
    expect(thinShareOf({ ...SETTINGS, thinPctIndex: 40 }, { provider: "DXFEED" })).toBe(0.4);
    expect(thinShareOf({ ...SETTINGS, thinPctCrypto: 5 }, { provider: "BINANCE" })).toBe(0.1);
    expect(thinShareOf({ ...SETTINGS, thinPctCrypto: 150 }, { provider: "BINANCE" })).toBe(1);
    expect(thinShareOf({ ...SETTINGS, thinPctCrypto: Number.NaN }, { provider: "BINANCE" })).toBe(0.5);
  });

  it("leaves a stretch at 60 % of a typical row out on crypto by default, and draws it once the crypto slider is raised to 75 %", () => {
    const liquidity = liquidityOf(feedOf(columnsOf([["ask", 10_020, 10_039, 6]])));
    run("strict", liquidity);
    expect(zones("strict")).toEqual([]);
    const loose = run("loose", liquidity, { ...SETTINGS, thinPctCrypto: 75 });
    expect(zones("loose").map((box) => [box.price2, box.price1])).toEqual([[40_080, 40_160]]);
    expect(loose.model?.zones.ask).toEqual([expect.objectContaining({ lo: 5_010, hi: 5_019 })]);
    run("index-slider", liquidity, { ...SETTINGS, thinPctIndex: 100 });
    expect(zones("index-slider")).toEqual([]);
  });

  it("refills a row at 100 % of a typical row on crypto and on indexes and stocks by default, each moved by its own slider, kept between 100 and 300 %", () => {
    expect(refillMultipleOf(SETTINGS, { provider: "BINANCE" })).toBe(1);
    expect(refillMultipleOf(SETTINGS, { provider: "DXFEED" })).toBe(1);
    expect(refillMultipleOf({ ...SETTINGS, refillPctCrypto: 150 }, { provider: "BINANCE" })).toBe(1.5);
    expect(refillMultipleOf({ ...SETTINGS, refillPctCrypto: 150 }, { provider: "DXFEED" })).toBe(1);
    expect(refillMultipleOf({ ...SETTINGS, refillPctIndex: 200 }, { provider: "DXFEED" })).toBe(2);
    expect(refillMultipleOf({ ...SETTINGS, refillPctCrypto: 50 }, { provider: "BINANCE" })).toBe(1);
    expect(refillMultipleOf({ ...SETTINGS, refillPctCrypto: 400 }, { provider: "BINANCE" })).toBe(3);
    expect(refillMultipleOf({ ...SETTINGS, refillPctCrypto: Number.NaN }, { provider: "BINANCE" })).toBe(1);
  });

  it("flashes a row of a stretch once it holds a typical row again by default, and waits for more once the crypto Refill Size is raised", () => {
    const back: Edit[] = [THIN, ["ask", 10_020, 10_021, 10]];
    runAndStep("refill-default", columnsOf([THIN], back));
    expect(flashes("refill-default")).toHaveLength(1);
    expect(zones("refill-default").map((box) => box.text)).toEqual(["Empty Book Ask · 9 rows · 18.0 BTC · from 40,088 to 40,160 · 2m"]);
    runAndStep("refill-raised", columnsOf([THIN], back), { ...SETTINGS, refillPctCrypto: 150 }, {}, 2);
    expect(flashes("refill-raised")).toEqual([]);
    expect(zones("refill-raised").map((box) => box.text)).toEqual(["Empty Book Ask · 10 rows · 38.0 BTC · from 40,080 to 40,160 · 2m"]);
    runAndStep("refill-index-slider", columnsOf([THIN], back), { ...SETTINGS, refillPctIndex: 150 }, {}, 3);
    expect(flashes("refill-index-slider")).toHaveLength(1);
  });

  it("lets Rows Clear of Price bring the first zone closer to price or push it away", () => {
    const liquidity = liquidityOf(feedOf(columnsOf([["ask", 10_002, 10_039, 1]])));
    run("default", liquidity);
    expect(zones("default").map((box) => box.price2)).toEqual([40_048]);
    run("close", liquidity, { ...SETTINGS, clearRows: 0 });
    expect(zones("close").map((box) => box.price2)).toEqual([40_016]);
    run("far", liquidity, { ...SETTINGS, clearRows: 10 });
    expect(zones("far").map((box) => box.price2)).toEqual([40_096]);
  });

  it("starts a zone's box and its age after the last candle that traded inside its prices, so no closed candle sits inside a box", () => {
    const liquidity = liquidityOf(feedOf(columnsOf()));
    runWith("touched", liquidity, { [T0 + M]: [40_000, 40_085] });
    expect(zones("touched")).toEqual([expect.objectContaining({ time1: T0 + 2 * M, text: "Empty Book Ask · 10 rows · 20.0 BTC · from 40,080 to 40,160 · 1m" })]);
    runWith("bottom", liquidity, { [T0 + M]: [40_000, 40_080] });
    expect(zones("bottom")).toEqual([expect.objectContaining({ time1: T0 + 2 * M })]);
    runWith("above", liquidity, { [T0 + 2 * M]: [40_160, 40_200] });
    expect(zones("above")).toEqual([expect.objectContaining({ time1: T0 + M, text: "Empty Book Ask · 10 rows · 20.0 BTC · from 40,080 to 40,160 · 2m" })]);
    runWith("before", liquidity, { [T0 - M]: [40_000, 40_200] });
    expect(zones("before")).toEqual([expect.objectContaining({ time1: T0 + M })]);
    runWith("live", liquidity, { [T0 + 3 * M]: [40_000, 40_100] });
    expect(zones("live")).toEqual([expect.objectContaining({ time1: T0 + 3 * M, text: "Empty Book Ask · 10 rows · 20.0 BTC · from 40,080 to 40,160 · 0m" })]);
    const growing = runWith("growing", liquidity, {});
    expect(zones("growing")).toEqual([expect.objectContaining({ time1: T0 + M })]);
    emptyOrderbookIndicator.onBar(context(growing, { ...makeBar(T0 + 3 * M), low: 39_996, high: 40_100 }, SETTINGS, liquidity));
    expect(zones("growing")).toEqual([expect.objectContaining({ time1: T0 + 3 * M })]);
  });

  it("starts a box on the next candle there is when the minute after the touching candle has none", () => {
    const gappy = [{ open: 0 }, { open: 60 * M }, { open: 180 * M }];
    expect(leftEdgeOf(gappy, 120 * M, 200 * M, 240 * M, 240 * M, 60 * M)).toBe(180 * M);
    expect(leftEdgeOf(gappy, 130 * M, 200 * M, 240 * M, 240 * M, 60 * M)).toBe(180 * M);
    expect(leftEdgeOf(gappy, 70 * M, 200 * M, 240 * M, 240 * M, 60 * M)).toBe(60 * M);
    expect(leftEdgeOf(gappy, -5 * M, 200 * M, 400 * M, 240 * M, 60 * M)).toBe(0);
    expect(leftEdgeOf(gappy, 250 * M, 260 * M, 240 * M, 240 * M, 60 * M)).toBe(240 * M);
    expect(leftEdgeOf([], 120 * M, 200 * M, 240 * M, 240 * M, 60 * M)).toBe(240 * M);
    runWith("gap", liquidityOf(feedOf(columnsOf())), { [T0 + M]: [40_000, 40_085] }, SETTINGS, [T0 + 2 * M]);
    expect(zones("gap")).toEqual([expect.objectContaining({ time1: T0 + 3 * M })]);
  });

  it("finds the last candle inside a price range from the newest back, no further than the zone's start", () => {
    const bars = [{ open: 0, high: 10, low: 5 }, { open: 60, high: 30, low: 25 }, { open: 120, high: 12, low: 8 }];
    expect(clearedSince(bars, 30, 20, 40, 60)).toBe(120);
    expect(clearedSince(bars, 30, 50, 60, 60)).toBe(30);
    expect(clearedSince(bars, 130, 20, 40, 60)).toBe(130);
    expect(clearedSince(bars, 30, 12, 20, 60)).toBe(180);
    expect(clearedSince(bars, 30, 30, 40, 60)).toBe(120);
    expect(clearedSince(bars, 30, 31, 40, 60)).toBe(30);
    expect(clearedSince(bars, 30, 20, 25, 60)).toBe(30);
    expect(clearedSince([], 30, 20, 40, 60)).toBe(30);
  });

  it("draws a refill's flash from where its box started, and only for a row that was inside a drawn box", () => {
    runAndStep("flash-box", columnsOf([THIN], [THIN, ["ask", 10_020, 10_021, 25]]), SETTINGS, { [T0 + M]: [40_150, 40_200] });
    expect(flashes("flash-box")).toEqual([expect.objectContaining({ time1: T0 + 2 * M, price1: 40_088, price2: 40_080 })]);
    const four: Edit[] = [THIN, ["ask", 10_050, 10_069, 1], ["ask", 10_080, 10_099, 1], ["ask", 10_110, 10_129, 1]];
    runAndStep("flash-hidden", columnsOf(four, [...four, ["ask", 10_118, 10_119, 25]]), SETTINGS, {}, 2);
    expect(zones("flash-hidden")).toHaveLength(3);
    expect(flashes("flash-hidden")).toEqual([]);
    const late = stateFor("flash-late");
    emptyOrderbookIndicator.onBar(context(late, makeBar(T0 + 3 * M), SETTINGS, liquidityOf(feedOf(columnsOf([THIN], [THIN, ["ask", 10_020, 10_021, 25]]), 3))));
    expect(flashes("flash-late")).toEqual([]);
  });

  it("counts both parts of a split as one zone in Zones per Side, so a refill in the middle shows as two boxes", () => {
    const parts = [
      { side: "ask" as const, lo: 5_010, hi: 5_013, since: 1, group: 1 },
      { side: "ask" as const, lo: 5_015, hi: 5_019, since: 1, group: 1 },
      { side: "ask" as const, lo: 5_030, hi: 5_035, since: 2, group: 3 },
    ];
    expect(keptZones(parts, 1, 5_000, "nearest").map((zone) => zone.lo)).toEqual([5_010, 5_015]);
    expect(keptZones(parts, 2, 5_000, "nearest").map((zone) => zone.lo)).toEqual([5_010, 5_015, 5_030]);
    expect(keptZones(parts, 1, 5_000, "furthest").map((zone) => zone.lo)).toEqual([5_030]);
    expect(keptZones(parts.map(({ group: _group, ...zone }) => zone), 1, 5_000, "nearest").map((zone) => zone.lo)).toEqual([5_010]);
    expect(ZONE_SLOTS).toBe(32);
    runAndStep("split", columnsOf([THIN], [THIN, ["ask", 10_028, 10_029, 25]]), { ...SETTINGS, zonesPerSide: 1 });
    expect(zones("split").map((box) => [box.price2, box.price1, box.time1])).toEqual([[40_080, 40_112, T0 + M], [40_120, 40_160, T0 + M]]);
    expect(flashes("split")).toEqual([expect.objectContaining({ price2: 40_112, price1: 40_120, time1: T0 + M })]);
  });

  it("with Fixed Zone Height on, draws only the emptiest rows of each zone at exactly that height, and hides the rest of it", () => {
    const edits: Edit[] = [THIN, ["ask", 10_026, 10_027, 0]];
    const liquidity = liquidityOf(feedOf(columnsOf(edits)));
    run("exact-one", liquidity, { ...SETTINGS, fixedHeight: true, heightRows: 1 });
    expect(zones("exact-one").map((box) => box.text)).toEqual(["Empty Book Ask · 1 row · 0 BTC · from 40,104 to 40,112 · 2m"]);
    run("exact-two", liquidity, { ...SETTINGS, fixedHeight: true, heightRows: 2 });
    expect(zones("exact-two").map((box) => box.text)).toEqual(["Empty Book Ask · 2 rows · 2.00 BTC · from 40,096 to 40,112 · 2m"]);
    run("whole", liquidity);
    expect(zones("whole").map((box) => box.text)).toEqual(["Empty Book Ask · 10 rows · 18.0 BTC · from 40,080 to 40,160 · 2m"]);
  });

  it("flashes a refilled row in the side's colour across the zone, and the zone closes up around what is still thin", () => {
    const state = runAndStep("flash", columnsOf([THIN], [THIN, ["ask", 10_020, 10_021, 25]]));
    emptyOrderbookIndicator.onBar(context(state, makeBar(T0 + 3 * M), SETTINGS, liquidityOf(feedOf(columnsOf([THIN], [THIN, ["ask", 10_020, 10_021, 25]])))));
    expect(flashes("flash")).toEqual([
      expect.objectContaining({ time1: T0 + M, time2: T0 + 3 * M, price1: 40_088, price2: 40_080, extendRight: true, backgroundColor: withAlpha(SETTINGS.askColor, FLASH_ALPHA), borderColor: "transparent" }),
    ]);
    expect(zones("flash").map((box) => box.text)).toEqual(["Empty Book Ask · 9 rows · 18.0 BTC · from 40,088 to 40,160 · 2m"]);
  });

  it("fades the flash over its three seconds, never under a quarter of its strength", () => {
    expect(flashAlpha(0, 3_000)).toBeCloseTo(FLASH_ALPHA);
    expect(flashAlpha(1_000, 3_000)).toBeCloseTo((FLASH_ALPHA * 2) / 3);
    expect(flashAlpha(2_000, 3_000)).toBeCloseTo(FLASH_ALPHA / 3);
    expect(flashAlpha(2_900, 3_000)).toBeCloseTo(FLASH_ALPHA * FLASH_FLOOR);
    expect(flashAlpha(0, 0)).toBeCloseTo(FLASH_ALPHA * FLASH_FLOOR);
  });

  it("draws no flash with the flash switched off, and the zone still closes up", () => {
    runAndStep("no-flash", columnsOf([THIN], [THIN, ["ask", 10_020, 10_021, 25]]), { ...SETTINGS, showFlash: false });
    expect(flashes("no-flash")).toEqual([]);
    expect(zones("no-flash").map((box) => box.text)).toEqual(["Empty Book Ask · 9 rows · 18.0 BTC · from 40,088 to 40,160 · 2m"]);
  });

  it("keeps Zones per Side, the nearest to price by default and the furthest when asked, each side on its own", () => {
    const both: Edit[] = [THIN, ["ask", 10_060, 10_079, 1], ["bid", 9_960, 9_979, 1]];
    const liquidity = liquidityOf(feedOf(columnsOf(both)));
    run("nearest", liquidity, { ...SETTINGS, zonesPerSide: 1 });
    expect(zones("nearest").map((box) => [box.price2, box.price1])).toEqual([[39_840, 39_920], [40_080, 40_160]]);
    run("furthest", liquidity, { ...SETTINGS, zonesPerSide: 1, levelsBy: "furthest" });
    expect(zones("furthest").map((box) => [box.price2, box.price1])).toEqual([[39_840, 39_920], [40_240, 40_320]]);
    run("all", liquidity);
    expect(zones("all")).toHaveLength(3);
  });

  it("says it is waiting without the book, unavailable in Historical Mode, and stale when the newest column is old, and draws no zone then", () => {
    const liquidity = liquidityOf(feedOf(columnsOf()));
    const waiting = stateFor("waiting");
    emptyOrderbookIndicator.onBar(context(waiting, makeBar(T0 + 3 * M), SETTINGS));
    expect(waiting.shownStatus).toBe("waiting");
    const historical = stateFor("historical");
    emptyOrderbookIndicator.onBar(context(historical, makeBar(T0 + 3 * M), SETTINGS, liquidity, historicalL2()));
    expect(historical.shownStatus).toBe("historical");
    expect(drawn("historical")).toEqual([expect.objectContaining({ text: EMPTY_BOOK_STATUS_TEXT.historical })]);
    run("fresh", liquidity);
    expect(zones("fresh")).toHaveLength(1);
    vi.spyOn(Date, "now").mockReturnValue(LAST + STALE_MS + 1);
    const stale = run("stale", liquidity);
    expect(stale.shownStatus).toBe("stale");
    expect(drawn("stale")).toEqual([expect.objectContaining({ text: EMPTY_BOOK_STATUS_TEXT.stale })]);
  });

  it("keeps the book it has read across a change of Zone Length, colour or the flash, and reads it again for a new Size per Zone or Refill Size", () => {
    const liquidity = liquidityOf(feedOf(columnsOf()));
    run("first", liquidity);
    expect(vi.mocked(stepEmptyBook)).toHaveBeenCalledTimes(240);
    vi.mocked(stepEmptyBook).mockClear();
    const restyled = run("restyled", liquidity, { ...SETTINGS, zoneLengthMin: 10, askColor: "#ff0000", showFlash: false });
    expect(vi.mocked(stepEmptyBook)).not.toHaveBeenCalled();
    expect(restyled.model?.zones.ask).toEqual([expect.objectContaining({ since: JOINED, shown: true })]);
    expect(zones("restyled")).toEqual([expect.objectContaining({ borderColor: withAlpha("#ff0000", ZONE_BORDER_ALPHA) })]);
    const stricter = run("stricter", liquidity, { ...SETTINGS, thinPctCrypto: 40 });
    expect(vi.mocked(stepEmptyBook)).toHaveBeenCalledTimes(240);
    expect(stricter.model).not.toBe(restyled.model);
    const refilling = run("refilling", liquidity, { ...SETTINGS, refillPctCrypto: 150 });
    expect(vi.mocked(stepEmptyBook)).toHaveBeenCalledTimes(480);
    expect(refilling.model).not.toBe(restyled.model);
  });

  it("always uses the High sensitivity: on BTC at 8 USD rows a zone needs 4 rows, so four thin rows draw a zone and three do not", () => {
    expect(SENSITIVITY).toBe("high");
    run("four", liquidityOf(feedOf(columnsOf([["ask", 10_020, 10_027, 1]]))));
    expect(zones("four").map((box) => [box.price2, box.price1])).toEqual([[40_080, 40_112]]);
    run("three", liquidityOf(feedOf(columnsOf([["ask", 10_020, 10_025, 1]]), 2)));
    expect(zones("three")).toEqual([]);
  });

  it("finds a thin stretch anywhere in the book the chart holds, not only near price", () => {
    run("far", liquidityOf(feedOf(columnsOf([["ask", 10_180, 10_199, 1]]))));
    expect(zones("far").map((box) => [box.price2, box.price1])).toEqual([[40_720, 40_800]]);
  });

  it("starts over on a new grid, a new Row Size or a new timeframe", () => {
    const columns = columnsOf();
    const first = run("epoch-1", liquidityOf(feedOf(columns, 1)));
    const reset = run("epoch-2", liquidityOf(feedOf(columns, 2)));
    expect(reset.model).not.toBe(first.model);
    const rows = run("rows-1", liquidityOf(feedOf(columns, 2), 1));
    expect(rows.model).not.toBe(reset.model);
    expect(rows.model?.clusterRows).toBe(1);
  });

  it("reads back as far as the longest Zone Length when it starts, through the 10 s columns and then the 1 s ones, so a zone keeps its real age", () => {
    const deep = columnsOf([THIN], [THIN], T0 - 6 * 60 * M, 6 * 360, 10 * S);
    const feed: ColumnFeed = { epoch: 1, deep: { columns: deep, columnMs: 10 * S }, fine: { columns: columnsOf(), columnMs: S } };
    expect(REPLAY_MS).toBe(245 * M);
    run("past", liquidityOf(feed), { ...SETTINGS, zoneLengthMin: 240 });
    const calls = vi.mocked(stepEmptyBook).mock.calls;
    expect(calls[0][1].ts).toBe(T0 - 14_460 * S);
    expect(calls[0][3]).toBe(10 * S);
    expect(calls.at(-1)?.[3]).toBe(S);
    expect(calls).toHaveLength(1_446 + 240);
    expect(zones("past")).toEqual([expect.objectContaining({ time1: FIRST_BAR, text: "Empty Book Ask · 10 rows · 20.0 BTC · from 40,080 to 40,160 · 4h 3m" })]);
    run("past-capped", liquidityOf(feed), { ...SETTINGS, zoneLengthMin: 5 });
    expect(zones("past-capped")).toEqual([expect.objectContaining({ time1: T0 - 2 * M })]);
  });

  it("keeps reading the book past the end of the last candle, so a market that stops printing candles still shows the book as it is now", () => {
    const state = stateFor("closed");
    const liquidity = liquidityOf(feedOf(columnsOf([THIN], [["ask", 10_020, 10_039, 0.5]])));
    emptyOrderbookIndicator.onBar(context(state, makeBar(T0 + M), SETTINGS, liquidity));
    expect(state.model?.lastTs).toBe(LAST);
    expect(zones("closed").map((box) => box.text)).toEqual(["Empty Book Ask · 10 rows · 10.0 BTC · from 40,080 to 40,160 · 2m"]);
  });

  it("reads nothing and draws nothing on a bar it is told not to draw", () => {
    const state = stateFor("quiet");
    emptyOrderbookIndicator.onBar(context(state, makeBar(T0 + 3 * M), SETTINGS, liquidityOf(feedOf(columnsOf())), undefined, false));
    expect(state.model).toBeNull();
    expect(vi.mocked(stepEmptyBook)).not.toHaveBeenCalled();
    expect(drawn("quiet")).toEqual([]);
  });

  it("reads the book on the bar it draws, with that bar's price, so a replay never judges the book on its oldest bar", () => {
    const liquidity = liquidityOf(feedOf(columnsOf()));
    const sol = stateFor("sol");
    const solBar = (open: number, close: number): BarFrame => ({ ...makeBar(open), symbol: "SOL-USDT", close });
    for (let open = FIRST_BAR; open < T0 + 3 * M; open += M) emptyOrderbookIndicator.onBar(context(sol, solBar(open, open === FIRST_BAR ? 800_000 : 40_000), SETTINGS, liquidity, undefined, false));
    emptyOrderbookIndicator.onBar(context(sol, solBar(T0 + 3 * M, 40_000), SETTINGS, liquidity));
    expect(zones("sol").map((box) => box.text)).toEqual(["Empty Book Ask · 10 rows · 20.0 SOL · from 40,080 to 40,160 · 2m"]);
  });

  it("keeps the models of the last few books and lets go of the one unused longest", () => {
    const first = modelFor("a", 1);
    const oldest = modelFor("b1", 1);
    for (let i = 2; i < MAX_MODEL_SLOTS; i += 1) modelFor(`b${i}`, 1);
    expect(modelFor("a", 1)).toBe(first);
    modelFor("c", 1);
    expect(modelFor("a", 1)).toBe(first);
    expect(modelFor("b1", 1)).not.toBe(oldest);
  });
});
