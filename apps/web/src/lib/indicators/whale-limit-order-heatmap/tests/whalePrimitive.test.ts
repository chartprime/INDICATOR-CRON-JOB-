// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeriesAttachedParameter, Time } from "lightweight-charts";
import type { IndicatorL2 } from "../../../chart/indicatorL2";
import { STATUS_BADGE_SLOT, statusBadgeBox } from "../../../chart/statusBadge";
import type { HostWallPage } from "../../../l2/hostWalls";
import type { L2Wall } from "../../../l2/types";
import { WHALE_WALL_CHUNK_MS, WallHistoryStream, type WallHistoryRequest } from "../../../l2/wallHistoryStream";
import { WHALE_LADDER_MAX_PX, WHALE_NOW_GAP_PX, WHALE_REBUILD_MS, WHALE_STATUS_UNSUPPORTED, WHALE_STATUS_UNTRUSTED, WhaleLimitHeatmapPrimitive } from "../whalePrimitive";
import { bandAlpha, bandColor, bandThickness } from "../whaleGeometry";
import { heatOf } from "../wallStore";
import type { WhaleSettings } from "../whaleSettings";

const NOW = 1_790_000_040_000;
const MINUTE = 60_000;
const OPENS = Array.from({ length: 600 }, (_, index) => NOW - (599 - index) * MINUTE);
const BANDS = { n: 100, p50: 8_288_082, p75: 12_479_940, p90: 18_797_056, p95: 24_243_910, p99: 40_272_960 };
const ID = { provider: "BINANCE" as const, marketKind: "PERPETUAL", symbol: "BTC-USDT" };
const SIZE = { width: 1400, height: 600 };
const yOf = (price: number) => 300 - (price - 80_000) * 0.5;

type Op = [string, ...unknown[]];

function recorder() {
  const ops: Op[] = [];
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, font: "", textAlign: "left", textBaseline: "alphabetic" };
  const context = {
    ...state,
    save() { ops.push(["save"]); },
    restore() { ops.push(["restore"]); },
    beginPath() { ops.push(["beginPath"]); },
    closePath() { ops.push(["closePath"]); },
    rect(...a: number[]) { ops.push(["rect", ...a]); },
    clip() { ops.push(["clip"]); },
    moveTo(...a: number[]) { ops.push(["moveTo", ...a]); },
    lineTo(...a: number[]) { ops.push(["lineTo", ...a]); },
    stroke() { ops.push(["stroke"]); },
    fill() { ops.push(["fill"]); },
    arc(...a: number[]) { ops.push(["arc", ...a]); },
    setLineDash(a: number[]) { ops.push(["dash", a.length]); },
    createLinearGradient() { return { addColorStop(offset: number, color: string) { ops.push(["stop", offset, color]); } }; },
    measureText(text: string) { return { width: text.length * 6 }; },
    fillRect(this: { fillStyle: unknown }, ...a: number[]) { ops.push(["fillRect", this.fillStyle, ...a]); },
    strokeRect(this: { lineWidth: number; strokeStyle: unknown }, ...a: number[]) { ops.push(["strokeRect", ...a]); ops.push(["outline", this.lineWidth, this.strokeStyle]); },
    fillText(this: { fillStyle: unknown; textAlign: unknown }, text: string, x: number, y: number) { ops.push(["fillText", this.fillStyle, text, x, y, this.textAlign]); },
  };
  return { context: context as unknown as CanvasRenderingContext2D, ops };
}

function chartAndSeries(lastCenterX = 1000) {
  const options = { barSpacing: 10, rightOffset: 0 };
  const applied: { rightOffset?: number }[] = [];
  const view = { lastCenterX };
  const chart = {
    timeScale: () => ({
      timeToIndex: () => 599,
      logicalToCoordinate: () => view.lastCenterX,
      options: () => options,
      width: () => SIZE.width,
      scrollPosition: () => 0,
      getVisibleLogicalRange: () => null,
      setVisibleLogicalRange: () => undefined,
      applyOptions: (next: { rightOffset?: number }) => {
        applied.push(next);
        if (next.rightOffset !== undefined) options.rightOffset = next.rightOffset;
      },
    }),
  };
  const series = { data: () => [], priceToCoordinate: (price: number) => yOf(price) };
  return { chart, series, applied, view, options };
}

function wall(over: Partial<L2Wall> = {}): L2Wall {
  return { id: 1, lane: 0, side: "bid", row: 19_900, span: 2, startTs: NOW - 50 * MINUTE, endTs: NOW - 45 * MINUTE, size: 0, peak: 1, endedBy: "filled", ratio: 3, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null, ...over };
}

const FILLED = wall();
const PULLED_ASK = wall({ id: 2, side: "ask", row: 20_100, span: 1, peak: 300, startTs: NOW - 30 * MINUTE, endTs: NOW - 10 * MINUTE, endedBy: "pulled" });
const STANDING_ASK = wall({ id: 3, side: "ask", row: 20_125, span: 1, peak: 500, startTs: NOW - 120 * MINUTE, endTs: null, endedBy: null });
const STANDING_BID = wall({ id: 4, side: "bid", row: 19_950, span: 1, peak: 300, startTs: NOW - 30 * MINUTE, endTs: null, endedBy: null });

function page(walls: L2Wall[], extra: Partial<Extract<HostWallPage, { available: true }>> = {}): Extract<HostWallPage, { available: true }> {
  return { available: true, generation: "g", rowWidth: 4, walls, next: null, ...extra };
}

function liveL2(over: { walls?: L2Wall[]; synced?: boolean; segment?: "LIVE" | "GAP"; version?: number; availability?: "LIVE" | "HISTORICAL_UNAVAILABLE"; rowWidth?: number } = {}) {
  const state = { walls: over.walls ?? [STANDING_ASK, STANDING_BID], synced: over.synced ?? true, segment: over.segment ?? "LIVE", version: over.version ?? 1, availability: over.availability ?? "LIVE", rowWidth: over.rowWidth ?? 4, wallCalls: 0 };
  const l2 = {
    get availability() { return state.availability; },
    get version() { return state.version; },
    status: () => ({ synced: state.synced, seq: 1, lastTs: NOW, lastFrameAt: NOW }),
    segment: () => ({ id: "seg", state: state.segment }),
    lanes: () => [{ lane: 0, rowWidth: state.rowWidth, columnMs: 1_000, deepColumnMs: 10_000, priceLo: 0, priceHi: 1 }],
    walls: () => { state.wallCalls += 1; return state.walls; },
    ladder: () => ({ ts: NOW, depth: 1, bids: [[79_900, 1]], asks: [[80_100, 1]] }),
  } as unknown as IndicatorL2;
  return { l2, state };
}

