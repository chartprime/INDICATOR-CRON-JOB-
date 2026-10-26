// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { AbsorptionTracker, absorptionWallsKey, detectAbsorption, type AbsorptionPrint, type AbsorptionRecord, type ColumnFeed } from "../absorptionEngine";
import { ABSORPTION_BUBBLE_MAX_PX, ABSORPTION_BUBBLE_MIN_PX, ABSORPTION_RADIUS_FULL_MULTIPLE, BASE_ALPHA, LIVE_HISTORY_TWIN_MS, PENDING_ALPHA, REFILL_ALPHA_STEP, SECOND_SPHERE_ALPHA, absorptionFillFor, absorptionRadius, barCloses, chartCandleOpen, layoutAbsorption, printAlpha } from "../absorptionPrimitive";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../passive-liquidity/liquiditySettings";
import { AbsorptionPrimitive, absorptionStatusText } from "../absorptionPrimitive";
import { ABSORPTION_STORAGE_KEY, AbsorptionStore } from "../absorptionStore";
import { AbsorptionHistory } from "../absorptionHistory";
import { ColumnHistoryStream } from "../../passive-liquidity/columnHistoryStream";
import type { HistoryRequest } from "../../passive-liquidity/heatmapHistory";
import type { LiquidityColumn, LiquidityGrid } from "../../passive-liquidity/liquidityGrid";
import type { AbsorptionRules } from "../absorptionSettings";
import { parseRgb } from "../../passive-liquidity/liquidityHeatmapHost";
import { HistoricalLiquidityGrid } from "../../../archive/historicalLiquidityGrid";
import { historicalBookL2 } from "../../../archive/historicalBookL2";
import { historicalBookLiquidity } from "../../../archive/historicalBookLiquidity";
import type { HistoricalBookSecond } from "../../../archive/historicalL2States";
import { historicalL2, type IndicatorL2 } from "../../../chart/indicatorL2";
import { BAND, ROW, RULES, STEP, T as LIVE_T, col, feedOf, tape, type Col } from "./absorptionFixtures";

const T = 1_700_000_000_000;
const print = (over: Partial<AbsorptionPrint> = {}): AbsorptionPrint => ({
  key: "bid:50:4:0", side: "bid", band: 50, rows: 4, ts: T + 10_000, attackTs: T, share: 2, strong: false, shown: 256, resting: 256, absorbed: 600, yardstick: 10, current: 126, refills: 0, price: 200.5, judgedAt: T + 10_000, held: true, broken: false, ...over,
});
// A record of one attack, 300 into a wall of 256: a sphere at the fixture's numbers, not the strong ring; its one trail entry is its own column.
const record = (over: Partial<AbsorptionRecord> & { current?: number } = {}): AbsorptionRecord => {
  const { current = 126, ...rest } = over;
  const base = { key: "bid:50:4:0", side: "bid" as const, band: 50, rows: 4, ts: T + 10_000, attackTs: T, shown: 256, resting: 256, absorbed: 300, yardstick: 10, refills: 0, price: 200.5, endTs: null, endReason: null, ...rest };
  const first = { ts: base.ts, absorbed: base.absorbed, current, refills: base.refills };
  const trail = base.trail ?? [first];
  return { trail, latest: trail[trail.length - 1], ...base };
};
// 1 px per second, 1 px per price unit from the bottom of a 1000 x 500 pane.
const geometry = { xOf: (ms: number) => (ms - T) / 1000, yOf: (price: number) => (price > 1000 ? null : 500 - price), width: 1000, height: 500 };
const rules: AbsorptionRules = { ...RULES, instrument: "BINANCE:PERPETUAL:BTC-USDT" };
// The live charts here read the book at rows of ROW: their records are filed under these walls.
const WALLS = absorptionWallsKey(rules, ROW);
const memory = () => ({ items: new Map<string, string>(), getItem(key: string) { return this.items.get(key) ?? null; }, setItem(key: string, value: string) { this.items.set(key, value); } });

describe("layoutAbsorption", () => {
  it("uses real candle opens and chart coordinates across market closures", () => {
    const bars = [{ time: 3_600 }, { time: 18_000 }, { time: 400_000 }];
    const intervalMs = 4 * 3_600_000;
    expect(chartCandleOpen(bars, 18_100_000, intervalMs)).toBe(18_000_000);
    expect(chartCandleOpen(bars, 100_000_000, intervalMs)).toBeNull();
    const actual = [print({ ts: 18_100_000 }), print({ ts: 18_200_000, band: 51 }), print({ ts: 400_010_000, band: 52 })];
    const chartGeometry = { ...geometry, xOf: (ms: number) => ms === 18_000_000 ? 100 : ms === 400_000_000 ? 120 : null };
    expect(layoutAbsorption(actual, 1, chartGeometry, intervalMs, (ts) => chartCandleOpen(bars, ts, intervalMs)).map((bubble) => [bubble.x, bubble.sphere.count]).sort((a, b) => a[0] - b[0])).toEqual([[100, 2], [120, 1]]);
  });

  it("puts a sphere at the crossing column on the band's mid price, sized by what was absorbed over the book's typical level", () => {
    const [bubble] = layoutAbsorption([print()], 1, geometry);
    expect(bubble).toMatchObject({ x: 10, y: 500 - 200.5, r: absorptionRadius(600, 10, 1), pending: false, broken: false });
    expect(bubble.r).toBeCloseTo(ABSORPTION_BUBBLE_MIN_PX + (ABSORPTION_BUBBLE_MAX_PX - ABSORPTION_BUBBLE_MIN_PX) * Math.sqrt(60 / ABSORPTION_RADIUS_FULL_MULTIPLE));
    expect(bubble.alpha).toBeCloseTo(BASE_ALPHA);
    // Two hundred times the level or more: the largest; nothing: the smallest; the trader's scale multiplies; no level reads as full.
    expect(ABSORPTION_RADIUS_FULL_MULTIPLE).toBe(200);
    expect(absorptionRadius(2000, 10, 1)).toBe(ABSORPTION_BUBBLE_MAX_PX);
    expect(absorptionRadius(9000, 10, 1)).toBe(ABSORPTION_BUBBLE_MAX_PX);
    expect(absorptionRadius(0, 10, 1)).toBe(ABSORPTION_BUBBLE_MIN_PX);
    expect(absorptionRadius(500, 10, 2)).toBeCloseTo(2 * (ABSORPTION_BUBBLE_MIN_PX + (ABSORPTION_BUBBLE_MAX_PX - ABSORPTION_BUBBLE_MIN_PX) * 0.5));
    expect(absorptionRadius(5, 0, 1)).toBe(ABSORPTION_BUBBLE_MAX_PX);
    // Off the pane, or at a price the scale cannot place: not laid out.
    expect(layoutAbsorption([print({ ts: T + 2_000_000 })], 1, geometry)).toHaveLength(0);
    expect(layoutAbsorption([print({ price: 5000 })], 1, geometry)).toHaveLength(0);
    // Smallest first, so the biggest is painted last and reads in front.
    expect(layoutAbsorption([print({ absorbed: 1500 }), print({ absorbed: 20, ts: T + 20_000 })], 1, geometry).map((b) => b.x)).toEqual([20, 10]);
  });

  it("merges the spheres of a side inside one of the chart's candles into one at the candle, so a four-hour candle carries one sphere and not twenty", () => {
    // Two bid prints 30 s and 50 s into a one-minute candle opening 40 s after T (T is not on the minute): one sphere at
    // the candle's open, at the absorbed-weighted price, sized by the sums over the largest level, a shade darker for the
    // second print. An ask print in the same candle is its own sphere.
    const C = Math.ceil(T / 60_000) * 60_000;
    expect(C - T).toBe(40_000);
    const prints = [print({ ts: C + 30_000, price: 200, absorbed: 100, shown: 256, resting: 256, yardstick: 5 }), print({ ts: C + 50_000, band: 51, attackTs: C + 40_000, price: 210, absorbed: 300, shown: 256, resting: 256, yardstick: 10 }), print({ ts: C + 40_000, side: "ask", band: 60, price: 300 })];
    const bubbles = layoutAbsorption(prints, 1, geometry, 60_000);
    expect(bubbles).toHaveLength(2);
    const bid = bubbles.find((b) => b.sphere.side === "bid")!;
    expect(bid).toMatchObject({ x: 40, y: 500 - (200 * 100 + 210 * 300) / 400, r: absorptionRadius(400, 10, 1), pending: false });
    expect(bid.alpha).toBeCloseTo(BASE_ALPHA + REFILL_ALPHA_STEP);
    expect(bid.sphere.count).toBe(2);
    // Without a candle every print is its own sphere at its own column, smallest first: 20, 30 and 60 times the level.
    expect(layoutAbsorption(prints, 1, geometry).map((b) => b.x)).toEqual([70, 90, 80]);
  });

  it("darkens a step for every refill the wall had made, more for the strong ring, draws one still holding as a faint outline, and carries a broken one hollow", () => {
    expect(printAlpha(print())).toBeCloseTo(BASE_ALPHA);
    expect(printAlpha(print({ refills: 3 }))).toBeCloseTo(BASE_ALPHA + 3 * REFILL_ALPHA_STEP);
    expect(printAlpha(print({ share: 3, strong: true }))).toBeCloseTo(BASE_ALPHA + SECOND_SPHERE_ALPHA);
    expect(printAlpha(print({ share: 3 }))).toBeCloseTo(BASE_ALPHA);
    expect(printAlpha(print({ strong: true, refills: 9 }))).toBe(1);
    expect(printAlpha(print({ held: null }))).toBe(PENDING_ALPHA);
    const [pending] = layoutAbsorption([print({ held: null })], 1, geometry);
    expect(pending).toMatchObject({ pending: true, alpha: PENDING_ALPHA });
    const [broken] = layoutAbsorption([print({ broken: true })], 1, geometry);
    expect(broken).toMatchObject({ pending: false, broken: true, alpha: BASE_ALPHA });
  });
});

