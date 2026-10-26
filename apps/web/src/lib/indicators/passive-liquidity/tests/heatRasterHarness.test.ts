import { describe, expect, it } from "vitest";
import type { BitmapCoordinatesRenderingScope, CanvasRenderingTarget2D } from "fancy-canvas";
import type { IChartApiBase, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { LiquidityFrame } from "../../../../types/frames";
import { LiquidityGrid } from "../liquidityGrid";
import { computeHeatmapLayout, type HeatmapLayout } from "../liquidityHeatmapLayout";
import { DEFAULT_LIQUIDITY_SETTINGS, type LiquiditySettings } from "../liquiditySettings";
import { HeatRendererBeforeRaster } from "./fixtures/heatRendererBeforeRaster";
import { LiquidityHeatRenderer } from "../liquidityHeatRenderer";
import { FakeContext, FakeHost, colours, diffPixels, drawPane, paintedPixels, pixelAt, rgbKey, type Rgba } from "./heatRasterHarness";

// The fakes the heat raster's property tests stand on, proved before anything
// is built on them: the canvas rules they keep, and the HEAD renderer drawn
// through them painting the picture the layout says it must.

const T = 1_700_000_000_000;
/** A fixed colour scale and no quiet zone, so what paints is plain arithmetic: paint floor 0.4 x 10 x 2 rows = 8, saturation 10 x 2 = 20. */
const FIXED: LiquiditySettings = { ...DEFAULT_LIQUIDITY_SETTINGS, scaleMode: "fixed", scaleSize: 10, quietBands: 0 };
const PANE = { width: 600, height: 400, hpr: 1, vpr: 1 };

function frame(seq: number, second: number, reset: boolean): LiquidityFrame {
  return {
    type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: T + second * 1000, seq, reset,
    row_width: 2, column_ms: 1000,
    columns: [{ ts: T + second * 1000, lo: 100, hi: 104, bid: [[0, 30], [1, 8]], ask: [[3, 20], [4, 6]] }],
  } as LiquidityFrame;
}

/** Price p sits at y = (212 - p) x 20; the last 60 s candle is 6 px wide, centred at x 500, and opens at T. */
function layoutFor(grid: LiquidityGrid, settings: LiquiditySettings = FIXED): HeatmapLayout {
  const chart = {
    timeScale: () => ({ timeToIndex: () => 2, logicalToCoordinate: () => 500, options: () => ({ barSpacing: 6 }), width: () => 600 }),
    paneSize: () => ({ height: 400, width: 600 }),
  } as unknown as IChartApiBase<Time>;
  const series = {
    data: () => [0, 1, 2].map((i) => ({ time: T / 1000 - (2 - i) * 60, high: 206, low: 202, close: 204 })),
    coordinateToPrice: (y: number) => 212 - y / 20,
    priceToCoordinate: (price: number) => (212 - price) * 20,
  } as unknown as ISeriesApi<SeriesType, Time>;
  return computeHeatmapLayout(chart, series, grid, settings)!;
}

/** The same chart with a hole in its bars: bars at T - 2 h and a minute later, then the next at T, nothing between. */
function layoutWithGap(grid: LiquidityGrid, settings: LiquiditySettings = FIXED): HeatmapLayout {
  const chart = {
    timeScale: () => ({ timeToIndex: () => 2, logicalToCoordinate: () => 500, options: () => ({ barSpacing: 6 }), width: () => 600 }),
    paneSize: () => ({ height: 400, width: 600 }),
  } as unknown as IChartApiBase<Time>;
  const series = {
    data: () => [T / 1000 - 7260, T / 1000 - 7200, T / 1000].map((time) => ({ time, high: 206, low: 202, close: 204 })),
    coordinateToPrice: (y: number) => 212 - y / 20,
    priceToCoordinate: (price: number) => (212 - price) * 20,
  } as unknown as ISeriesApi<SeriesType, Time>;
  return computeHeatmapLayout(chart, series, grid, settings)!;
}

function scene(): FakeHost {
  const grid = new LiquidityGrid();
  grid.apply(frame(1, 0, true));
  return new FakeHost({ grid, layout: layoutFor(grid), settings: FIXED });
}

function imageOf(width: number, height: number, colour: (x: number, y: number) => Rgba): ImageData {
  const image = new FakeContext().createImageData(width, height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) image.data.set(colour(x, y), (y * width + x) * 4);
  return image;
}

function solid(width: number, height: number, rgba: Rgba): FakeContext {
  const fake = new FakeContext(width, height);
  fake.putImageData(imageOf(width, height, () => rgba), 0, 0);
  fake.resetCounts();
  return fake;
}

const NO_COUNTS = { puts: 0, putPixels: 0, draws: 0, drawPixels: 0, clears: 0, overlaps: 0 };

describe("FakeContext", () => {
  it("clears and reallocates its pixels whenever a side is assigned, even to the value it has", () => {
    const fake = solid(3, 2, [1, 2, 3, 255]);
    const before = fake.data;
    fake.canvas.width = 3;
    expect(fake.data).not.toBe(before);
    expect(paintedPixels(fake)).toBe(0);
    fake.putImageData(imageOf(3, 2, () => [1, 2, 3, 255]), 0, 0);
    fake.canvas.height = 2;
    expect(paintedPixels(fake)).toBe(0);
    fake.canvas.height = 4;
    expect([fake.width, fake.height, fake.data.length]).toEqual([3, 4, 48]);
    expect(() => {
      fake.canvas.width = 2.5;
    }).toThrow(/whole pixel/);
  });

  it("puts an image as it is, clipped to the canvas, replacing what was there", () => {
    const fake = new FakeContext(4, 3);
    const image = imageOf(3, 2, (x, y) => [10 * x, 10 * y, 7, 200]);
    fake.putImageData(image, -1, 2);
    // Only the image's top row from its second pixel on lands: at (0, 2) and (1, 2).
    expect(fake.pixel(0, 2)).toEqual([10, 0, 7, 200]);
    expect(fake.pixel(1, 2)).toEqual([20, 0, 7, 200]);
    expect(paintedPixels(fake)).toBe(2);
    expect(fake.counts).toEqual({ ...NO_COUNTS, puts: 1, putPixels: 2 });
    fake.putImageData(imageOf(1, 1, () => [0, 0, 0, 0]), 1, 2);
    expect(fake.pixel(1, 2)).toEqual([0, 0, 0, 0]);
    fake.putImageData(image, 4, 0);
    expect(fake.counts).toEqual({ ...NO_COUNTS, puts: 3, putPixels: 3 });
  });

  it("clears a rectangle, clipped to the canvas", () => {
    const fake = solid(3, 3, [5, 6, 7, 255]);
    fake.clearRect(1, 1, 5, 5);
    expect(paintedPixels(fake)).toBe(5);
    expect(fake.pixel(2, 2)).toEqual([0, 0, 0, 0]);
    expect(fake.pixel(0, 2)).toEqual([5, 6, 7, 255]);
    expect(fake.pixel(2, 0)).toEqual([5, 6, 7, 255]);
    expect(fake.counts).toEqual({ ...NO_COUNTS, clears: 1 });
  });

  it("copies another fake's canvas 1:1, clipped on both canvases, a transparent source pixel leaving the destination", () => {
    const source = new FakeContext(3, 2);
    source.putImageData(imageOf(3, 2, (x, y) => (x === 1 && y === 0 ? [0, 0, 0, 0] : [x + 1, y + 1, 9, 255])), 0, 0);
    const target = new FakeContext(4, 4);
    target.drawImage(source.canvas, 0, 0, 3, 2, 2, 3, 3, 2);
    // Lands at x 2..3 (cut by the right edge) of row 3 (cut by the bottom): source (0, 0), then the transparent (1, 0).
    expect(target.pixel(2, 3)).toEqual([1, 1, 9, 255]);
    expect(target.pixel(3, 3)).toEqual([0, 0, 0, 0]);
    expect(paintedPixels(target)).toBe(1);
    expect(target.counts).toEqual({ ...NO_COUNTS, draws: 1, drawPixels: 2 });
    target.drawImage(source.canvas, 1, 0, 2, 2, 0, 0, 2, 2);
    expect([target.pixel(0, 0), target.pixel(1, 0), target.pixel(0, 1), target.pixel(1, 1)]).toEqual([[0, 0, 0, 0], [3, 1, 9, 255], [2, 2, 9, 255], [3, 2, 9, 255]]);
    target.drawImage(source.canvas, -1, 2);
    // The whole source, its first column cut by the left edge: source (1..2, 0..1) at (0..1, 2..3).
    expect([target.pixel(0, 2), target.pixel(1, 2), target.pixel(0, 3), target.pixel(1, 3)]).toEqual([[0, 0, 0, 0], [3, 1, 9, 255], [2, 2, 9, 255], [3, 2, 9, 255]]);
    expect(target.counts).toEqual({ ...NO_COUNTS, draws: 3, drawPixels: 10 });
  });

  it("counts a painted source pixel landing on a painted pixel as an overlap, and replaces it without blending", () => {
    const target = solid(2, 1, [1, 1, 1, 255]);
    const source = new FakeContext(2, 1);
    source.putImageData(imageOf(2, 1, (x) => (x === 0 ? [0, 0, 0, 0] : [200, 100, 50, 128])), 0, 0);
    target.drawImage(source.canvas, 0, 0);
    expect(target.pixel(0, 0)).toEqual([1, 1, 1, 255]);
    expect(target.pixel(1, 0)).toEqual([200, 100, 50, 128]);
    expect(target.counts).toEqual({ ...NO_COUNTS, draws: 1, drawPixels: 2, overlaps: 1 });
  });

  it("throws on every call the renderer must never make: scaling, an unknown source, any other method or property", () => {
    const source = solid(2, 2, [1, 2, 3, 255]);
    const target = new FakeContext(4, 4);
    const context = target.context;
    const image = source.context.canvas;
    expect(context.canvas).toBe(target.canvas);
    expect(() => context.drawImage(image, 0, 0, 2, 2, 0, 0, 4, 4)).toThrow(/1:1/);
    expect(() => context.drawImage(image, 0, 0, 2, 2, 0, 0, 2, 1)).toThrow(/1:1/);
    expect(() => context.drawImage(image, 0, 0, 4, 4)).toThrow(/5-argument/);
    expect(() => context.drawImage({ width: 2, height: 2 } as unknown as CanvasImageSource, 0, 0)).toThrow(/not the canvas of a FakeContext/);
    expect(() => context.drawImage(context.canvas, 0, 0)).toThrow(/onto itself/);
    expect(() => context.drawImage(new FakeContext(0, 2).context.canvas, 0, 0)).toThrow(/empty/);
    expect(() => context.drawImage(image, 0.5, 0)).toThrow(/whole pixel/);
    expect(() => context.putImageData(target.createImageData(1, 1), 0, 0, 0, 0, 1, 1)).toThrow(/7-argument/);
    expect(() => context.createImageData(0, 1)).toThrow(/size/);
    expect(() => context.fillRect(0, 0, 1, 1)).toThrow(/fillRect is not supported/);
    expect(() => context.save()).toThrow(/save is not supported/);
    expect(() => context.getImageData(0, 0, 1, 1)).toThrow(/getImageData is not supported/);
    expect(() => {
      context.globalAlpha = 0.5;
    }).toThrow(/setting globalAlpha/);
    expect(() => {
      context.imageSmoothingEnabled = false;
    }).toThrow(/setting imageSmoothingEnabled/);
    expect(target.counts).toEqual(NO_COUNTS);
    expect(paintedPixels(target)).toBe(0);
  });

  it("takes only the methods it was made for: a pane draws images and nothing else", () => {
    const pane = new FakeContext(2, 2, ["drawImage"]);
    expect(() => pane.context.putImageData(pane.createImageData(1, 1), 0, 0)).toThrow(/putImageData is not supported/);
    expect(() => pane.context.clearRect(0, 0, 1, 1)).toThrow(/clearRect is not supported/);
    expect(() => pane.context.createImageData(1, 1)).toThrow(/createImageData is not supported/);
    pane.context.drawImage(solid(1, 1, [4, 4, 4, 255]).context.canvas, 1, 1);
    expect(pane.pixel(1, 1)).toEqual([4, 4, 4, 255]);
  });
});

describe("FakeHost", () => {
  it("hands out one cleared image buffer while its size holds and a new one when it changes, sizing the offscreen canvas like the primitive", () => {
    const host = new FakeHost();
    const first = host.imageBuffer(3, 2)!;
    expect([first.width, first.height, first.data.length]).toEqual([3, 2, 24]);
    first.data.fill(7);
    const again = host.imageBuffer(3, 2)!;
    expect(again).toBe(first);
    expect(again.data.every((value) => value === 0)).toBe(true);
    const wider = host.imageBuffer(4, 2)!;
    expect(wider).not.toBe(first);
    expect([wider.width, wider.height]).toEqual([4, 2]);
    expect([host.offscreenContext.width, host.offscreenContext.height]).toEqual([4, 2]);
  });

  it("keeps a raster slot's pixels while its size holds and clears it when the size changes, each slot its own canvas", () => {
    const host = new FakeHost();
    const raster = host.raster(0, 3, 2)!;
    expect(raster).toBe(host.rasters[0].context);
    raster.putImageData(imageOf(3, 2, () => [9, 9, 9, 255]), 0, 0);
    const kept = host.rasters[0].data;
    expect(host.raster(0, 3, 2)).toBe(raster);
    expect(host.rasters[0].data).toBe(kept);
    expect(paintedPixels(host.rasters[0])).toBe(6);
    const other = host.raster(1, 3, 2)!;
    expect(other).toBe(host.rasters[1].context);
    expect(other.canvas).not.toBe(raster.canvas);
    expect(paintedPixels(host.rasters[1])).toBe(0);
    other.drawImage(raster.canvas, 0, 0, 3, 2, 0, 0, 3, 2);
    expect(paintedPixels(host.rasters[1])).toBe(6);
    host.raster(0, 4, 2);
    expect([host.rasters[0].width, host.rasters[0].height, paintedPixels(host.rasters[0])]).toEqual([4, 2, 0]);
    expect(host.rasters[0].counts).toEqual({ ...NO_COUNTS, puts: 1, putPixels: 6 });
    host.resetCounts();
    expect(host.rasters[0].counts).toEqual(NO_COUNTS);
  });

  it("keeps the offscreen canvas while its size holds, and lets the renderer only put pixels into it", () => {
    const host = new FakeHost();
    const offscreen = host.offscreen(2, 2)!;
    offscreen.putImageData(imageOf(2, 2, () => [3, 3, 3, 255]), 0, 0);
    expect(host.offscreen(2, 2)).toBe(offscreen);
    expect(paintedPixels(host.offscreenContext)).toBe(4);
    expect(() => offscreen.clearRect(0, 0, 1, 1)).toThrow(/clearRect is not supported/);
    host.offscreen(2, 3);
    expect(paintedPixels(host.offscreenContext)).toBe(0);
  });

  it("records every repaint asked for, and takes its colours from the settings unless given", () => {
    const host = new FakeHost({ settings: { ...DEFAULT_LIQUIDITY_SETTINGS, bidColor: "#010203" } });
    host.scheduleRepaint(150);
    host.scheduleRepaint(10);
    expect(host.scheduled).toEqual([150, 10]);
    expect(host.bidRgb).toEqual({ r: 1, g: 2, b: 3 });
    expect(rgbKey(host.askRgb)).toBe("124,58,237");
    expect(new FakeHost({ askRgb: { r: 4, g: 5, b: 6 } }).askRgb).toEqual({ r: 4, g: 5, b: 6 });
  });
});

describe("drawPane and the shot helpers", () => {
  it("hands the renderer a fresh pane in bitmap space and reports its pixels, blits and overlaps", () => {
    const piece = solid(2, 2, [9, 8, 7, 255]);
    const scopes: BitmapCoordinatesRenderingScope[] = [];
    const renderer = {
      draw(target: CanvasRenderingTarget2D) {
        target.useBitmapCoordinateSpace((scope) => {
          scopes.push(scope);
          scope.context.drawImage(piece.context.canvas, 0, 0);
          scope.context.drawImage(piece.context.canvas, 1, 1);
        });
      },
    };
    const shot = drawPane(renderer, { width: 4, height: 3, hpr: 2, vpr: 1.5 });
    expect(scopes).toHaveLength(1);
    const { bitmapSize, mediaSize, horizontalPixelRatio, verticalPixelRatio } = scopes[0];
    expect({ bitmapSize, mediaSize, horizontalPixelRatio, verticalPixelRatio }).toEqual({ bitmapSize: { width: 4, height: 3 }, mediaSize: { width: 2, height: 2 }, horizontalPixelRatio: 2, verticalPixelRatio: 1.5 });
    expect({ width: shot.width, height: shot.height, blits: shot.blits, overlaps: shot.overlaps }).toEqual({ width: 4, height: 3, blits: 2, overlaps: 1 });
    expect(paintedPixels(shot)).toBe(7);
    expect(paintedPixels(drawPane(renderer, { width: 4, height: 3, hpr: 1, vpr: 1 }))).toBe(7);
    expect(paintedPixels(drawPane({ draw: () => undefined }, { width: 4, height: 3, hpr: 1, vpr: 1 }))).toBe(0);
  });

  it("refuses a renderer that paints in media space", () => {
    const renderer = { draw: (target: CanvasRenderingTarget2D) => target.useMediaCoordinateSpace(() => undefined) };
    expect(() => drawPane(renderer, PANE)).toThrow(/bitmap space only/);
  });

  it("diffs two shots pixel by pixel, leaving out the edge columns asked for, and counts and names what is painted", () => {
    const a = solid(3, 2, [1, 2, 3, 255]).shot();
    const b = solid(3, 2, [1, 2, 3, 255]);
    b.clearRect(0, 1, 1, 1);
    b.putImageData(imageOf(1, 1, () => [4, 5, 6, 255]), 2, 1);
    expect(diffPixels(a, b)).toEqual({ count: 2, first: { x: 0, y: 1, a: [1, 2, 3, 255], b: [0, 0, 0, 0] } });
    expect(diffPixels(a, b, { left: 1 })).toEqual({ count: 1, first: { x: 2, y: 1, a: [1, 2, 3, 255], b: [4, 5, 6, 255] } });
    expect(diffPixels(a, b, { left: 1, right: 1 })).toEqual({ count: 0, first: null });
    expect(diffPixels(a, a)).toEqual({ count: 0, first: null });
    expect(() => diffPixels(a, new FakeContext(2, 3))).toThrow(/3x2 shot against a 2x3/);
    expect(paintedPixels(b)).toBe(5);
    expect(colours(b)).toEqual(new Set(["1,2,3", "4,5,6"]));
    expect(pixelAt(b, 2, 1)).toEqual([4, 5, 6, 255]);
    expect(() => pixelAt(b, 3, 0)).toThrow(/outside/);
  });
});

describe("HeatRendererBeforeRaster drawn through the fakes (the HEAD picture)", () => {
  it("paints a picture with the bid colour in it, in one blit with nothing overlapping", () => {
    const host = scene();
    const shot = drawPane(new HeatRendererBeforeRaster(host), PANE);
    expect(paintedPixels(shot)).toBeGreaterThan(0);
    expect(colours(shot).has(rgbKey(host.bidRgb))).toBe(true);
    expect({ blits: shot.blits, overlaps: shot.overlaps }).toEqual({ blits: 1, overlaps: 0 });
  });

  it("paints a column from before a session break where the chart draws its bar: two bars before the bar after the break, the break's own slot between, not two hours of pixels to the left", () => {
    const grid = new LiquidityGrid();
    grid.apply(frame(1, -7200, true));
    grid.apply(frame(2, 0, false));
    const host = new FakeHost({ grid, layout: layoutWithGap(grid), settings: FIXED });
    expect(host.layout?.gaps).toEqual([{ start: T - 7_080_000, end: T }]);
    const shot = drawPane(new LiquidityHeatRenderer(host, () => 1_000), PANE);
    // The bar at T opens at x 497; the bar before the hole is two bars earlier, 12 px, the chart's break point between: its column paints at x 485, a second wide at 0.1 px plus the cap.
    const bid = pixelAt(shot, 497, 160);
    expect(bid[3]).toBeGreaterThan(0);
    // The same bid colour (the older run is darker, being two hours old), nothing in the break's slot, nothing further left.
    expect(pixelAt(shot, 485, 160).slice(0, 3)).toEqual(bid.slice(0, 3));
    expect(pixelAt(shot, 485, 160)[3]).toBeGreaterThan(0);
    expect(pixelAt(shot, 491, 160)[3]).toBe(0);
    expect(pixelAt(shot, 478, 160)[3]).toBe(0);
    // Without the hole, the column from two hours before would be 720 px to the left, off the pane.
    expect(paintedPixels(drawPane(new LiquidityHeatRenderer(new FakeHost({ grid, layout: { ...layoutWithGap(grid), gaps: [] }, settings: FIXED }), () => 1_000), PANE))).toBeLessThan(paintedPixels(shot));
  });

  it("paints each wall over its band's rows from its column's x, in its side's colour, at the opacity worked out by hand", () => {
    const host = scene();
    const layout = host.layout!;
    // Bid band 50 is rows 100-101, prices 200..204, so y 160..240; ask band 51 is rows 102-103, y 80..160.
    expect(layout.bands.filter((band) => band.row === 50 || band.row === 51)).toEqual([{ row: 50, yTop: 160, yBottom: 240 }, { row: 51, yTop: 80, yBottom: 160 }]);
    // The only column opens at T, where the last candle opens: x 500 - 6 / 2 = 497, a second being 0.1 px.
    expect([layout.originX, layout.originMs, layout.pxPerMs, layout.tiers[0].columns[0].ts]).toEqual([497, T, 0.0001, T]);
    // Bid 30 + 8 = 38 and ask 20 both reach the saturation of 20, so each fills its band's full height at the
    // opacity cap 0.6 x 255 = 153, times the age factor of a run one second old (0.8 + 0.2 x 1 s / 15 min):
    // 153 x 0.80022 = 122.4, so 122. A resting level's newest column is at least 3 px wide: x 497..499.
    const bid: Rgba = [14, 154, 102, 122];
    const ask: Rgba = [124, 58, 237, 122];
    const expected = new FakeContext(600, 400);
    expected.putImageData(imageOf(3, 80, () => bid), 497, 160);
    expected.putImageData(imageOf(3, 80, () => ask), 497, 80);
    const shot = drawPane(new HeatRendererBeforeRaster(host), PANE);
    expect(pixelAt(shot, 497, 160)).toEqual(bid);
    expect(diffPixels(shot, expected)).toEqual({ count: 0, first: null });
    // At twice the pixel ratio the same walls land on twice the rows, and the 3 px head becomes 6 device px.
    const sharp = new FakeContext(1200, 800);
    sharp.putImageData(imageOf(6, 160, () => bid), 994, 320);
    sharp.putImageData(imageOf(6, 160, () => ask), 994, 160);
    expect(diffPixels(drawPane(new HeatRendererBeforeRaster(scene()), { width: 1200, height: 800, hpr: 2, vpr: 2 }), sharp)).toEqual({ count: 0, first: null });
  });

  it("blits the kept heat again on a frame where nothing changed and paints it afresh when a colour changes (HEAD's W4 cache)", () => {
    const host = scene();
    const renderer = new HeatRendererBeforeRaster(host);
    const first = drawPane(renderer, PANE);
    host.layout = layoutFor(host.grid!);
    const second = drawPane(renderer, PANE);
    expect(host.offscreenContext.counts.puts).toBe(1);
    expect(second.blits).toBe(1);
    expect(diffPixels(first, second)).toEqual({ count: 0, first: null });
    host.bidRgb = { r: 1, g: 2, b: 3 };
    const third = drawPane(renderer, PANE);
    expect(host.offscreenContext.counts.puts).toBe(2);
    expect(colours(third)).toEqual(new Set(["1,2,3", rgbKey(host.askRgb)]));
  });
});