function setup(options: { clock?: { now: number }; stream?: boolean; identity?: boolean } = {}) {
  const clock = options.clock ?? { now: NOW };
  const requests: WallHistoryRequest[] = [];
  const stream = new WallHistoryStream({ request: (request) => requests.push(request), chunkMs: WHALE_WALL_CHUNK_MS });
  stream.setIdentity(ID);
  const fake = chartAndSeries();
  const update = vi.fn();
  const primitive = new WhaleLimitHeatmapPrimitive(() => MINUTE, () => ({ revision: 1, opensMs: OPENS }), () => clock.now);
  primitive.attached({ chart: fake.chart, series: fake.series, requestUpdate: update } as unknown as SeriesAttachedParameter<Time>);
  if (options.identity !== false) primitive.setIdentity(ID.marketKind, ID.symbol);
  if (options.stream !== false) primitive.setStream(stream);
  return { primitive, stream, requests, fake, update, clock };
}

function land(setupResult: ReturnType<typeof setup>, walls: L2Wall[], extra: Partial<Extract<HostWallPage, { available: true }>> = {}, advance: number = WHALE_REBUILD_MS + 1) {
  const request = setupResult.requests.at(-1);
  if (request === undefined) throw new Error("no request to answer");
  setupResult.clock.now += advance;
  setupResult.stream.accept(request.requestId, page(walls, extra));
}

const STRIP = "#e9e5d8";
const BADGE = "rgba(20, 20, 30, 0.86)";
const LABEL = / · \d+(\.\d)? (s|min|h)$/;

function fillRects(ops: Op[]) {
  return ops.filter((op) => op[0] === "fillRect") as [string, string, number, number, number, number][];
}