describe("AbsorptionPrimitive on a chart", () => {
  it("lays the kept spheres out merged by the chart's own candle: two records inside one four-hour candle are one sphere", () => {
    // A store holding two bid records an hour apart inside one 4h candle, a chart of 4h bars, an empty book: the primitive
    // reads the candle off the bars and draws one sphere, not two. The candle is the last full one before now, since the
    // store keeps a week and the primitive reads the clock.
    const H4 = 4 * 3_600_000;
    const C = Math.floor(Date.now() / H4) * H4 - H4;
    const store = new AbsorptionStore(memory());
    store.add(WALLS, [record({ ts: C + 600_000, price: 2600, key: "bid:50:4:a" }), record({ ts: C + 7_200_000, band: 51, price: 2610, key: "bid:51:4:b" })], C + H4);
    const primitive = new AbsorptionPrimitive(store);
    const timeScale = { timeToCoordinate: (time: number) => time === C / 1000 ? 490 : 500, options: () => ({ barSpacing: 10 }), width: () => 1000 };
    const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) };
    const series = { data: () => [{ time: C / 1000, close: 2600 }, { time: C / 1000 + 14_400, close: 2600 }], priceToCoordinate: (price: number) => 500 - price / 10 };
    primitive.attached({ chart, series, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    const grid = { clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: [], columnMs: 1000, deepColumnMs: 10_000, rowWidth: 4, baseAsset: "BTC", levels: [] } as unknown as LiquidityGrid;
    primitive.setSources(grid);
    primitive.setRules(rules);
    primitive.updateAllViews();
    expect(primitive.prints).toHaveLength(2);
    expect(primitive.bubbles).toHaveLength(1);
    expect(primitive.bubbles[0].sphere.count).toBe(2);
    // Centred on its candle, not on the candle's left edge: zoomed out on a slow chart the edge is half a bar away, in the gap before it.
    expect(primitive.bubbles[0].x).toBeCloseTo(490);
    expect(primitive.bubbles[0].y).toBeCloseTo(500 - primitive.bubbles[0].sphere.price / 10);
    // Show broken levels off: neither kept record's wall broke, so both stay drawn; the prints stay whatever the switch.
    primitive.setSettings({ opacity: 1, showBroken: false });
    primitive.updateAllViews();
    expect(primitive.prints).toHaveLength(2);
    expect(primitive.bubbles).toHaveLength(1);
    expect(primitive.bubbles[0].sphere.count).toBe(2);
    store.add(WALLS, [record({ ts: C + 600_000, price: 2600, key: "bid:50:4:a", absorbed: 600 })], C + H4);
    primitive.setRules({ ...rules, instrument: "other" });
    primitive.setRules(rules);
    primitive.updateAllViews();
    expect([primitive.prints.length, primitive.bubbles.length]).toEqual([2, 1]);
    // A candle the chart cannot place draws no sphere, rather than one pinned to the pane's left edge.
    (timeScale as { timeToCoordinate: (time: number) => number | null }).timeToCoordinate = () => null;
    primitive.updateAllViews();
    expect([primitive.prints.length, primitive.bubbles.length]).toEqual([2, 0]);
    primitive.detached();
  });

  it("files its records under the walls they were read with, the engine's own key: another band, scale or row width loads its own set and never draws the last one's (NQ 2026-10-13)", () => {
    // Keyed on the instrument alone, every change of the heatmap's band or scale re-read the book and added a full set of
    // records beside the one before: on NQ, 500 records at eleven band widths in half an hour, the same attacks drawn up
    // to six times over. A set is filed under what the engine resets on, and only the current set shows.
    const walls = (of: AbsorptionRules, rowWidth: number) => JSON.stringify([of.instrument, of.bandRows, of.wallKey, of.quietMs, rowWidth]);
    const other: AbsorptionRules = { ...rules, wallKey: "other" };
    const storage = memory();
    const store = new AbsorptionStore(storage);
    const C = Math.floor((Date.now() - 3_600_000) / STEP) * STEP;
    store.add(walls(rules, ROW), [record({ ts: C, price: 2600, key: "bid:50:4:a" }), record({ ts: C + 60_000, band: 51, price: 2610, key: "bid:51:4:b" })], C + 120_000);
    const primitive = new AbsorptionPrimitive(store);
    const timeScale = { timeToCoordinate: () => 490, options: () => ({ barSpacing: 10 }), width: () => 1000 };
    primitive.attached({ chart: { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) }, series: { data: () => [{ time: LIVE_T / 1000, close: 100 }], priceToCoordinate: () => 100 }, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    const book = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 160 }, { wall: 20, sell: 80 }, { wall: 20 }], 20);
    const grid = (rowWidth: number) => ({ provider: "BINANCE", historicalFeed: null, clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: book, columnMs: 1000, deepColumnMs: STEP, rowWidth, baseAsset: "BTC", referenceSize: 10, levels: [] }) as unknown as LiquidityGrid;
    const keys = () => primitive.records.map((entry) => entry.key).sort();
    primitive.setSources(grid(ROW));
    primitive.setRules(rules);
    expect(keys()).toEqual(["bid:50:4:a", "bid:51:4:b"]);
    primitive.updateAllViews();
    const attack = `bid:${BAND}:4:${LIVE_T + 3 * STEP}`;
    expect(keys()).toEqual([attack, "bid:50:4:a", "bid:51:4:b"].sort());
    // The heatmap's band or scale changes: nothing of the last walls shows, the book is read again under the new ones.
    primitive.setRules(other);
    expect(primitive.records).toEqual([]);
    primitive.updateAllViews();
    expect(keys()).toEqual([attack]);
    primitive.detached();
    const saved = new AbsorptionStore(storage);
    expect(saved.load(walls(rules, ROW)).map((entry) => entry.key).sort()).toEqual([attack, "bid:50:4:a", "bid:51:4:b"].sort());
    expect(saved.load(walls(other, ROW)).map((entry) => entry.key)).toEqual([attack]);
    expect(saved.load(rules.instrument)).toEqual([]);
    // Back on the first walls, their set is back; another row width (a lane) is a set of its own.
    const again = new AbsorptionPrimitive(saved);
    again.setSources(grid(ROW));
    again.setRules(rules);
    expect(again.records.map((entry) => entry.key).sort()).toEqual([attack, "bid:50:4:a", "bid:51:4:b"].sort());
    again.setSources(grid(ROW * 2));
    expect(again.records).toEqual([]);
    again.detached();
  });

  it("writes what its store still holds when it is taken off the chart, so the records of its last five seconds are not lost (PR #48 review)", () => {
    const storage = memory();
    const store = new AbsorptionStore(storage);
    const primitive = new AbsorptionPrimitive(store);
    const saved = () => new AbsorptionStore(storage).load(WALLS).map((entry) => entry.key);
    store.add(WALLS, [record({ key: "bid:50:4:a" })], T);
    store.add(WALLS, [record({ key: "bid:51:4:b", band: 51, ts: T + 20_000 })], T + 1_000);
    expect(saved()).toEqual(["bid:50:4:a"]);
    primitive.detached();
    expect(saved()).toEqual(["bid:50:4:a", "bid:51:4:b"]);
  });

  it("writes what its store holds when the page closes or reloads while it is on the chart, and stops listening once taken off", () => {
    const storage = memory();
    const store = new AbsorptionStore(storage);
    const primitive = new AbsorptionPrimitive(store);
    const saved = () => new AbsorptionStore(storage).load(WALLS).map((entry) => entry.key);
    primitive.attached({ chart: {}, series: {}, requestUpdate: () => {} } as never);
    store.add(WALLS, [record({ key: "bid:50:4:a" })], T);
    store.add(WALLS, [record({ key: "bid:51:4:b", band: 51, ts: T + 20_000 })], T + 1_000);
    expect(saved()).toEqual(["bid:50:4:a"]);
    window.dispatchEvent(new Event("pagehide"));
    expect(saved()).toEqual(["bid:50:4:a", "bid:51:4:b"]);
    primitive.detached();
    store.add(WALLS, [record({ key: "bid:52:4:c", band: 52, ts: T + 40_000 })], T + 2_000);
    window.dispatchEvent(new Event("pagehide"));
    expect(saved()).toEqual(["bid:50:4:a", "bid:51:4:b"]);
  });

  it("Show broken levels off hides the hollow spheres, the walls closed through or pulled within the break window, and keeps the prints and the walls that held", () => {
    const H4 = 4 * 3_600_000;
    const C = Math.floor(Date.now() / H4) * H4 - H4;
    const store = new AbsorptionStore(memory());
    store.add(WALLS, [record({ ts: C + 600_000, price: 2600, key: "bid:50:4:a" }), record({ ts: C + 7_200_000, band: 51, price: 2610, key: "bid:51:4:b", endTs: C + 7_260_000, endReason: "closed" })], C + H4);
    const primitive = new AbsorptionPrimitive(store);
    const timeScale = { timeToCoordinate: (time: number) => time === C / 1000 ? 490 : 500, options: () => ({ barSpacing: 10 }), width: () => 1000 };
    const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) };
    const series = { data: () => [{ time: C / 1000, close: 2600 }, { time: C / 1000 + 14_400, close: 2600 }], priceToCoordinate: (price: number) => 500 - price / 10 };
    primitive.attached({ chart, series, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    const grid = { clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: [], columnMs: 1000, deepColumnMs: 10_000, rowWidth: 4, baseAsset: "BTC", levels: [] } as unknown as LiquidityGrid;
    primitive.setSources(grid);
    primitive.setRules(rules);
    primitive.updateAllViews();
    const drawn = () => primitive.bubbles.flatMap((bubble) => bubble.sphere.prints.map((print) => [print.key, print.broken]));
    expect(primitive.prints.map((print) => [print.key, print.broken])).toEqual([["bid:50:4:a", false], ["bid:51:4:b", true]]);
    expect(drawn().sort()).toEqual([["bid:50:4:a", false], ["bid:51:4:b", true]]);
    primitive.setSettings({ opacity: 1, showBroken: false });
    primitive.updateAllViews();
    expect(primitive.prints).toHaveLength(2);
    expect(drawn()).toEqual([["bid:50:4:a", false]]);
    expect(primitive.bubbles.every((bubble) => !bubble.broken)).toBe(true);
    primitive.setSettings({ opacity: 1, showBroken: true });
    primitive.updateAllViews();
    expect(drawn().sort()).toEqual([["bid:50:4:a", false], ["bid:51:4:b", true]]);
    primitive.detached();
  });

  it("reads the live book from the ten-second columns alone: an attack on the one-second tier records nothing, the same attack on the deep tier is recorded and kept", () => {
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40 }];
    const deep = tape(specs, 20);
    const fine = deep.flatMap((column) => Array.from({ length: 10 }, (_, i) => ({ ...col(column.ts + i * 1000, { wall: column.bid[21] * 4 }), sell: i === 0 ? column.sell : [] })));
    const run = (grid: Partial<LiquidityGrid>) => {
      const store = new AbsorptionStore(memory());
      const primitive = new AbsorptionPrimitive(store);
      const timeScale = { timeToCoordinate: () => 490, options: () => ({ barSpacing: 10 }), width: () => 1000 };
      const series = { data: () => [{ time: LIVE_T / 1000, close: 100 }], priceToCoordinate: () => 100 };
      primitive.attached({ chart: { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) }, series, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
      primitive.setSources({ clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: [], columnMs: 1000, deepColumnMs: 10_000, rowWidth: 4, baseAsset: "BTC", referenceSize: 10, ...grid } as unknown as LiquidityGrid);
      primitive.setRules(rules);
      primitive.updateAllViews();
      const prints = primitive.prints;
      const records = primitive.records;
      primitive.detached();
      return { prints, records, kept: store.load(WALLS) };
    };
    expect(run({ columns: fine }).records).toEqual([]);
    const { prints, records, kept } = run({ deepColumns: deep });
    expect(prints.map((entry) => [entry.ts - LIVE_T, entry.absorbed, entry.held])).toEqual([[4 * STEP, 240, true]]);
    expect(records.map((entry) => [entry.ts - LIVE_T, entry.trail.length])).toEqual([[4 * STEP, 1]]);
    expect(kept).toEqual(records);
    // The columns' own level stands; without one the book's reference is the yardstick.
    expect(run({ deepColumns: deep.map((column) => ({ ...column, reference: undefined })), referenceSize: 50 }).records).toEqual([]);
    expect(run({ deepColumns: deep.map((column) => ({ ...column, reference: undefined })), referenceSize: 10 }).records.map((entry) => entry.yardstick)).toEqual([10]);
  });

  it("draws a broken sphere hollow: a solid outline and no fill, where a held one is filled", () => {
    const H1 = 3_600_000;
    const C = Math.floor(Date.now() / H1) * H1 - 4 * H1;
    const store = new AbsorptionStore(memory());
    store.add(WALLS, [record({ ts: C + 600_000, price: 2600, key: "bid:50:4:one" }), record({ ts: C + 900_000, price: 2620, side: "ask", band: 52, key: "ask:52:4:two", endTs: C + 960_000, endReason: "closed" })], C + H1);
    const primitive = new AbsorptionPrimitive(store);
    const timeScale = { timeToCoordinate: (time: number) => (time === C / 1000 ? 490 : 500), options: () => ({ barSpacing: 10 }), width: () => 1000 };
    const series = { data: () => [{ time: C / 1000, close: 2600 }, { time: C / 1000 + 3_600, close: 2600 }], priceToCoordinate: (price: number) => 500 - price / 10 };
    primitive.attached({ chart: { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) }, series, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    primitive.setSources({ clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: [], columnMs: 1000, deepColumnMs: 10_000, rowWidth: 4, baseAsset: "BTC", levels: [] } as unknown as LiquidityGrid);
    primitive.setRules(rules);
    primitive.setSettings({ opacity: 1 });
    primitive.updateAllViews();
    expect(primitive.bubbles.map((bubble) => [bubble.sphere.side, bubble.broken])).toEqual([["bid", false], ["ask", true]]);
    const calls: string[] = [];
    const dashes: number[][] = [];
    const context = {
      save() {}, restore() {}, beginPath() { calls.push("beginPath"); }, closePath() {}, arc() { calls.push("arc"); }, moveTo() {}, lineTo() {}, rect() {},
      fill() { calls.push("fill"); }, stroke() { calls.push("stroke"); }, setLineDash(dash: number[]) { dashes.push(dash); },
      createRadialGradient() { return { addColorStop() {} }; },
      fillStyle: "", strokeStyle: "", lineWidth: 0,
    };
    const target = { useMediaCoordinateSpace: (paint: (scope: unknown) => void) => paint({ context }), useBitmapCoordinateSpace: () => undefined };
    primitive.paneViews()[0].renderer()!.draw(target as never);
    expect(calls).toEqual(["beginPath", "arc", "fill", "stroke", "beginPath", "arc", "stroke"]);
    expect(dashes).toEqual([]);
    primitive.detached();
  });
});