function bandRects(ops: Op[]) {
  return fillRects(ops).filter((rect) => rect[1] !== STRIP && rect[1] !== BADGE);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("whale heatmap primitive: what it asks for, builds and draws", () => {
  it("asks the stream for its window and the dollar cut of the chosen preset once it knows the market, and again when the cut changes", () => {
    const { primitive, requests } = setup();
    primitive.updateAllViews();
    expect(requests).toHaveLength(2);
    // The host is asked from 80% of the p90 cut, so the walls the cut shows are held with room below it.
    expect(requests[0].filter).toEqual({ minUsd: 15_037_644, alwaysOutcomes: ["filled", "partial"] });
    expect(requests[0].toTs).toBe(NOW + 60_000);
    expect(NOW + 60_000 - requests.at(-1)!.fromTs).toBeLessThanOrEqual(0.5 * 43_200_000 + 60_000 + 2 * 43_200_000);
    expect(primitive.bands()).toMatchObject({ p90: expect.any(Number) });
    // p95 is still covered by what was asked for: nothing is asked again.
    let count = requests.length;
    primitive.setSettings({ ...primitive.settings, cutPreset: 3 });
    primitive.updateAllViews();
    expect(requests).toHaveLength(count);
    // p99 is more than twice what was asked for: asking again from its own 80% saves the host's pages.
    primitive.setSettings({ ...primitive.settings, cutPreset: 4 });
    primitive.updateAllViews();
    expect(requests.at(-1)!.filter).toEqual({ minUsd: 32_218_368, alwaysOutcomes: ["filled", "partial"] });
    // p75 falls below what was asked for: the walls between are missing, so it asks again.
    count = requests.length;
    primitive.setSettings({ ...primitive.settings, cutPreset: 1 });
    primitive.updateAllViews();
    expect(requests.length).toBeGreaterThan(count);
    expect(requests.at(-1)!.filter).toEqual({ minUsd: 9_983_952, alwaysOutcomes: ["filled", "partial"] });
    count = requests.length;
    primitive.updateAllViews();
    expect(requests).toHaveLength(count);
    primitive.setSettings({ ...primitive.settings, cutBasis: "ratio" });
    primitive.updateAllViews();
    expect(requests.at(-1)!.filter).toBeNull();
  });

  it("does not ask for the window again when the host's size bands drift a little, either way", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    const first = harness.requests[0].filter;
    const drifted = (factor: number) => ({ sizeBands: { ...BANDS, p50: BANDS.p50 * factor, p75: BANDS.p75 * factor, p90: BANDS.p90 * factor, p95: BANDS.p95 * factor, p99: BANDS.p99 * factor } });
    const answer = (factor: number) => {
      harness.stream.invalidateSince(0);
      harness.primitive.updateAllViews();
      land(harness, [], drifted(factor));
      expect(harness.primitive.bands()?.p90).toBeCloseTo(BANDS.p90 * factor, 0);
      harness.primitive.updateAllViews();
    };
    for (const factor of [1.05, 0.97, 1.1, 1.0]) answer(factor);
    expect(harness.requests.length).toBeGreaterThan(4);
    expect(harness.requests.every((request) => request.filter?.minUsd === first?.minUsd)).toBe(true);
    // A drop below what was asked for does ask again, from the new cut's 80%.
    answer(0.7);
    expect(harness.requests.at(-1)!.filter?.minUsd).toBe(Math.floor(BANDS.p90 * 0.7 * 0.8));
  });

  it("asks for as much history as the hours setting says, ending a minute after now", () => {
    const { primitive, requests } = setup();
    primitive.setSettings({ ...primitive.settings, hours: 12 });
    primitive.updateAllViews();
    expect(requests).toHaveLength(2);
    expect(requests[0].toTs).toBe(NOW + 60_000);
    expect(requests[1].fromTs).toBe(NOW - 12 * 3_600_000);
  });

  it("reloads the newest ninety minutes every five minutes, and not before", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    let seen = 0;
    while (seen < harness.requests.length) {
      harness.stream.accept(harness.requests[seen].requestId, page([]));
      seen += 1;
    }
    const settled = harness.requests.length;
    harness.clock.now += 60_000;
    harness.primitive.updateAllViews();
    expect(harness.requests).toHaveLength(settled);
    harness.clock.now += 5 * 60_000;
    harness.primitive.updateAllViews();
    expect(harness.requests.length).toBeGreaterThan(settled);
    expect(harness.requests.at(-1)!.toTs).toBeGreaterThan(harness.clock.now);
  });

  it("uses the host's size percentiles in place of the built-in scale once a page carries them, and the filter follows", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    expect(harness.primitive.bands()?.p90).toBe(18_797_056);
    land(harness, [], { sizeBands: { ...BANDS, p90: 30_000_000 } });
    expect(harness.primitive.bands()?.p90).toBe(30_000_000);
    harness.primitive.updateAllViews();
    // 30 M is still covered by the 15 M asked for, within twice it: nothing is asked again.
    expect(harness.requests.at(-1)!.filter?.minUsd).toBe(15_037_644);
    harness.stream.invalidateSince(0);
    harness.primitive.updateAllViews();
    land(harness, [], { sizeBands: { ...BANDS, p90: 40_000_000, p95: 45_000_000, p99: 50_000_000 } });
    harness.primitive.updateAllViews();
    expect(harness.requests.at(-1)!.filter?.minUsd).toBe(32_000_000);
  });

  it("draws one band per visible wall in its side's colour and heat, filled walls a pixel thicker, with an end mark for each outcome", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    land(harness, [FILLED, PULLED_ASK]);
    harness.primitive.updateAllViews();
    expect(harness.primitive.selection?.count).toBe(2);
    expect(harness.primitive.stats()).toMatchObject({ pages: 1, walls: 2 });
    const { context, ops } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    const rects = bandRects(ops);
    const bands = harness.primitive.bands()!;
    const heatPulled = heatOf(300 * 20_100.5 * 4, bands);
    const heightPulled = bandThickness(heatPulled, 2, 3, 8);
    const pulled = rects.find((rect) => rect[1] === bandColor(1, bandAlpha(heatPulled, 3)));
    expect(pulled).toBeDefined();
    expect(pulled![2]).toBeCloseTo(695, 6);
    expect(pulled![3]).toBeCloseTo(99 - heightPulled / 2, 4);
    expect(pulled![4]).toBeCloseTo(200, 6);
    expect(pulled![5]).toBeCloseTo(heightPulled, 4);
    const filled = rects.find((rect) => rect[1] === bandColor(0, bandAlpha(0, 0)));
    expect(filled).toBeDefined();
    expect(filled![2]).toBeCloseTo(495, 6);
    expect(filled![4]).toBeCloseTo(50, 6);
    expect(filled![5]).toBeCloseTo(bandThickness(0, 4, 3, 8) + 1, 6);
    expect(filled![3]).toBeCloseTo(498 - filled![5] / 2, 6);
    expect(ops.some((op) => op[0] === "arc" && op[1] === 545 && op[2] === 498 && op[3] === 4)).toBe(true);
    const tick = ops.findIndex((op) => op[0] === "moveTo" && op[1] === 895 && op[2] === 96);
    expect(tick).toBeGreaterThan(-1);
    expect(ops[tick + 1]).toEqual(["lineTo", 895, 102]);
    expect(ops.filter((op) => op[0] === "rect").at(-1)).toEqual(["rect", 0, 0, 1400 - Math.min(WHALE_LADDER_MAX_PX, Math.floor(1400 * 0.3)), 600]);
  });

  it("leaves out walls off the visible time range and walls the price scale cannot place", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    const far = wall({ id: 9, row: 19_910, startTs: NOW - 400 * MINUTE, endTs: NOW - 390 * MINUTE });
    const longRunning = wall({ id: 12, row: 19_920, peak: 300, startTs: NOW - 500 * MINUTE, endTs: NOW - 20 * MINUTE, endedBy: "pulled" });
    const offscreen = wall({ id: 10, row: 40_000 });
    land(harness, [FILLED, far, offscreen, longRunning]);
    harness.primitive.updateAllViews();
    expect(harness.primitive.selection?.count).toBe(4);
    const { context, ops } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    expect(bandRects(ops)).toHaveLength(2);
    const nothing = chartAndSeries();
    nothing.series.priceToCoordinate = () => null as unknown as number;
    const blind = new WhaleLimitHeatmapPrimitive(() => MINUTE, () => ({ revision: 1, opensMs: OPENS }), () => NOW);
    blind.attached({ chart: nothing.chart, series: nothing.series, requestUpdate: () => undefined } as unknown as SeriesAttachedParameter<Time>);
    blind.setIdentity(ID.marketKind, ID.symbol);
    const store = blind.store;
    store.addHost([FILLED], 4);
    blind.updateAllViews();
    const blindDraw = recorder();
    blind.renderHistory(blindDraw.context, SIZE);
    expect(bandRects(blindDraw.ops)).toHaveLength(0);
  });

  it("moves bands with a pan and rebuilds nothing: the selection is the same object and the rebuild count does not move", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    land(harness, [FILLED, PULLED_ASK]);
    harness.primitive.updateAllViews();
    const selection = harness.primitive.selection;
    const rebuilds = harness.primitive.stats().rebuilds;
    const first = recorder();
    harness.primitive.renderHistory(first.context, SIZE);
    harness.fake.view.lastCenterX = 900;
    harness.primitive.updateAllViews();
    const second = recorder();
    harness.primitive.renderHistory(second.context, SIZE);
    expect(harness.primitive.selection).toBe(selection);
    expect(harness.primitive.stats().rebuilds).toBe(rebuilds);
    expect(harness.primitive.stats().draws).toBe(2);
    const xs = (ops: Op[]) => bandRects(ops).map((rect) => rect[2]).sort((a, b) => a - b);
    expect(xs(second.ops).map((x, index) => Math.round(x - xs(first.ops)[index]))).toEqual([-100, -100]);
  });

  it("rebuilds at once for a settings change, and for a change in the walls at most once a second, with a repaint when the wait is over", () => {
    vi.useFakeTimers();
    const clock = { now: NOW };
    const harness = setup({ clock });
    harness.primitive.updateAllViews();
    land(harness, [FILLED]);
    harness.primitive.updateAllViews();
    const base = harness.primitive.stats().rebuilds;
    clock.now += 100;
    land(harness, [PULLED_ASK], {}, 0);
    harness.update.mockClear();
    harness.primitive.updateAllViews();
    expect(harness.primitive.stats().rebuilds).toBe(base);
    expect(harness.primitive.selection?.count).toBe(1);
    vi.advanceTimersByTime(WHALE_REBUILD_MS);
    expect(harness.update).toHaveBeenCalled();
    clock.now += WHALE_REBUILD_MS;
    harness.primitive.updateAllViews();
    expect(harness.primitive.stats().rebuilds).toBe(base + 1);
    expect(harness.primitive.selection?.count).toBe(2);
    clock.now += 10;
    harness.primitive.setSettings({ ...harness.primitive.settings, fills: false });
    harness.primitive.updateAllViews();
    expect(harness.primitive.stats().rebuilds).toBe(base + 2);
    expect(harness.primitive.selection?.count).toBe(1);
  });

  it("draws the live ladder as a separate strip with a bar per standing wall, collision-free labels, and the nearest ask and bid", () => {
    const harness = setup();
    harness.primitive.setSource(liveL2().l2);
    harness.primitive.updateAllViews();
    const { context, ops } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    harness.primitive.renderLive(context);
    const strip = fillRects(ops).find((rect) => rect[1] === "#e9e5d8");
    expect(strip).toEqual(["fillRect", "#e9e5d8", 1224, 0, 176, 600]);
    const bands = harness.primitive.bands()!;
    const heatBid = heatOf(300 * 19_950.5 * 4, bands);
    const bidX = 1400 - 5 - (16 + (84 - 16) * heatBid);
    const bar = fillRects(ops).find((rect) => rect[1] === bandColor(0, 0.38 + 0.55 * Math.pow(heatBid, 0.75)));
    expect(bar).toBeDefined();
    expect(bar![2]).toBeCloseTo(bidX, 3);
    expect(bar![3]).toBeCloseTo(399 - 3, 6);
    expect(bar![5]).toBe(6);
    const texts = ops.filter((op) => op[0] === "fillText").map((op) => op[2]);
    expect(texts).toEqual(expect.arrayContaining(["$40.3M · 2.0 h", "$23.9M · 30.0 min", "LIVE BOOK · standing now"]));
    expect(texts.some((text) => String(text).startsWith("next ask $40.3M +0.63%"))).toBe(true);
    expect(texts.some((text) => String(text).startsWith("next bid $23.9M -0.25%"))).toBe(true);
    const bidLabel = ops.find((op) => op[0] === "fillText" && op[2] === "$23.9M · 30.0 min")!;
    expect(bidLabel[3]).toBeCloseTo(bidX - 5, 3);
    expect(bidLabel[5]).toBe("right");
    expect(bidLabel[1]).toBe("#12803f");
    expect(ops.find((op) => op[0] === "fillText" && op[2] === "$40.3M · 2.0 h")![1]).toBe("#b02a2a");
  });

  it("skips a label that would sit on one already placed, and draws none when labels are off", () => {
    const crowded = [
      wall({ id: 5, side: "ask", row: 20_125, span: 1, peak: 500, startTs: NOW - 120 * MINUTE, endTs: null, endedBy: null }),
      wall({ id: 6, side: "ask", row: 20_126, span: 1, peak: 400, startTs: NOW - 90 * MINUTE, endTs: null, endedBy: null }),
      wall({ id: 7, side: "bid", row: 19_950, span: 1, peak: 300, startTs: NOW - 30 * MINUTE, endTs: null, endedBy: null }),
    ];
    const harness = setup();
    harness.primitive.setSource(liveL2({ walls: crowded }).l2);
    harness.primitive.updateAllViews();
    const withLabels = recorder();
    harness.primitive.renderHistory(withLabels.context, SIZE);
    harness.primitive.renderLive(withLabels.context);
    const labelsOf = (ops: Op[]) => ops.filter((op) => op[0] === "fillText" && LABEL.test(String(op[2]))).map((op) => op[2]);
    expect(labelsOf(withLabels.ops)).toEqual(["$40.3M · 2.0 h", "$23.9M · 30.0 min"]);
    const bars = bandRects(withLabels.ops).filter((rect) => rect[1].startsWith("rgba(220,65,65") && rect[5] > 0);
    expect(bars).toHaveLength(2);
    harness.primitive.setSettings({ ...harness.primitive.settings, labels: false });
    harness.primitive.updateAllViews();
    const without = recorder();
    harness.primitive.renderHistory(without.context, SIZE);
    harness.primitive.renderLive(without.context);
    expect(labelsOf(without.ops)).toEqual([]);
    expect(bandRects(without.ops).filter((rect) => rect[1].startsWith("rgba(220,65,65") && rect[5] > 0)).toHaveLength(2);
  });

  it("clears the ladder and shows the untrusted badge when the L2 feed is not live and synced, but keeps the history", () => {
    const harness = setup();
    const { l2, state } = liveL2();
    harness.primitive.setSource(l2);
    harness.primitive.updateAllViews();
    land(harness, [FILLED]);
    harness.primitive.updateAllViews();
    for (const breakIt of [() => { state.synced = false; }, () => { state.synced = true; state.segment = "GAP"; }, () => { state.segment = "LIVE"; state.availability = "HISTORICAL_UNAVAILABLE"; }]) {
      breakIt();
      expect(harness.primitive.trusted()).toBe(false);
      const { context, ops } = recorder();
      harness.primitive.renderHistory(context, SIZE);
      harness.primitive.renderLive(context);
      const texts = ops.filter((op) => op[0] === "fillText").map((op) => op[2]);
      expect(texts).toContain(WHALE_STATUS_UNTRUSTED);
      expect(texts).toContain("LIVE BOOK · L2 untrusted");
      expect(texts.some((text) => String(text).includes("standing now"))).toBe(false);
      expect(fillRects(ops).some((rect) => rect[1] === bandColor(0, bandAlpha(0, 0)))).toBe(true);
      const box = statusBadgeBox(STATUS_BADGE_SLOT.whaleHeatmap, WHALE_STATUS_UNTRUSTED);
      expect(ops.some((op) => op[0] === "fillRect" && op[2] === box.x && op[3] === box.y)).toBe(true);
    }
    state.availability = "LIVE";
    state.synced = true;
    expect(harness.primitive.trusted()).toBe(true);
  });

  it("says it is for Binance only on a market without a size scale, and draws nothing", () => {
    const harness = setup({ identity: false });
    harness.primitive.setIdentity("FUTURE", "/NQZ26:XCME");
    harness.primitive.updateAllViews();
    expect(harness.primitive.bands()).toBeNull();
    expect(harness.primitive.selection).toBeNull();
    const { context, ops } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    expect(ops.filter((op) => op[0] === "fillText").map((op) => op[2])).toEqual([WHALE_STATUS_UNSUPPORTED]);
    expect(fillRects(ops).length).toBe(1);
  });

  it("asks the host for nothing on a pair that is not on Binance, as ChartPanel names it, and stops a stream already asking", () => {
    const harness = setup({ identity: false });
    harness.primitive.setIdentity("", "/NQZ26:XCME");
    harness.primitive.updateAllViews();
    harness.clock.now += 10 * MINUTE;
    harness.primitive.updateAllViews();
    expect(harness.requests).toHaveLength(0);
    harness.primitive.setIdentity(ID.marketKind, ID.symbol);
    harness.primitive.updateAllViews();
    const asked = harness.requests.length;
    expect(asked).toBeGreaterThan(0);
    harness.primitive.setIdentity("", "/ESZ26:XCME");
    harness.primitive.updateAllViews();
    harness.stream.accept(harness.requests.at(-1)!.requestId, page([]));
    harness.clock.now += 10 * MINUTE;
    harness.primitive.updateAllViews();
    expect(harness.requests).toHaveLength(asked);
  });

  it("finds the wall, the end mark or the standing bar under a position, preferring a fill, and nothing on empty chart", () => {
    const harness = setup();
    harness.primitive.setSource(liveL2().l2);
    harness.primitive.updateAllViews();
    const overlap = wall({ id: 11, side: "bid", row: 19_900, span: 2, peak: 400, startTs: NOW - 52 * MINUTE, endTs: NOW - 44 * MINUTE, endedBy: "pulled" });
    land(harness, [FILLED, PULLED_ASK, overlap]);
    harness.primitive.updateAllViews();
    const { context } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    harness.primitive.renderLive(context);
    const pulled = harness.primitive.hitAt(800, 99);
    expect(pulled).toMatchObject({ kind: "wall", wall: { wall: { id: 2 } } });
    const both = harness.primitive.hitAt(520, 498);
    expect(both).toMatchObject({ kind: "wall", wall: { wall: { id: 1 } } });
    expect(harness.primitive.hitAt(547, 498)).toMatchObject({ kind: "wall" });
    expect(harness.primitive.hitAt(800, 300)).toBeNull();
    expect(harness.primitive.hitAt(1380, 399)).toMatchObject({ kind: "standing", wall: { wall: { id: 4 } } });
    expect(harness.primitive.hitAt(1380, 49)).toMatchObject({ kind: "standing", wall: { wall: { id: 3 } } });
    expect(harness.primitive.hitAt(1380, 250)).toBeNull();
    expect(harness.primitive.hitAt(1230, 399)).toBeNull();
  });

  it("describes a hit with a card, the pinned one adding the details, and shows the hover outline on the wall", () => {
    const harness = setup();
    harness.primitive.setSource(liveL2().l2);
    harness.primitive.updateAllViews();
    land(harness, [PULLED_ASK]);
    harness.primitive.updateAllViews();
    const { context, ops } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    harness.primitive.renderLive(context);
    const hit = harness.primitive.hitAt(800, 99)!;
    expect(harness.primitive.card(hit, false)).toMatchObject({ title: "ASK · PULLED", details: [], usd: "$24.1M" });
    expect(harness.primitive.card(hit, true).details).toHaveLength(6);
    const standing = harness.primitive.hitAt(1380, 399)!;
    expect(harness.primitive.card(standing, true)).toMatchObject({ title: "BID · STANDING NOW", sentence: "Resting for 30.0 min, 0.25% below price." });
    harness.primitive.setHover(hit);
    const hovered = recorder();
    harness.primitive.renderHistory(hovered.context, SIZE);
    expect(hovered.ops.filter((op) => op[0] === "strokeRect")).toHaveLength(1);
    const band = bandRects(hovered.ops).find((rect) => rect[1] === bandColor(1, bandAlpha(heatOf(300 * 20_100.5 * 4, harness.primitive.bands()!), 3)))!;
    expect(hovered.ops.find((op) => op[0] === "strokeRect")!.slice(1)).toEqual([band[2] - 1, band[3] - 1.5, band[4] + 2, band[5] + 3]);
    expect(hovered.ops.find((op) => op[0] === "outline")!.slice(1)).toEqual([1.5, "#141414"]);
    expect(ops.filter((op) => op[0] === "strokeRect")).toHaveLength(0);
  });

  it("ingests live walls at most once a second and only when the L2 version moved, from lane zero's row width", () => {
    vi.useFakeTimers();
    const clock = { now: NOW };
    const harness = setup({ clock });
    const { l2, state } = liveL2();
    harness.primitive.setSource(l2);
    harness.primitive.updateAllViews();
    expect(state.wallCalls).toBe(1);
    expect(harness.primitive.stats().liveIngests).toBe(1);
    harness.primitive.updateAllViews();
    expect(state.wallCalls).toBe(1);
    state.version = 2;
    clock.now += 400;
    harness.primitive.updateAllViews();
    expect(state.wallCalls).toBe(1);
    clock.now += 700;
    harness.primitive.updateAllViews();
    expect(state.wallCalls).toBe(2);
    expect(harness.primitive.store.standingCount).toBe(2);
    clock.now += 5_000;
    harness.primitive.updateAllViews();
    expect(state.wallCalls).toBe(2);
    harness.primitive.setSource(liveL2({ availability: "HISTORICAL_UNAVAILABLE", version: 7 }).l2);
    clock.now += 5_000;
    harness.primitive.updateAllViews();
    expect(harness.primitive.stats().liveIngests).toBe(2);
  });

  it("takes no live walls while the engine reports no row width, and none once the source is taken away", () => {
    const harness = setup();
    const broken = liveL2({ rowWidth: 0 });
    harness.primitive.setSource(broken.l2);
    harness.primitive.updateAllViews();
    expect(harness.primitive.stats().liveIngests).toBe(0);
    expect(harness.primitive.store.standingCount).toBe(0);
    const working = liveL2();
    harness.primitive.setSource(working.l2);
    harness.primitive.updateAllViews();
    expect(harness.primitive.store.standingCount).toBe(2);
    harness.primitive.setSource(null);
    expect(harness.primitive.store.standingCount).toBe(0);
  });

  it("reserves room on the right for the ladder and its gap, frees it when the live view goes off, and gives it back on detach", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    expect(harness.fake.applied.at(-1)).toEqual({ rightOffset: Math.ceil((WHALE_LADDER_MAX_PX + WHALE_NOW_GAP_PX) / 10) });
    harness.primitive.setSettings({ ...harness.primitive.settings, liveView: "rays" });
    harness.primitive.updateAllViews();
    expect(harness.fake.applied.at(-1)).toEqual({ rightOffset: Math.ceil((1400 * 0.14) / 10) });
    harness.primitive.setSettings({ ...harness.primitive.settings, liveView: "off" });
    harness.primitive.updateAllViews();
    expect(harness.fake.applied.at(-1)).toEqual({ rightOffset: 0 });
    harness.primitive.setSettings({ ...harness.primitive.settings, liveView: "ladder" });
    harness.primitive.updateAllViews();
    expect(harness.fake.options.rightOffset).toBe(24);
    harness.primitive.detached();
    expect(harness.fake.options.rightOffset).toBe(0);
  });

  it("claims its room again, even at an unchanged offset, when the chart's range was reset, and not while it claims none", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    const claimed = harness.fake.applied.length;
    harness.primitive.restoreRoom();
    expect(harness.fake.applied).toHaveLength(claimed + 1);
    expect(harness.fake.applied.at(-1)).toEqual({ rightOffset: Math.ceil((WHALE_LADDER_MAX_PX + WHALE_NOW_GAP_PX) / 10) });
    harness.primitive.setSettings({ ...harness.primitive.settings, liveView: "off" });
    harness.primitive.updateAllViews();
    const freed = harness.fake.applied.length;
    harness.primitive.restoreRoom();
    expect(harness.fake.applied.slice(freed).every((entry) => entry.rightOffset === 0)).toBe(true);
    expect(harness.fake.options.rightOffset).toBe(0);
  });

  it("lets go of everything on detach: the stream subscription, the walls, the selection and any waiting timer", () => {
    vi.useFakeTimers();
    const harness = setup();
    harness.primitive.setSource(liveL2().l2);
    harness.primitive.updateAllViews();
    land(harness, [FILLED]);
    harness.primitive.updateAllViews();
    expect(harness.primitive.store.size).toBe(1);
    land(harness, [PULLED_ASK], {}, 10);
    harness.primitive.updateAllViews();
    harness.update.mockClear();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    harness.primitive.detached();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.primitive.store.size).toBe(0);
    expect(harness.primitive.store.standingCount).toBe(0);
    expect(harness.primitive.selection).toBeNull();
    expect(harness.primitive.chart).toBeNull();
    const request = harness.requests.at(-1)!;
    harness.stream.accept(request.requestId, page([PULLED_ASK]));
    expect(harness.primitive.store.size).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(harness.update).not.toHaveBeenCalled();
    expect(() => harness.primitive.updateAllViews()).not.toThrow();
    const { context, ops } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    expect(ops).toEqual([]);
  });

  it("forgets the walls when the market changes, and the cached scale with them", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    land(harness, [FILLED], { sizeBands: { ...BANDS, p90: 30_000_000 } });
    harness.primitive.updateAllViews();
    expect(harness.primitive.store.size).toBe(1);
    harness.primitive.setIdentity("SPOT", "ETH-USDT");
    expect(harness.primitive.store.size).toBe(0);
    expect(harness.primitive.bands()?.p90).toBe(2_093_987);
    harness.primitive.setIdentity("SPOT", "ETH-USDT");
    harness.primitive.updateAllViews();
    expect(harness.primitive.store.size).toBe(0);
  });
});

describe("whale heatmap primitive: each choice that changes what is shown, and how it is drawn", () => {
  it("rebuilds at once for every setting that changes the selection, without waiting out the walls' one-second throttle", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    land(harness, [FILLED, PULLED_ASK]);
    harness.primitive.updateAllViews();
    const patches: Partial<WhaleSettings>[] = [
      { cutPreset: 3 },
      { sideFilter: "bid" },
      { fills: false },
      { outcomeMask: 0b00011 },
      { hours: 12 },
      { cutBasis: "ratio" },
      { ratioMin: 9 },
    ];
    for (const patch of patches) {
      const before = harness.primitive.stats().rebuilds;
      harness.primitive.setSettings({ ...harness.primitive.settings, ...patch });
      harness.primitive.updateAllViews();
      expect(harness.primitive.stats().rebuilds).toBe(before + 1);
    }
  });

  it("draws a partial wall at its own thickness, a pixel under a filled one, and follows the thickness setting", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    const partial = wall({ id: 20, row: 19_950, span: 2, endedBy: "partial", startTs: NOW - 40 * MINUTE, endTs: NOW - 30 * MINUTE });
    land(harness, [FILLED, partial]);
    harness.primitive.updateAllViews();
    const draw = () => {
      const { context, ops } = recorder();
      harness.primitive.renderHistory(context, SIZE);
      return bandRects(ops);
    };
    const heightOf = (rects: ReturnType<typeof draw>, outcome: number) => rects.find((rect) => rect[1] === bandColor(0, bandAlpha(0, outcome)))![5];
    let rects = draw();
    expect(heightOf(rects, 1)).toBe(bandThickness(0, 4, 3, 8));
    expect(heightOf(rects, 0)).toBe(bandThickness(0, 4, 3, 8) + 1);
    harness.primitive.setSettings({ ...harness.primitive.settings, thickness: 6 });
    harness.primitive.updateAllViews();
    rects = draw();
    expect(heightOf(rects, 1)).toBe(bandThickness(0, 4, 6, 8));
    expect(heightOf(rects, 1)).toBe(6);
  });

  it("draws a wall that began and ended in the same instant at a width of a pixel and a half", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    land(harness, [wall({ id: 30, row: 19_930, startTs: NOW - 10 * MINUTE, endTs: NOW - 10 * MINUTE })]);
    harness.primitive.updateAllViews();
    const { context, ops } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    expect(bandRects(ops).map((rect) => rect[4])).toEqual([1.5]);
  });

  it("puts the ladder's nearest ask and bid from the middle of the best bid and best ask, and leaves off standing walls outside the chart", () => {
    const harness = setup();
    const offscreen = wall({ id: 31, side: "ask", row: 21_000, span: 1, peak: 500, startTs: NOW - 120 * MINUTE, endTs: null, endedBy: null });
    harness.primitive.setSource(liveL2({ walls: [STANDING_ASK, STANDING_BID, offscreen] }).l2);
    harness.primitive.updateAllViews();
    const { context, ops } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    harness.primitive.renderLive(context);
    const texts = ops.filter((op) => op[0] === "fillText").map((op) => String(op[2]));
    expect(texts.some((text) => text.startsWith("next ask $40.3M +0.63%"))).toBe(true);
    expect(texts.some((text) => text.startsWith("next bid $23.9M -0.25%"))).toBe(true);
    const askBars = fillRects(ops).filter((rect) => rect[1].startsWith("rgba(220,65,65") && rect[2] > 1224);
    expect(askBars).toHaveLength(1);
  });

  it("answers a hit a few pixels past a wall's end mark and its band, and not further out", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    land(harness, [FILLED]);
    harness.primitive.updateAllViews();
    const { context } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    expect(harness.primitive.hitAt(549, 498)).toMatchObject({ kind: "wall" });
    expect(harness.primitive.hitAt(551, 498)).toBeNull();
    expect(harness.primitive.hitAt(520, 503)).toMatchObject({ kind: "wall" });
    expect(harness.primitive.hitAt(520, 505)).toBeNull();
  });

  it("prefers a wall that was touched over a pulled one where they overlap, even when the pulled one is bigger", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    const touched = wall({ id: 40, row: 19_950, span: 1, peak: 300, endedBy: "hit", startTs: NOW - 40 * MINUTE, endTs: NOW - 20 * MINUTE });
    const pulled = wall({ id: 41, row: 19_950, span: 1, peak: 3_000, endedBy: "pulled", startTs: NOW - 41 * MINUTE, endTs: NOW - 20 * MINUTE });
    land(harness, [touched, pulled]);
    harness.primitive.updateAllViews();
    expect(harness.primitive.selection?.count).toBe(2);
    const { context } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    expect(harness.primitive.hitAt(700, yOf(19_950.5 * 4))).toMatchObject({ kind: "wall", wall: { wall: { id: 40 } } });
  });

  it("answers no hit on the ladder while the feed is not trusted, though the standing walls are still held", () => {
    const harness = setup();
    const { l2, state } = liveL2();
    harness.primitive.setSource(l2);
    harness.primitive.updateAllViews();
    const { context } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    expect(harness.primitive.hitAt(1380, 399)).toMatchObject({ kind: "standing" });
    state.synced = false;
    expect(harness.primitive.store.standingCount).toBe(2);
    expect(harness.primitive.hitAt(1380, 399)).toBeNull();
  });

  it("names the coin of a wall's size from the market's symbol on the card", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    land(harness, [PULLED_ASK]);
    harness.primitive.updateAllViews();
    const { context } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    const hit = harness.primitive.hitAt(800, 99)!;
    expect(harness.primitive.card(hit, false).facts.startsWith("300 BTC · 20.0 min")).toBe(true);
  });

  it("does not ask for a repaint when the hover moves to the same wall again", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    land(harness, [PULLED_ASK]);
    harness.primitive.updateAllViews();
    const { context } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    const first = harness.primitive.hitAt(800, 99)!;
    const again = harness.primitive.hitAt(801, 99)!;
    expect(again).not.toBe(first);
    harness.primitive.setHover(first);
    harness.update.mockClear();
    harness.primitive.setHover(again);
    expect(harness.update).not.toHaveBeenCalled();
    harness.primitive.setHover(null);
    expect(harness.update).toHaveBeenCalledTimes(1);
  });

  it("sizes a ladder bar by its heat when its price span allows, from five pixels up to eleven", () => {
    const harness = setup();
    const tall = wall({ id: 50, side: "ask", row: 20_125, span: 8, peak: 400, startTs: NOW - 60 * MINUTE, endTs: null, endedBy: null });
    harness.primitive.setSource(liveL2({ walls: [tall] }).l2);
    harness.primitive.updateAllViews();
    const { context, ops } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    harness.primitive.renderLive(context);
    const heat = heatOf(400 * (20_125 + 4) * 4, harness.primitive.bands()!);
    expect(heat).toBeGreaterThan(0.3);
    expect(heat).toBeLessThan(0.95);
    const bar = fillRects(ops).find((rect) => rect[1] === bandColor(1, 0.38 + 0.55 * Math.pow(heat, 0.75)));
    expect(bar).toBeDefined();
    expect(bar![5]).toBeCloseTo(5 + 5 * heat, 6);
  });

  it("draws the rays for the standing walls, a dashed line to the now edge and a fade past it, and for both views at once", () => {
    const harness = setup();
    harness.primitive.setSource(liveL2().l2);
    harness.primitive.setSettings({ ...harness.primitive.settings, liveView: "rays" });
    harness.primitive.updateAllViews();
    const rays = recorder();
    harness.primitive.renderHistory(rays.context, SIZE);
    harness.primitive.renderLive(rays.context);
    const y = yOf(20_125.5 * 4);
    const line = rays.ops.findIndex((op) => op[0] === "moveTo" && op[1] === 0 && op[2] === y);
    expect(line).toBeGreaterThan(-1);
    expect(rays.ops[line + 1]).toEqual(["lineTo", 995, y]);
    const heat = heatOf(500 * 20_125.5 * 4, harness.primitive.bands()!);
    const alpha = 0.3 + 0.6 * Math.pow(heat, 0.75);
    expect(rays.ops.filter((op) => op[0] === "stop").slice(0, 2)).toEqual([["stop", 0, bandColor(1, alpha)], ["stop", 1, bandColor(1, alpha * 0.25)]]);
    expect(fillRects(rays.ops).some((rect) => rect[1] === STRIP)).toBe(false);
    harness.primitive.setSettings({ ...harness.primitive.settings, liveView: "both" });
    harness.primitive.updateAllViews();
    const both = recorder();
    harness.primitive.renderHistory(both.context, SIZE);
    harness.primitive.renderLive(both.context);
    expect(fillRects(both.ops).find((rect) => rect[1] === STRIP)).toEqual(["fillRect", STRIP, 1224, 0, 176, 600]);
    expect(both.ops.some((op) => op[0] === "moveTo" && op[1] === 0 && op[2] === y)).toBe(true);
    expect(both.ops.some((op) => op[0] === "stop")).toBe(false);
    expect(both.ops.some((op) => op[0] === "fillText" && op[2] === "LIVE BOOK · standing now")).toBe(true);
  });

  it("answers a hit on a ray from a few pixels before the now edge to the chart's edge, and not further left", () => {
    const harness = setup();
    harness.primitive.setSource(liveL2().l2);
    harness.primitive.setSettings({ ...harness.primitive.settings, liveView: "rays" });
    harness.primitive.updateAllViews();
    const { context } = recorder();
    harness.primitive.renderHistory(context, SIZE);
    const y = yOf(20_125.5 * 4);
    expect(harness.primitive.hitAt(992, y)).toMatchObject({ kind: "standing", wall: { wall: { id: 3 } } });
    expect(harness.primitive.hitAt(990, y)).toBeNull();
    expect(harness.primitive.hitAt(1399, y)).toMatchObject({ kind: "standing" });
  });
});