describe("AbsorptionPrimitive with history", () => {
  it("hides a saved sphere older than the history reach, so nothing shows behind History, and brings it back when the reach is lengthened", () => {
    const H1 = 3_600_000;
    const DAY = 24 * H1;
    const C = Math.floor(Date.now() / H1) * H1 - 4 * H1;
    const store = new AbsorptionStore(memory());
    store.add(WALLS, [record({ ts: C - 2 * DAY, price: 2590, key: "bid:49:4:old" }), record({ ts: C - H1 / 2, price: 2600, key: "bid:50:4:new" })], C + H1);
    const primitive = new AbsorptionPrimitive(store);
    const timeScale = { timeToCoordinate: () => 490, options: () => ({ barSpacing: 10 }), width: () => 1000, getVisibleRange: () => ({ from: (C - 4 * H1) / 1000, to: (C + H1) / 1000 }) };
    const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) };
    const series = { data: () => [{ time: C / 1000, close: 2600 }], priceToCoordinate: (price: number) => 500 - price / 10 };
    primitive.attached({ chart, series, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    const deep = [{ ts: C, lo: 0, hi: 1, bid: new Float64Array(2), ask: new Float64Array(2) }];
    primitive.setSources({ clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: deep, columnMs: 1000, deepColumnMs: 10_000, rowWidth: 4, baseAsset: "BTC", levels: [] } as unknown as LiquidityGrid);
    primitive.setRules(rules);
    const history = { records: [], setRules: vi.fn(), subscribe: () => () => undefined, want: () => undefined, covers: () => false, status: () => ({ reachTs: null, inFlight: 0, unavailable: null, loading: false }), dispose: () => undefined } as unknown as AbsorptionHistory;
    primitive.setHistory(history);
    primitive.setSettings({ opacity: 1, historyDays: 1 });
    primitive.updateAllViews();
    expect(primitive.prints.map((entry) => entry.key)).toEqual(["bid:50:4:new"]);
    primitive.setSettings({ opacity: 1, historyDays: 3 });
    primitive.updateAllViews();
    expect(primitive.prints.map((entry) => entry.key)).toEqual(["bid:49:4:old", "bid:50:4:new"]);
    primitive.setSettings({ opacity: 1, historyDays: 1 });
    primitive.updateAllViews();
    primitive.setHistory(null);
    expect(primitive.prints.map((entry) => entry.key)).toEqual(["bid:49:4:old", "bid:50:4:new"]);
    primitive.detached();
  });

  it("never takes a live sphere back: a saved sphere behind the live book stays while the history loads and where the history has read its hour", () => {
    const H1 = 3_600_000;
    const C = Math.floor(Date.now() / H1) * H1 - 4 * H1;
    const store = new AbsorptionStore(memory());
    store.add(WALLS, [record({ ts: C - 3 * H1, price: 2590, key: "bid:49:4:old" }), record({ ts: C - H1 / 2, price: 2600, key: "bid:50:4:new" }), record({ ts: C + H1, price: 2610, key: "bid:51:4:live" })], C + 2 * H1);
    const primitive = new AbsorptionPrimitive(store);
    const timeScale = { timeToCoordinate: () => 490, options: () => ({ barSpacing: 10 }), width: () => 1000, getVisibleRange: () => ({ from: (C - 4 * H1) / 1000, to: (C + H1) / 1000 }) };
    const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) };
    const series = { data: () => [{ time: C / 1000, close: 2600 }], priceToCoordinate: (price: number) => 500 - price / 10 };
    primitive.attached({ chart, series, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    const deep = [{ ts: C, lo: 0, hi: 1, bid: new Float64Array(2), ask: new Float64Array(2) }];
    primitive.setSources({ clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: deep, columnMs: 1000, deepColumnMs: 10_000, rowWidth: 4, baseAsset: "BTC", levels: [] } as unknown as LiquidityGrid);
    primitive.setRules(rules);
    const state = { loading: true, shownFrom: null as number | null, records: [] as AbsorptionRecord[] };
    primitive.setHistory({ get records() { return state.records; }, setRules: vi.fn(), subscribe: () => () => undefined, want: () => undefined, covers: (ts: number) => ts < C, get shownFrom() { return state.shownFrom; }, status: () => ({ reachTs: null, inFlight: 1, unavailable: null, loading: state.loading }), dispose: () => undefined } as unknown as AbsorptionHistory);
    primitive.setSettings({ opacity: 1, historyDays: 1 });
    primitive.updateAllViews();
    expect(primitive.prints.map((entry) => entry.key)).toEqual(["bid:49:4:old", "bid:50:4:new", "bid:51:4:live"]);
    state.loading = false;
    state.shownFrom = C - H1;
    state.records = [record({ ts: C - 3 * H1 + 3 * H1 / 4, attackTs: C - 3 * H1 + 3 * H1 / 4 - 10_000, price: 2595, key: "bid:48:4:history", band: 48 })];
    primitive.updateAllViews();
    expect(primitive.prints.map((entry) => entry.key)).toEqual(["bid:48:4:history", "bid:49:4:old", "bid:50:4:new", "bid:51:4:live"]);
    primitive.detached();
  });

  it("shows the history's sphere once where a saved sphere of the same side and band is the same attack, begun within two minutes of it, and both when the attacks are further apart or on another band", () => {
    // The history reads the whole attack and carries the fuller flow; the live tracker recorded the same attack a column
    // or two apart, and may have read its sphere minutes later in a long attack: the attacks' first columns tell. One
    // sphere, the history's. An attack begun two minutes or more away is another attack.
    const H1 = 3_600_000;
    const C = Math.floor(Date.now() / H1) * H1 - 4 * H1;
    const store = new AbsorptionStore(memory());
    store.add(WALLS, [
      record({ ts: C - 3 * H1 + 5 * 60_000, attackTs: C - 3 * H1, price: 2590, key: "bid:49:4:twin", band: 49, absorbed: 300 }),
      record({ ts: C - 2 * H1, attackTs: C - 2 * H1 - 10_000, price: 2590, key: "bid:49:4:apart", band: 49 }),
      record({ ts: C - H1, attackTs: C - H1 - 10_000, price: 2600, key: "ask:50:4:side", side: "ask", band: 50 }),
      record({ ts: C - H1 / 2, attackTs: C - H1 / 2 - 10_000, price: 2600, key: "bid:51:4:band", band: 51 }),
    ], C + 2 * H1);
    const primitive = new AbsorptionPrimitive(store);
    const timeScale = { timeToCoordinate: () => 490, options: () => ({ barSpacing: 10 }), width: () => 1000, getVisibleRange: () => ({ from: (C - 4 * H1) / 1000, to: (C + H1) / 1000 }) };
    primitive.attached({ chart: { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) }, series: { data: () => [{ time: C / 1000, close: 2600 }], priceToCoordinate: (price: number) => 500 - price / 10 }, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    primitive.setSources({ clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: [{ ts: C, lo: 0, hi: 1, bid: new Float64Array(2), ask: new Float64Array(2) }], columnMs: 1000, deepColumnMs: 10_000, rowWidth: 4, baseAsset: "BTC", levels: [] } as unknown as LiquidityGrid);
    primitive.setRules(rules);
    expect(LIVE_HISTORY_TWIN_MS).toBe(120_000);
    const read = [
      record({ ts: C - 3 * H1 + 70_000, attackTs: C - 3 * H1 + LIVE_HISTORY_TWIN_MS, price: 2595, key: "bid:49:4:history", band: 49, absorbed: 900 }),
      record({ ts: C - 2 * H1 + 10_000, attackTs: C - 2 * H1 - 10_000 + LIVE_HISTORY_TWIN_MS + 1, price: 2595, key: "bid:49:4:later", band: 49 }),
      record({ ts: C - H1, attackTs: C - H1 - 10_000, price: 2600, key: "bid:50:4:other", band: 50 }),
      record({ ts: C - H1 / 2, attackTs: C - H1 / 2 - 10_000, price: 2600, key: "bid:52:4:next", band: 52 }),
    ];
    const history = { records: read, setRules: vi.fn(), subscribe: () => () => undefined, want: () => undefined, covers: (ts: number) => ts < C, shownFrom: C - 4 * H1, status: () => ({ reachTs: C - 4 * H1, inFlight: 0, unavailable: null, loading: false }), dispose: () => undefined } as unknown as AbsorptionHistory;
    primitive.setHistory(history);
    primitive.setSettings({ opacity: 1, historyDays: 1 });
    primitive.updateAllViews();
    expect(primitive.prints.map((entry) => entry.key).sort()).toEqual(["ask:50:4:side", "bid:49:4:apart", "bid:49:4:history", "bid:49:4:later", "bid:50:4:other", "bid:51:4:band", "bid:52:4:next"]);
    expect(primitive.prints.find((entry) => entry.key === "bid:49:4:history")?.absorbed).toBe(900);
    primitive.detached();
  });

  it("shows the history's spheres once each, whatever they rested on, and asks the history for the whole reach behind the live book, whatever the view", () => {
    const H4 = 4 * 3_600_000;
    const C = Math.floor(Date.now() / H4) * H4 - H4;
    const store = new AbsorptionStore(memory());
    store.add(WALLS, [record({ ts: C + 600_000, price: 2600, key: "bid:50:4:a" })], C + H4);
    const primitive = new AbsorptionPrimitive(store);
    const timeScale = { timeToCoordinate: () => 490, options: () => ({ barSpacing: 10 }), width: () => 1000, getVisibleRange: () => ({ from: (C - H4) / 1000, to: (C + H4) / 1000 }) };
    const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) };
    const series = { data: () => [{ time: C / 1000, close: 2600 }, { time: C / 1000 + 14_400, close: 2600 }], priceToCoordinate: (price: number) => 500 - price / 10 };
    primitive.attached({ chart, series, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    const deep = [{ ts: C + 3_600_000, lo: 0, hi: 1, bid: new Float64Array(2), ask: new Float64Array(2) }];
    const grid = { clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: deep, columnMs: 1000, deepColumnMs: 10_000, rowWidth: 4, baseAsset: "BTC", levels: [] } as unknown as LiquidityGrid;
    primitive.setSources(grid);
    primitive.setRules(rules);
    const wants: unknown[][] = [];
    const history = {
      records: [record({ ts: C + 600_000, price: 2600, key: "bid:50:4:a" }), record({ ts: C + 1_200_000, attackTs: C + 1_190_000, band: 52, price: 2610, key: "bid:52:4:h", shown: 100, resting: 100 }), record({ ts: C + 1_800_000, attackTs: C + 1_790_000, band: 53, price: 2620, key: "bid:53:4:i", shown: 100, resting: 100, absorbed: 300 })],
      setRules: vi.fn(),
      subscribe: () => () => undefined,
      want: (...args: unknown[]) => { wants.push(args); },
      covers: () => false,
      status: () => ({ reachTs: C, inFlight: 0, unavailable: null, loading: false }),
      dispose: () => undefined,
    } as unknown as AbsorptionHistory;
    primitive.setHistory(history);
    primitive.updateAllViews();
    expect(primitive.prints.map((entry) => entry.key).sort()).toEqual(["bid:50:4:a", "bid:52:4:h", "bid:53:4:i"]);
    expect(primitive.prints.map((entry) => [entry.key, entry.share, entry.strong]).sort()).toEqual([["bid:50:4:a", 1, false], ["bid:52:4:h", 2, true], ["bid:53:4:i", 2, true]]);
    expect(history.setRules).toHaveBeenLastCalledWith(rules, 4, H4);
    expect(wants).toHaveLength(1);
    const DAY = 24 * 3_600_000;
    expect(wants[0].slice(0, 4)).toEqual([C + 3_600_000 - DAY, C + 3_600_000, C + 3_600_000, DAY]);
    expect(wants[0][4]).toEqual({ columns: deep, columnMs: 10_000 });
    expect(wants[0][5]).toEqual({ closes: [{ ts: C + H4, row: 650 }], intervalMs: H4, fromTs: C });
    primitive.setSettings({ opacity: 1, historyDays: 3 });
    primitive.updateAllViews();
    expect(wants[wants.length - 1].slice(0, 4)).toEqual([C + 3_600_000 - 3 * DAY, C + 3_600_000, C + 3_600_000, 3 * DAY]);
    primitive.setHistory(null);
    expect(primitive.prints.map((entry) => entry.key)).toEqual(["bid:50:4:a"]);
    primitive.detached();
  });

  it("re-reads the saved spheres at once when the rule's numbers change, and asks the history for nothing new: the same want, no new key, a run in flight untouched", () => {
    // The user's slider notch of 2026-10-07: "LOADING 1 DAY" fired again on every tweak. A record of one attack grown
    // from 300 to 500 of a wall of 200; the chart's candles reach back far enough for the history to be asked for the
    // day, and the host never answers, so its run stays in flight through the changes.
    const H1 = 3_600_000;
    const DAY = 24 * H1;
    const C = Math.floor(Date.now() / H1) * H1 - 4 * H1;
    const store = new AbsorptionStore(memory());
    store.add(WALLS, [record({ ts: C + 600_000, attackTs: C + 590_000, price: 2600, key: "bid:50:4:a", shown: 200, resting: 200, absorbed: 500, trail: [{ ts: C + 600_000, absorbed: 300, current: 40, refills: 0 }, { ts: C + 660_000, absorbed: 500, current: 30, refills: 0 }] })], C + H1);
    const primitive = new AbsorptionPrimitive(store);
    const timeScale = { timeToCoordinate: () => 490, options: () => ({ barSpacing: 10 }), width: () => 1000 };
    const bars = [{ time: (C - DAY - 8 * H1) / 1000, close: 2600 }, { time: (C - H1) / 1000, close: 2600 }, { time: C / 1000, close: 2600 }];
    const series = { data: () => bars, priceToCoordinate: (price: number) => 500 - price / 10 };
    primitive.attached({ chart: { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) }, series, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    const deep = [{ ts: C, lo: 0, hi: 1, bid: new Float64Array(2), ask: new Float64Array(2) }];
    primitive.setSources({ clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: deep, columnMs: 1000, deepColumnMs: 10_000, rowWidth: 4, baseAsset: "BTC", levels: [] } as unknown as LiquidityGrid);
    const asked: HistoryRequest[] = [];
    const stream = new ColumnHistoryStream({ request: (request) => { asked.push(request); }, maxPerMinute: 100_000, retryMs: 1 });
    stream.setIdentity({ provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTCUSDT" });
    const history = new AbsorptionHistory(stream);
    const want = vi.spyOn(history, "want");
    primitive.setHistory(history);
    primitive.setRules(rules);
    primitive.setSettings({ opacity: 1, historyDays: 1 });
    primitive.updateAllViews();
    expect([history.running, history.status().loading]).toEqual([true, true]);
    const inFlight = asked.length;
    expect(inFlight).toBeGreaterThan(0);
    const shown = () => primitive.prints.map((entry) => [entry.key, entry.ts - C, entry.share, entry.strong]);
    expect(shown()).toEqual([["bid:50:4:a", 600_000, 2, true]]);
    expect(primitive.bubbles).toHaveLength(1);
    const first = want.mock.calls[0];
    for (const numbers of [{ absorbedPercent: 200, strongPercent: 250 }, { absorbedPercent: 300 }, {}]) {
      primitive.setRules({ ...rules, ...numbers });
      primitive.updateAllViews();
      expect([history.running, history.status().loading, asked.length]).toEqual([true, true, inFlight]);
      expect(want.mock.calls[want.mock.calls.length - 1]).toEqual(first);
    }
    primitive.setRules({ ...rules, absorbedPercent: 200, strongPercent: 250 });
    primitive.updateAllViews();
    expect(shown()).toEqual([["bid:50:4:a", 660_000, 2.5, true]]);
    primitive.setRules({ ...rules, absorbedPercent: 300 });
    primitive.updateAllViews();
    expect([shown(), primitive.bubbles.length]).toEqual([[], 0]);
    primitive.setRules(rules);
    primitive.updateAllViews();
    expect([shown(), primitive.bubbles.length]).toEqual([[["bid:50:4:a", 600_000, 2, true]], 1]);
    expect([history.running, asked.length]).toEqual([true, inFlight]);
    primitive.detached();
  });
});

describe("barCloses", () => {
  it("turns the chart's bars into closes for the band tracker: each closed bar at its end, on the row its close fell in; the open bar is not a close", () => {
    const bars = [{ time: 1_700_000_000, close: 100.2 }, { time: 1_700_000_060, close: 99.9 }, { time: 1_700_000_120, close: 101.7 }];
    expect(barCloses(bars, 0.5)).toEqual([{ ts: 1_700_000_060_000, row: 200 }, { ts: 1_700_000_120_000, row: 199 }]);
    // The interval is the shortest gap among the last bars, so a gap in the data does not stretch every close.
    expect(barCloses([{ time: 1_700_000_000, close: 1 }, { time: 1_700_000_300, close: 1 }, { time: 1_700_000_360, close: 1 }], 1).map((c) => c.ts)).toEqual([1_700_000_060_000, 1_700_000_360_000]);
    expect(barCloses([{ time: 1_700_000_000, close: 1 }], 1)).toEqual([]);
    expect(barCloses(bars, 0)).toEqual([]);
    // A bar without a close (a line series) is skipped.
    expect(barCloses([{ time: 1 }, { time: 61, close: 5 }, { time: 121, close: 6 }], 1)).toEqual([{ ts: 121_000, row: 5 }]);
  });
});

describe("absorptionFillFor", () => {
  it("paints a wall the colour the heatmap paints that side until the trader picks his own", () => {
    expect(absorptionFillFor("bid")).toEqual(parseRgb(DEFAULT_LIQUIDITY_SETTINGS.bidColor, DEFAULT_LIQUIDITY_SETTINGS.bidColor));
    expect(absorptionFillFor("ask")).toEqual(parseRgb(DEFAULT_LIQUIDITY_SETTINGS.askColor, DEFAULT_LIQUIDITY_SETTINGS.askColor));
    expect(absorptionFillFor("bid", { opacity: 1, bidColor: "#ff8800" })).toEqual(parseRgb("#ff8800", "#ff8800"));
    expect(absorptionFillFor("ask", { opacity: 1, bidColor: "#ff8800" })).toEqual(parseRgb(DEFAULT_LIQUIDITY_SETTINGS.askColor, DEFAULT_LIQUIDITY_SETTINGS.askColor));
  });
});

describe("the shape of the marks", () => {
  function drawn(shape: "circle" | "triangle" | "square" | undefined) {
    const H1 = 3_600_000;
    const C = Math.floor(Date.now() / H1) * H1 - 4 * H1;
    const store = new AbsorptionStore(memory());
    store.add(WALLS, [record({ ts: C + 600_000, price: 2600, key: "bid:50:4:one" }), record({ ts: C + 900_000, price: 2620, side: "ask", band: 52, key: "ask:52:4:two" })], C + H1);
    const primitive = new AbsorptionPrimitive(store);
    const timeScale = { timeToCoordinate: (time: number) => (time === C / 1000 ? 490 : 500), options: () => ({ barSpacing: 10 }), width: () => 1000 };
    const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) };
    const series = { data: () => [{ time: C / 1000, close: 2600 }, { time: C / 1000 + 3_600, close: 2600 }], priceToCoordinate: (price: number) => 500 - price / 10 };
    primitive.attached({ chart, series, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    const deep = [{ ts: C, lo: 0, hi: 1, bid: new Float64Array(2), ask: new Float64Array(2) }];
    primitive.setSources({ clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: deep, columnMs: 1000, deepColumnMs: 10_000, rowWidth: 4, baseAsset: "BTC", levels: [] } as unknown as LiquidityGrid);
    primitive.setRules(rules);
    primitive.setSettings(shape === undefined ? { opacity: 1 } : { opacity: 1, shape });
    primitive.updateAllViews();
    expect(primitive.bubbles.length).toBe(2);
    const calls: string[] = [];
    const points: [number, number][] = [];
    const context = {
      save() {}, restore() {}, beginPath() { calls.push("beginPath"); }, closePath() { calls.push("closePath"); },
      arc(x: number, y: number, r: number) { calls.push("arc"); points.push([x, y]); void r; },
      moveTo(x: number, y: number) { calls.push("moveTo"); points.push([x, y]); },
      lineTo(x: number, y: number) { calls.push("lineTo"); points.push([x, y]); },
      rect(x: number, y: number, w: number, h: number) { calls.push("rect"); points.push([x, y], [x + w, y + h]); },
      fill() { calls.push("fill"); }, stroke() { calls.push("stroke"); }, setLineDash() {},
      createRadialGradient() { return { addColorStop() {} }; },
      fillStyle: "", strokeStyle: "", lineWidth: 0,
    };
    const target = { useMediaCoordinateSpace: (paint: (scope: unknown) => void) => paint({ context }), useBitmapCoordinateSpace: () => undefined };
    primitive.paneViews()[0].renderer()!.draw(target as never);
    const bubbles = primitive.bubbles;
    primitive.detached();
    return { calls, points, bubbles };
  }

  it("draws circles unless told otherwise, one arc a mark", () => {
    for (const shape of [undefined, "circle" as const]) {
      const { calls } = drawn(shape);
      expect(calls.filter((call) => call === "arc")).toHaveLength(2);
      expect(calls.filter((call) => call === "lineTo" || call === "rect")).toHaveLength(0);
      expect(calls.filter((call) => call === "fill")).toHaveLength(2);
    }
  });

  it("draws triangles the size of the mark, a bid wall's pointing up and an ask wall's pointing down", () => {
    const { calls, points, bubbles } = drawn("triangle");
    expect(calls.filter((call) => call === "arc" || call === "rect")).toHaveLength(0);
    expect(calls.filter((call) => call === "moveTo")).toHaveLength(2);
    expect(calls.filter((call) => call === "lineTo")).toHaveLength(4);
    expect(calls.filter((call) => call === "closePath")).toHaveLength(2);
    expect(bubbles.map((bubble) => bubble.sphere.side).sort()).toEqual(["ask", "bid"]);
    bubbles.forEach((bubble, i) => {
      const corners = points.slice(3 * i, 3 * i + 3);
      const up = bubble.sphere.side === "bid";
      expect(up ? Math.min(...corners.map(([, y]) => y)) : Math.max(...corners.map(([, y]) => y))).toBeCloseTo(up ? bubble.y - bubble.r : bubble.y + bubble.r);
      expect(corners.filter(([, y]) => (up ? y > bubble.y : y < bubble.y))).toHaveLength(2);
      for (const [x] of corners) expect(Math.abs(x - bubble.x)).toBeLessThanOrEqual(bubble.r + 1e-9);
    });
  });

  it("draws squares the size of the mark, centred on it", () => {
    const { calls, points, bubbles } = drawn("square");
    expect(calls.filter((call) => call === "arc" || call === "lineTo")).toHaveLength(0);
    expect(calls.filter((call) => call === "rect")).toHaveLength(2);
    const [bid] = bubbles;
    expect(points[0][0]).toBeCloseTo(bid.x - bid.r);
    expect(points[0][1]).toBeCloseTo(bid.y - bid.r);
    expect(points[1][0]).toBeCloseTo(bid.x + bid.r);
    expect(points[1][1]).toBeCloseTo(bid.y + bid.r);
  });
});

describe("history switched off (PR #47 review)", () => {
  it("stops the history and asks it for nothing, draws none of its spheres nor a badge, shows a saved sphere only from the live book on, and asks again once switched back on", () => {
    const H1 = 3_600_000;
    const C = Math.floor(Date.now() / H1) * H1 - 4 * H1;
    const store = new AbsorptionStore(memory());
    store.add(WALLS, [record({ ts: C - 3 * H1, price: 2590, key: "bid:49:4:old" }), record({ ts: C + 600_000, price: 2600, key: "bid:50:4:new" })], C + H1);
    const primitive = new AbsorptionPrimitive(store);
    const timeScale = { timeToCoordinate: () => 490, options: () => ({ barSpacing: 10 }), width: () => 1000, getVisibleRange: () => ({ from: (C - 4 * H1) / 1000, to: (C + H1) / 1000 }) };
    const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) };
    const series = { data: () => [{ time: C / 1000, close: 2600 }, { time: C / 1000 + 3_600, close: 2600 }], priceToCoordinate: (price: number) => 500 - price / 10 };
    primitive.attached({ chart, series, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    const deep = [{ ts: C, lo: 0, hi: 1, bid: new Float64Array(2), ask: new Float64Array(2) }];
    primitive.setSources({ clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns: deep, columnMs: 1000, deepColumnMs: 10_000, rowWidth: 4, baseAsset: "BTC", levels: [] } as unknown as LiquidityGrid);
    primitive.setRules(rules);
    const wants: unknown[] = [];
    const setRules = vi.fn();
    primitive.setHistory({ records: [record({ ts: C - 2 * H1, price: 2600, key: "bid:50:4:h" })], setRules, subscribe: () => () => undefined, want: (...args: unknown[]) => { wants.push(args); }, covers: () => true, shownFrom: C - 3 * H1, status: () => ({ reachTs: C - 3 * H1, inFlight: 1, unavailable: null, loading: true }), dispose: () => undefined } as unknown as AbsorptionHistory);
    primitive.setSettings({ opacity: 1, historyDays: 0 });
    primitive.updateAllViews();
    expect(wants).toEqual([]);
    expect(setRules.mock.lastCall?.[0]).toBeNull();
    expect(primitive.prints.map((entry) => entry.key)).toEqual(["bid:50:4:new"]);
    expect(absorptionStatusText({ reachTs: null, inFlight: 1, unavailable: null, loading: true }, 0)).toBeNull();
    const texts: string[] = [];
    const context = { save() {}, restore() {}, fillRect() {}, fillText(text: string) { texts.push(text); }, fillStyle: "", font: "", textAlign: "left", textBaseline: "middle" };
    const target = { useMediaCoordinateSpace: (paint: (scope: unknown) => void) => paint({ context }), useBitmapCoordinateSpace: () => undefined };
    primitive.paneViews().at(-1)?.renderer()?.draw(target as never);
    expect(texts).toEqual([]);
    primitive.setSettings({ opacity: 1, historyDays: 1 });
    primitive.updateAllViews();
    expect(wants).toHaveLength(1);
    expect(setRules.mock.lastCall?.[0]).toEqual(rules);
    primitive.detached();
  });
});

describe("the absorption status badge", () => {
  it("names the reach while the history loads, says so when the host refuses it, and shows nothing once it is drawn", () => {
    expect(absorptionStatusText(null, 1)).toBeNull();
    expect(absorptionStatusText({ reachTs: null, inFlight: 1, unavailable: null, loading: true }, 1)).toBe("PRIME ABSORPTION · LOADING 1 DAY");
    expect(absorptionStatusText({ reachTs: null, inFlight: 1, unavailable: null, loading: true }, 7)).toBe("PRIME ABSORPTION · LOADING 1 WEEK");
    expect(absorptionStatusText({ reachTs: null, inFlight: 0, unavailable: "NO_PYRAMID", loading: false }, 3)).toBe("PRIME ABSORPTION · HISTORY UNAVAILABLE");
    expect(absorptionStatusText({ reachTs: 1, inFlight: 0, unavailable: null, loading: false }, 3)).toBeNull();
  });

  it("is drawn in the absorption slot while the history loads", () => {
    const primitive = new AbsorptionPrimitive(new AbsorptionStore({ getItem() { return null; }, setItem() {} }));
    let loading = true;
    primitive.setHistory({ records: [], setRules: () => undefined, subscribe: () => () => undefined, want: () => undefined, covers: () => false, status: () => ({ reachTs: null, inFlight: 1, unavailable: null, loading }), dispose: () => undefined } as unknown as AbsorptionHistory);
    const texts: string[] = [];
    const context = { save() {}, restore() {}, fillRect() {}, fillText(text: string) { texts.push(text); }, fillStyle: "", font: "", textAlign: "left", textBaseline: "middle" };
    const target = { useMediaCoordinateSpace: (paint: (scope: unknown) => void) => paint({ context }), useBitmapCoordinateSpace: () => undefined };
    const draw = () => { for (const view of primitive.paneViews()) view.renderer()?.draw(target as never); };
    draw();
    expect(texts).toEqual(["PRIME ABSORPTION · LOADING 1 DAY"]);
    loading = false;
    texts.length = 0;
    draw();
    expect(texts).toEqual([]);
  });
});

describe("AbsorptionPrimitive on a historical (DATABENTO) grid (PR #48 review)", () => {
  // #50's historical L2 on the chart: a window of the archive handed over as a DATABENTO grid, its book whole in its own
  // feed (the fixture's ten-second columns here) with no deep tier, its clock the second after the window's last column.
  // The window is of 2026-08-12 and holds the engine's first attack, 240 sold into a wall of 200, recorded at its fifth
  // column. The live book and the browser's saved spheres sit an hour back, where the fixture keeps them.
  const AUG = Date.UTC(2026, 7, 12, 14, 30);
  const ATTACK: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 160 }, { wall: 20, sell: 80 }, { wall: 20 }];
  const august = (count: number) => Array.from({ length: count }, (_, i) => col(AUG + i * STEP, ATTACK[Math.min(i, ATTACK.length - 1)]));
  const attackFrom = (start: number) => `bid:${BAND}:4:${start + 3 * STEP}`;
  const keys = (records: readonly AbsorptionRecord[]) => records.map((entry) => entry.key);
  const NQ = JSON.stringify(["XCME", "FUTURE", "NQU6", "USD", "CONTRACT"]);
  // The grid's own book (`book`) is what its source shows: the feed's columns unless a test says otherwise. `deep` puts
  // the feed's columns in a deep tier.
  const databento = (columns: LiquidityColumn[], columnMs = STEP, { book = columns, deep = false } = {}): LiquidityGrid => {
    const tier = { columns, columnMs };
    const feed: ColumnFeed = deep ? { epoch: 1, deep: tier, fine: { columns: [], columnMs: 1_000 } } : { epoch: 1, deep: null, fine: tier };
    const lastTs = columns[columns.length - 1].ts;
    const source: IndicatorL2 = { ...historicalL2(), availability: "HISTORICAL", version: 1, trusted: () => true, status: () => ({ synced: true, seq: null, lastTs, lastFrameAt: null }), view: () => ({ epoch: 1, deep: null, fine: { columns: book, columnMs } }) };
    return new HistoricalLiquidityGrid({ feed, rowWidth: ROW, baseAsset: "contracts", version: 1 }, source, NQ);
  };
  const bare = ({ reference: _reference, ...column }: LiquidityColumn): LiquidityColumn => column;
  // The attack above as #50 hands it over: each ten seconds of it ten one-second columns, its print in the first, with
  // no level of their own.
  const oneSecond = (count: number) => Array.from({ length: count }, (_, i) => {
    const spec = ATTACK[Math.min(Math.floor(i / 10), ATTACK.length - 1)];
    return bare(col(AUG + i * 1_000, i % 10 === 0 ? spec : { ...spec, sell: 0 }));
  });
  // The grid's level for a ten-second window: the largest of its seconds', what the ten-second fold keeps.
  const levelAt = (grid: LiquidityGrid, windowTs: number) => Math.max(...grid.columns.filter((column) => column.ts >= windowTs && column.ts < windowTs + STEP).map((column) => column.reference ?? 0));
  const live = (deepColumns: LiquidityColumn[] = []) => ({ provider: "BINANCE", historicalFeed: null, clockMs: () => Date.now(), epoch: 1, columns: [], deepColumns, columnMs: 1000, deepColumnMs: STEP, rowWidth: ROW, baseAsset: "BTC", referenceSize: 10, levels: [] }) as unknown as LiquidityGrid;
  const attach = (primitive: AbsorptionPrimitive, barMs: number): AbsorptionPrimitive => {
    const timeScale = { timeToCoordinate: () => 490, options: () => ({ barSpacing: 10 }), width: () => 1000 };
    primitive.attached({ chart: { timeScale: () => timeScale, paneSize: () => ({ height: 500 }) }, series: { data: () => [{ time: barMs / 1000, close: 100 }], priceToCoordinate: () => 100 }, requestUpdate: () => {} } as unknown as Parameters<AbsorptionPrimitive["attached"]>[0]);
    return primitive;
  };
  // A browser that read the same attack live an hour ago: its record saved under the instrument, as a live chart leaves it.
  const saved = () => {
    const storage = memory();
    const store = new AbsorptionStore(storage);
    store.add(WALLS, detectAbsorption(feedOf(tape(ATTACK)), ROW, rules, Date.now()), Date.now());
    expect(keys(store.load(WALLS))).toEqual([attackFrom(LIVE_T)]);
    return { storage, store };
  };

  it("never loads the browser's saved spheres onto a DATABENTO grid nor saves its own there: none of the instrument's saved spheres shows, the store is never written, and a live chart of the instrument loads only what it had", () => {
    const { storage, store } = saved();
    const before = storage.items.get(ABSORPTION_STORAGE_KEY);
    const setItem = vi.spyOn(storage, "setItem");
    const primitive = attach(new AbsorptionPrimitive(store), AUG);
    primitive.setSources(databento(august(6)));
    primitive.setRules(rules);
    expect(primitive.records).toEqual([]);
    primitive.updateAllViews();
    expect(keys(primitive.records)).toEqual([attackFrom(AUG)]);
    expect(primitive.bubbles).toHaveLength(1);
    expect(setItem).not.toHaveBeenCalled();
    expect(storage.items.get(ABSORPTION_STORAGE_KEY)).toBe(before);
    primitive.detached();
    const other = attach(new AbsorptionPrimitive(store), LIVE_T);
    other.setSources(live());
    other.setRules(rules);
    expect(keys(other.records)).toEqual([attackFrom(LIVE_T)]);
    other.updateAllViews();
    expect(keys(other.records)).toEqual([attackFrom(LIVE_T)]);
    other.detached();
  });

  it("reads a DATABENTO grid's own book at the grid's own clock, a day of the archive in August and not the wall clock, draws what it finds there, and reads a live grid set after it at once, the historical spheres gone with it", () => {
    const { store } = saved();
    const update = vi.spyOn(AbsorptionTracker.prototype, "update");
    vi.useFakeTimers();
    try {
      const grid = databento(august(6));
      expect(grid.clockMs()).toBe(AUG + 5 * STEP + 1_000);
      const primitive = attach(new AbsorptionPrimitive(store), AUG);
      primitive.setSources(grid);
      primitive.setRules(rules);
      primitive.updateAllViews();
      expect(update.mock.calls.map((call) => call[3])).toEqual([AUG + 5 * STEP + 1_000]);
      expect(keys(primitive.records)).toEqual([attackFrom(AUG)]);
      expect(primitive.bubbles).toHaveLength(1);
      primitive.setSources(live());
      primitive.updateAllViews();
      expect(update.mock.calls.map((call) => call[3])).toEqual([AUG + 5 * STEP + 1_000, Date.now()]);
      expect(keys(primitive.records)).toEqual([attackFrom(LIVE_T)]);
      primitive.detached();
    } finally {
      vi.useRealTimers();
      update.mockRestore();
    }
  });

  it("reads every change of a DATABENTO grid on the next paint, its clock standing at the window's last second, where a live grid waits out its quarter second", () => {
    vi.useFakeTimers();
    try {
      const columns = august(5);
      const shown = columns.slice(0, 4);
      const grid = databento(shown);
      const historical = attach(new AbsorptionPrimitive(new AbsorptionStore(memory())), AUG);
      historical.setSources(grid);
      historical.setRules(rules);
      historical.updateAllViews();
      expect(historical.records).toEqual([]);
      shown.push(columns[4]);
      historical.refresh();
      historical.updateAllViews();
      expect(grid.clockMs()).toBe(AUG + 3 * STEP + 1_000);
      expect(keys(historical.records)).toEqual([attackFrom(AUG)]);
      expect(historical.bubbles).toHaveLength(1);
      historical.detached();
      const book = tape(ATTACK, 5);
      const deep = book.slice(0, 4);
      const primitive = attach(new AbsorptionPrimitive(new AbsorptionStore(memory())), LIVE_T);
      primitive.setSources(live(deep));
      primitive.setRules(rules);
      primitive.updateAllViews();
      expect(primitive.records).toEqual([]);
      deep.push(book[4]);
      primitive.refresh();
      primitive.updateAllViews();
      expect(primitive.records).toEqual([]);
      vi.advanceTimersByTime(250);
      primitive.updateAllViews();
      expect(keys(primitive.records)).toEqual([attackFrom(LIVE_T)]);
      primitive.detached();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads #50's own book, one-second columns with no level of their own, each second at the grid's level for it: the attack's yardstick is the largest level of its first-hit ten seconds, not the grid's level at the window's last second (PR #48 review)", () => {
    // No attack opens on a level of 0, and #50's columns carry none: each second is read at the level the grid colours
    // it by, and the ten-second fold keeps the largest of its seconds'. The first hit is in the window at 30 s.
    const grid = databento(oneSecond(60), 1_000);
    expect(grid.historicalFeed?.reference).toBeUndefined();
    expect(grid.referenceSize).toBeGreaterThan(0);
    const level = levelAt(grid, AUG + 3 * STEP);
    expect(level).not.toBe(grid.referenceSize);
    const primitive = attach(new AbsorptionPrimitive(new AbsorptionStore(memory())), AUG);
    primitive.setSources(grid);
    primitive.setRules(rules);
    primitive.updateAllViews();
    expect(keys(primitive.records)).toEqual([attackFrom(AUG)]);
    expect(primitive.records[0].yardstick).toBe(level);
    expect(primitive.bubbles).toHaveLength(1);
    primitive.detached();
  });

  it("records the same sphere for an attack of #50's book whether the window ends a minute after it or runs ten minutes on into a thicker book: the same key and the grid's level where the attack was as its yardstick (PR #48 review)", () => {
    // #50's own builders make the book and the grid, as the chart gets them. From the second minute on the band stays
    // at 20 and fifteen ask rows of 120 thicken the book away from it, so the grid's level at the window's end climbs.
    const archive = (count: number): HistoricalBookSecond[] => oneSecond(count).map((column, i) => {
      if (i >= 60) for (let row = 26; row <= 40; row += 1) column.ask[row - column.lo] = 120;
      const close = String(BigInt(column.ts + 1_000) * 1_000_000n);
      return { openNs: String(BigInt(column.ts) * 1_000_000n), closeNs: close, knownNs: close, knownKey: null, segmentId: "a".repeat(64), complete: true, trusted: true, reason: "OBSERVED_PREFIX", flow: { BUY: 0, SELL: 0, UNKNOWN: 0, count: 0 }, column };
    });
    const read = (count: number) => {
      const seconds = archive(count);
      const grid = new HistoricalLiquidityGrid(historicalBookLiquidity(seconds, 0.25, 1, "contracts"), historicalBookL2(seconds, 0.25, 1), NQ);
      const primitive = attach(new AbsorptionPrimitive(new AbsorptionStore(memory())), AUG);
      primitive.setSources(grid);
      primitive.setRules(rules);
      primitive.updateAllViews();
      const seen = { level: levelAt(grid, AUG + 3 * STEP), end: grid.referenceSize, records: primitive.records.map(({ key, yardstick }) => ({ key, yardstick })), spheres: primitive.bubbles.length };
      primitive.detached();
      return seen;
    };
    const short = read(60);
    const long = read(660);
    expect(long.end).toBeGreaterThan(5 * short.end);
    expect(long.level).toBe(short.level);
    expect(short.records).toEqual([{ key: attackFrom(AUG), yardstick: short.level }]);
    expect(long.records).toEqual(short.records);
    expect([short.spheres, long.spheres]).toEqual([1, 1]);
  });

  it("hands a second the grid holds no column for over as it is: with no level of its own no attack opens on it, and the grid's level at the window's end never stands in (PR #48 review)", () => {
    // The grid's own book holds only the window's last ten seconds, after the attack.
    const seconds = oneSecond(60);
    const grid = databento(seconds, 1_000, { book: seconds.slice(50) });
    expect(grid.referenceSize).toBeGreaterThan(0);
    const update = vi.spyOn(AbsorptionTracker.prototype, "update");
    try {
      const primitive = attach(new AbsorptionPrimitive(new AbsorptionStore(memory())), AUG);
      primitive.setSources(grid);
      primitive.setRules(rules);
      primitive.updateAllViews();
      const [feed] = update.mock.calls[0];
      expect(feed.reference).toBeUndefined();
      for (let i = 0; i < 50; i += 1) expect(feed.fine.columns[i]).toBe(seconds[i]);
      expect(feed.fine.columns.slice(50).map((column) => column.reference)).toEqual(grid.columns.map((column) => column.reference));
      expect(primitive.records).toEqual([]);
      expect(primitive.bubbles).toEqual([]);
      primitive.detached();
    } finally {
      update.mockRestore();
    }
  });

  it("reads each second of #50's book as the grid's own column, its median with its level, so the walls are the ones the archive heatmap paints (PR #48 review)", () => {
    // An index book's wall floor reads a column's median first and half its level only without one; #50's columns carry
    // neither, the grid's carry both.
    const grid = databento(oneSecond(60), 1_000);
    expect(grid.columns.every((column) => (column.median ?? 0) > 0 && column.median !== (column.reference ?? 0) / 2)).toBe(true);
    const update = vi.spyOn(AbsorptionTracker.prototype, "update");
    try {
      const primitive = attach(new AbsorptionPrimitive(new AbsorptionStore(memory())), AUG);
      primitive.setSources(grid);
      primitive.setRules(rules);
      primitive.updateAllViews();
      const [feed] = update.mock.calls[0];
      expect(feed.fine.columns).toHaveLength(grid.columns.length);
      feed.fine.columns.forEach((column, i) => expect(column).toBe(grid.columns[i]));
      primitive.detached();
    } finally {
      update.mockRestore();
    }
  });

  it("reads a deep tier of a DATABENTO feed at the grid's levels too (PR #48 review)", () => {
    // The attack in ten-second columns of a deep tier, with no level of their own; the grid's book holds the same columns.
    const grid = databento(august(6).map(bare), STEP, { deep: true });
    const level = levelAt(grid, AUG + 3 * STEP);
    expect(level).not.toBe(grid.referenceSize);
    const primitive = attach(new AbsorptionPrimitive(new AbsorptionStore(memory())), AUG);
    primitive.setSources(grid);
    primitive.setRules(rules);
    primitive.updateAllViews();
    expect(keys(primitive.records)).toEqual([attackFrom(AUG)]);
    expect(primitive.records[0].yardstick).toBe(level);
    primitive.detached();
  });

  it("drops what a live grid had kept the moment a DATABENTO grid is set, before it is ever painted, and reads a live grid set straight back at once, its quarter second started afresh", () => {
    const { store } = saved();
    const update = vi.spyOn(AbsorptionTracker.prototype, "update");
    vi.useFakeTimers();
    try {
      const grid = live();
      const primitive = attach(new AbsorptionPrimitive(store), LIVE_T);
      primitive.setSources(grid);
      primitive.setRules(rules);
      primitive.updateAllViews();
      expect(keys(primitive.records)).toEqual([attackFrom(LIVE_T)]);
      primitive.setSources(databento(august(6)));
      expect(primitive.records).toEqual([]);
      primitive.setSources(grid);
      primitive.updateAllViews();
      expect(keys(primitive.records)).toEqual([attackFrom(LIVE_T)]);
      expect(update).toHaveBeenCalledTimes(2);
      primitive.detached();
    } finally {
      vi.useRealTimers();
      update.mockRestore();
    }
  });
});