describe("whale heatmap primitive: what it holds and what it asks for while hidden, shown again, or given another stream", () => {
  it("drops the walls and stops asking when the stream is taken away, and reloads everything when it comes back", () => {
    vi.useFakeTimers();
    const harness = setup();
    harness.primitive.setSource(liveL2().l2);
    harness.primitive.updateAllViews();
    let seen = 0;
    while (seen < harness.requests.length) {
      harness.stream.accept(harness.requests[seen].requestId, page([FILLED]));
      seen += 1;
    }
    harness.primitive.updateAllViews();
    expect(harness.primitive.store.size).toBe(1);
    const outstanding = harness.requests.length;
    harness.primitive.setStream(null);
    expect(harness.primitive.store.size).toBe(0);
    expect(harness.primitive.selection).toBeNull();
    expect(harness.primitive.bands()?.p90).toBe(18_797_056);
    harness.primitive.updateAllViews();
    expect(harness.requests).toHaveLength(outstanding);
    harness.primitive.setStream(harness.stream);
    harness.primitive.updateAllViews();
    expect(harness.requests.length).toBeGreaterThan(outstanding);
    harness.stream.accept(harness.requests.at(-1)!.requestId, page([PULLED_ASK]));
    expect(harness.primitive.store.size).toBe(1);
  });

  it("draws nothing, claims no room, asks for nothing and answers no hit while it is inactive, and starts again when it is switched on", () => {
    const harness = setup();
    harness.primitive.setSource(liveL2().l2);
    harness.primitive.updateAllViews();
    land(harness, [FILLED, PULLED_ASK]);
    harness.primitive.updateAllViews();
    const live = recorder();
    harness.primitive.renderHistory(live.context, SIZE);
    harness.primitive.renderLive(live.context);
    expect(live.ops.length).toBeGreaterThan(0);
    expect(harness.primitive.hitAt(800, 99)).not.toBeNull();
    expect(harness.fake.options.rightOffset).toBe(24);
    let answered = 0;
    while (answered < harness.requests.length) {
      harness.stream.accept(harness.requests[answered].requestId, page([]));
      answered += 1;
    }
    harness.primitive.setActive(false);
    expect(harness.primitive.active).toBe(false);
    expect([harness.primitive.store.size, harness.primitive.store.standingCount, harness.primitive.selection]).toEqual([0, 0, null]);
    expect(harness.fake.options.rightOffset).toBe(0);
    const asked = harness.requests.length;
    const claims = harness.fake.applied.length;
    harness.clock.now += 10_000;
    harness.primitive.updateAllViews();
    expect(harness.requests).toHaveLength(asked);
    expect(harness.fake.applied).toHaveLength(claims);
    const idle = recorder();
    harness.primitive.renderHistory(idle.context, SIZE);
    harness.primitive.renderLive(idle.context);
    expect(idle.ops).toEqual([]);
    expect(harness.primitive.hitAt(800, 99)).toBeNull();
    const before = harness.fake.applied.length;
    harness.primitive.restoreRoom();
    expect(harness.fake.applied).toHaveLength(before);
    harness.primitive.setActive(true);
    harness.primitive.setStream(harness.stream);
    harness.primitive.setSource(liveL2().l2);
    harness.primitive.updateAllViews();
    expect(harness.requests.length).toBeGreaterThan(asked);
    expect(harness.fake.options.rightOffset).toBe(24);
  });

  it("shows no unsupported-market badge while inactive, and lets go of live walls it holds even with no stream", () => {
    const unsupported = setup({ identity: false });
    unsupported.primitive.setIdentity("FUTURE", "/NQZ26:XCME");
    const shown = recorder();
    unsupported.primitive.renderHistory(shown.context, SIZE);
    expect(shown.ops.some((op) => op[0] === "fillText" && op[2] === WHALE_STATUS_UNSUPPORTED)).toBe(true);
    unsupported.primitive.setActive(false);
    const hidden = recorder();
    unsupported.primitive.renderHistory(hidden.context, SIZE);
    expect(hidden.ops).toEqual([]);
    const harness = setup({ stream: false });
    harness.primitive.setSource(liveL2({ walls: [wall({ id: 60, side: "bid", row: 19_950, endTs: NOW - 5 * MINUTE })] }).l2);
    harness.primitive.updateAllViews();
    expect(harness.primitive.store.size).toBe(1);
    harness.primitive.setActive(false);
    expect([harness.primitive.store.size, harness.primitive.selection]).toEqual([0, null]);
  });

  it("leaves the stream with nothing to retry once it is taken away", () => {
    vi.useFakeTimers();
    const harness = setup();
    harness.primitive.updateAllViews();
    const pending = harness.requests.at(-1)!;
    harness.primitive.setStream(null);
    harness.stream.fail(pending.requestId);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops listening to the stream it had when it is given another", () => {
    const harness = setup();
    const other = new WallHistoryStream({ request: () => undefined, chunkMs: WHALE_WALL_CHUNK_MS });
    other.setIdentity(ID);
    harness.primitive.setStream(other);
    harness.stream.accept(harness.requests.at(-1)?.requestId ?? -1, page([FILLED]));
    expect(harness.primitive.store.size).toBe(0);
    const first = setup();
    first.primitive.updateAllViews();
    const request = first.requests[0];
    const second = new WallHistoryStream({ request: () => undefined, chunkMs: WHALE_WALL_CHUNK_MS });
    first.primitive.setStream(second);
    first.stream.accept(request.requestId, page([FILLED]));
    expect(first.primitive.store.size).toBe(0);
  });

  it("keeps asking unfiltered once the host has refused the filter, whatever the cut is changed to", () => {
    const harness = setup();
    harness.primitive.updateAllViews();
    const [one, two] = harness.requests;
    harness.stream.accept(one.requestId, { available: false, reason: "STORAGE_UNAVAILABLE" } as HostWallPage);
    harness.stream.accept(two.requestId, { available: false, reason: "STORAGE_UNAVAILABLE" } as HostWallPage);
    expect(harness.stream.filterDropped).toBe(true);
    harness.primitive.setSettings({ ...harness.primitive.settings, cutPreset: 4 });
    harness.primitive.updateAllViews();
    expect(harness.stream.filter).toBeNull();
    expect(harness.stream.filterDropped).toBe(true);
  });
});

describe("whale heatmap primitive: what a frame costs", () => {
  it("draws five thousand visible bands in a few milliseconds of its own time, projecting each band once for both its body and its end mark", () => {
    const harness = setup();
    const count = 5_000;
    const walls = Array.from({ length: count }, (_, index) => wall({ id: index + 1, side: index % 2 === 0 ? "bid" : "ask", row: 19_900 + (index % 40), span: 1 + (index % 3), peak: 900, startTs: NOW - 3 * 3_600_000 + (index % 2_000) * 4_000 + index, endTs: NOW - 3 * 3_600_000 + (index % 2_000) * 4_000 + index + 600_000, endedBy: (["filled", "partial", "hit", "pulled", "moved"] as const)[index % 5] }));
    harness.primitive.setSettings({ ...harness.primitive.settings, cutPreset: 0, outcomeMask: 0b11111, fills: true });
    harness.primitive.store.addHost(walls, 4);
    harness.primitive.updateAllViews();
    expect(harness.primitive.selection?.count).toBe(count);
    const ops = recorder();
    let projections = 0;
    const series = harness.primitive.series as unknown as { priceToCoordinate: (price: number) => number };
    const project = series.priceToCoordinate;
    series.priceToCoordinate = (price) => {
      projections += 1;
      return project(price);
    };
    harness.primitive.renderHistory(ops.context, SIZE);
    const drawn = bandRects(ops.ops).length;
    expect(drawn).toBeGreaterThan(1_000);
    expect(projections).toBeLessThanOrEqual(2 * (harness.primitive.selection?.count ?? 0));
    const started = performance.now();
    for (let frame = 0; frame < 20; frame += 1) harness.primitive.renderHistory(recorder().context, SIZE);
    expect((performance.now() - started) / 20).toBeLessThan(40);
  });
});
