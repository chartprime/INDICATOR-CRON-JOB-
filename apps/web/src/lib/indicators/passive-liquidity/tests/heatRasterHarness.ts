import type { BitmapCoordinatesRenderingScope, CanvasRenderingTarget2D } from "fancy-canvas";
import type { IPrimitivePaneRenderer } from "lightweight-charts";
import type { LiquidityGrid } from "../liquidityGrid";
import { parseRgb, type HeatmapHost, type Rgb } from "../liquidityHeatmapHost";
import type { HeatmapLayout } from "../liquidityHeatmapLayout";
import { DEFAULT_LIQUIDITY_SETTINGS, type LiquiditySettings } from "../liquiditySettings";
import type { BeforeRasterHost } from "./fixtures/heatRendererBeforeRaster";

// Pixel-accurate stand-ins for the canvases the heat renderer draws through.
// A FakeContext holds straight RGBA and supports only the calls the renderer
// makes; the code under test gets its `context`, a strict view that throws on
// anything else. Tests read the FakeContext itself: its pixels and counters.

export type FakeMethod = "createImageData" | "putImageData" | "clearRect" | "drawImage";

export const FAKE_METHODS: readonly FakeMethod[] = ["createImageData", "putImageData", "clearRect", "drawImage"];

const ARITY: Readonly<Record<FakeMethod, readonly number[]>> = {
  createImageData: [2],
  putImageData: [3],
  clearRect: [4],
  drawImage: [3, 9],
};

/** What test runners and printers read off a value they are handed; answered with undefined rather than a throw. */
const PROBES: ReadonlySet<string> = new Set(["then", "toJSON", "asymmetricMatch", "$$typeof", "nodeType", "@@__IMMUTABLE_ITERABLE__@@", "@@__IMMUTABLE_RECORD__@@"]);

export interface FakeCounts {
  puts: number;
  /** Pixels written by putImageData, after clipping to the canvas. */
  putPixels: number;
  draws: number;
  /** Destination pixels covered by drawImage, after clipping to both canvases. */
  drawPixels: number;
  clears: number;
  /** Source pixels with alpha > 0 that landed on a destination pixel with alpha > 0. */
  overlaps: number;
}

export type Rgba = [r: number, g: number, b: number, alpha: number];

export interface Shot {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface PaneShot extends Shot {
  readonly overlaps: number;
  readonly blits: number;
}

function assertWhole(what: string, ...values: number[]): void {
  for (const value of values) if (!Number.isInteger(value)) throw new Error(`FakeContext.${what}: ${String(value)} is not a whole pixel`);
}

function assertSize(what: string, width: number, height: number, least: number): void {
  assertWhole(what, width, height);
  if (width < least || height < least) throw new Error(`FakeContext.${what}: ${width}x${height} is not a size it takes`);
}

/** A canvas element as far as the renderer reads it: assigning either side reallocates and clears the bitmap, even to the same value. */
export class FakeCanvas {
  private _width = 0;
  private _height = 0;
  private _data = new Uint8ClampedArray(0);

  constructor(width: number, height: number) {
    this._reset(width, height);
  }

  get width(): number {
    return this._width;
  }

  set width(value: number) {
    this._reset(value, this._height);
  }

  get height(): number {
    return this._height;
  }

  set height(value: number) {
    this._reset(this._width, value);
  }

  /** The bitmap: straight RGBA, row by row. */
  get data(): Uint8ClampedArray {
    return this._data;
  }

  private _reset(width: number, height: number): void {
    assertSize("canvas", width, height, 0);
    this._width = width;
    this._height = height;
    this._data = new Uint8ClampedArray(width * height * 4);
  }
}

const owners = new WeakMap<object, FakeContext>();

export class FakeContext implements Shot {
  readonly canvas: FakeCanvas;
  readonly counts: FakeCounts = { puts: 0, putPixels: 0, draws: 0, drawPixels: 0, clears: 0, overlaps: 0 };
  /** The view handed to the code under test: `canvas` and the allowed methods; any other read, call or write throws. */
  readonly context: CanvasRenderingContext2D;

  constructor(width = 0, height = 0, methods: readonly FakeMethod[] = FAKE_METHODS) {
    this.canvas = new FakeCanvas(width, height);
    owners.set(this.canvas, this);
    this.context = strictContext(this, methods);
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  get data(): Uint8ClampedArray {
    return this.canvas.data;
  }

  createImageData(width: number, height: number): ImageData {
    assertSize("createImageData", width, height, 1);
    return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
  }

  /** Replaces the pixels under the image, clipped to the canvas: no compositing. */
  putImageData(image: ImageData, dx: number, dy: number): void {
    assertSize("putImageData", image.width, image.height, 1);
    if (image.data.length !== image.width * image.height * 4) throw new Error(`FakeContext.putImageData: ${image.data.length} bytes for a ${image.width}x${image.height} image`);
    assertWhole("putImageData", dx, dy);
    this.counts.puts += 1;
    const width = this.width;
    const x0 = Math.max(0, dx);
    const y0 = Math.max(0, dy);
    const x1 = Math.min(width, dx + image.width);
    const y1 = Math.min(this.height, dy + image.height);
    if (x1 <= x0 || y1 <= y0) return;
    const data = this.data;
    for (let y = y0; y < y1; y += 1) {
      const from = ((y - dy) * image.width + (x0 - dx)) * 4;
      data.set(image.data.subarray(from, from + (x1 - x0) * 4), (y * width + x0) * 4);
    }
    this.counts.putPixels += (x1 - x0) * (y1 - y0);
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    assertWhole("clearRect", x, y, width, height);
    if (width < 0 || height < 0) throw new Error(`FakeContext.clearRect: ${width}x${height} is not a size it takes`);
    this.counts.clears += 1;
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + width);
    const y1 = Math.min(this.height, y + height);
    if (x1 <= x0 || y1 <= y0) return;
    for (let row = y0; row < y1; row += 1) this.data.fill(0, (row * this.width + x0) * 4, (row * this.width + x1) * 4);
  }

  /**
   * drawImage(source, dx, dy) or the nine-argument form at 1:1, from another
   * FakeContext's canvas. Pieces must never overlap, so instead of blending,
   * every source pixel with alpha > 0 replaces the destination pixel (counted
   * as an overlap when that pixel already had alpha > 0); a transparent source
   * pixel leaves the destination as it is, as source-over would.
   */
  drawImage(source: unknown, ...coords: number[]): void {
    const from = typeof source === "object" && source !== null ? owners.get(source) : undefined;
    if (from === undefined) throw new Error("FakeContext.drawImage: the source is not the canvas of a FakeContext");
    if (from === this) throw new Error("FakeContext.drawImage: a canvas drawn onto itself is not modelled");
    assertWhole("drawImage", ...coords);
    let sx = 0;
    let sy = 0;
    let sw = from.width;
    let sh = from.height;
    let dx: number;
    let dy: number;
    if (coords.length === 2) {
      [dx, dy] = coords;
    } else if (coords.length === 8) {
      let dw: number;
      let dh: number;
      [sx, sy, sw, sh, dx, dy, dw, dh] = coords;
      if (dw !== sw || dh !== sh) throw new Error(`FakeContext.drawImage: ${sw}x${sh} scaled to ${dw}x${dh}; the renderer copies 1:1 only`);
      if (sw < 0 || sh < 0) throw new Error(`FakeContext.drawImage: a ${sw}x${sh} source rectangle`);
    } else {
      throw new Error(`FakeContext.drawImage: ${coords.length + 1} arguments; only (source, dx, dy) and the 1:1 nine-argument form are supported`);
    }
    if (from.width === 0 || from.height === 0) throw new Error("FakeContext.drawImage: the source canvas is empty (a browser throws InvalidStateError)");
    this.counts.draws += 1;
    const shiftX = sx - dx;
    const shiftY = sy - dy;
    const x0 = Math.max(0, dx, -shiftX);
    const y0 = Math.max(0, dy, -shiftY);
    const x1 = Math.min(this.width, dx + sw, from.width - shiftX);
    const y1 = Math.min(this.height, dy + sh, from.height - shiftY);
    if (x1 <= x0 || y1 <= y0) return;
    const src = from.data;
    const dst = this.data;
    for (let y = y0; y < y1; y += 1) {
      let s = ((y + shiftY) * from.width + x0 + shiftX) * 4;
      let d = (y * this.width + x0) * 4;
      for (let x = x0; x < x1; x += 1, s += 4, d += 4) {
        const alpha = src[s + 3];
        if (alpha === 0) continue;
        if (dst[d + 3] > 0) this.counts.overlaps += 1;
        dst[d] = src[s];
        dst[d + 1] = src[s + 1];
        dst[d + 2] = src[s + 2];
        dst[d + 3] = alpha;
      }
    }
    this.counts.drawPixels += (x1 - x0) * (y1 - y0);
  }

  pixel(x: number, y: number): Rgba {
    return pixelAt(this, x, y);
  }

  /** A copy of the pixels as they are now. */
  shot(): Shot {
    return { data: this.data.slice(), width: this.width, height: this.height };
  }

  resetCounts(): void {
    for (const key of Object.keys(this.counts) as (keyof FakeCounts)[]) this.counts[key] = 0;
  }
}

function strictContext(fake: FakeContext, methods: readonly FakeMethod[]): CanvasRenderingContext2D {
  const api: Record<string, unknown> = { canvas: fake.canvas };
  for (const method of methods) {
    api[method] = (...args: unknown[]): unknown => {
      if (!ARITY[method].includes(args.length)) throw new Error(`FakeContext.${method}: the ${args.length}-argument form is not supported`);
      return Reflect.apply(fake[method], fake, args);
    };
  }
  return new Proxy(api, {
    get(target, property, receiver) {
      if (typeof property === "symbol" || property in target) return Reflect.get(target, property, receiver);
      if (PROBES.has(property)) return undefined;
      throw new Error(`FakeContext: ${property} is not supported`);
    },
    set(_target, property) {
      throw new Error(`FakeContext: setting ${String(property)} is not supported`);
    },
  }) as unknown as CanvasRenderingContext2D;
}

export interface FakeHostScene {
  grid?: LiquidityGrid | null;
  layout?: HeatmapLayout | null;
  settings?: LiquiditySettings;
  bidRgb?: Rgb;
  askRgb?: Rgb;
}

/**
 * The renderer's host with fake canvases: two raster slots and one offscreen
 * canvas, each resized (and so cleared) only when asked for another size, and
 * an image buffer reused, cleared, while its size holds, exactly as
 * LiquidityHeatmapPrimitive does it. The colours default to the settings'.
 */
export class FakeHost implements HeatmapHost, BeforeRasterHost {
  grid: LiquidityGrid | null;
  layout: HeatmapLayout | null;
  settings: LiquiditySettings;
  bidRgb: Rgb;
  askRgb: Rgb;
  readonly rasters: readonly [FakeContext, FakeContext] = [new FakeContext(), new FakeContext()];
  readonly offscreenContext: FakeContext = new FakeContext(0, 0, ["putImageData"]);
  /** Every delay passed to scheduleRepaint, in order. */
  readonly scheduled: number[] = [];
  private _image: ImageData | null = null;

  constructor(scene: FakeHostScene = {}) {
    this.grid = scene.grid ?? null;
    this.layout = scene.layout ?? null;
    this.settings = scene.settings ?? { ...DEFAULT_LIQUIDITY_SETTINGS };
    this.bidRgb = scene.bidRgb ?? parseRgb(this.settings.bidColor, DEFAULT_LIQUIDITY_SETTINGS.bidColor);
    this.askRgb = scene.askRgb ?? parseRgb(this.settings.askColor, DEFAULT_LIQUIDITY_SETTINGS.askColor);
  }

  imageBuffer(width: number, height: number): ImageData | null {
    const offscreen = this.offscreen(width, height);
    if (!offscreen) return null;
    if (this._image && this._image.width === width && this._image.height === height) {
      this._image.data.fill(0);
      return this._image;
    }
    this._image = this.offscreenContext.createImageData(width, height);
    return this._image;
  }

  offscreen(width: number, height: number): CanvasRenderingContext2D | null {
    return sized(this.offscreenContext, width, height);
  }

  raster(slot: 0 | 1, width: number, height: number): CanvasRenderingContext2D | null {
    const fake = this.rasters[slot];
    if (fake === undefined) throw new Error(`FakeHost.raster: there is no slot ${String(slot)}`);
    return sized(fake, width, height);
  }

  scheduleRepaint(delayMs: number): void {
    this.scheduled.push(delayMs);
  }

  /** Zero the counters of both rasters and the offscreen canvas. */
  resetCounts(): void {
    for (const fake of [...this.rasters, this.offscreenContext]) fake.resetCounts();
  }
}

function sized(fake: FakeContext, width: number, height: number): CanvasRenderingContext2D {
  const canvas = fake.canvas;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return fake.context;
}

export interface PaneSize {
  width: number;
  height: number;
  hpr: number;
  vpr: number;
}

/** One frame of the renderer onto a fresh, cleared pane of `width` x `height` device pixels that takes drawImage only. */
export function drawPane(renderer: Pick<IPrimitivePaneRenderer, "draw">, { width, height, hpr, vpr }: PaneSize): PaneShot {
  const pane = new FakeContext(width, height, ["drawImage"]);
  const scope = {
    context: pane.context,
    bitmapSize: { width, height },
    horizontalPixelRatio: hpr,
    verticalPixelRatio: vpr,
    mediaSize: { width: width / hpr, height: height / vpr },
  } as unknown as BitmapCoordinatesRenderingScope;
  const target = {
    useBitmapCoordinateSpace: <T>(paint: (bitmap: BitmapCoordinatesRenderingScope) => T): T => paint(scope),
    useMediaCoordinateSpace: (): never => {
      throw new Error("drawPane: the heat is painted in bitmap space only");
    },
  };
  renderer.draw(target as unknown as CanvasRenderingTarget2D);
  return { data: pane.data, width, height, overlaps: pane.counts.overlaps, blits: pane.counts.draws };
}

function assertShot(shot: Shot): void {
  if (shot.data.length !== shot.width * shot.height * 4) throw new Error(`a ${shot.width}x${shot.height} shot holds ${shot.data.length} bytes`);
}

export function pixelAt(shot: Shot, x: number, y: number): Rgba {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= shot.width || y >= shot.height) {
    throw new Error(`pixelAt: (${x}, ${y}) is outside a ${shot.width}x${shot.height} shot`);
  }
  const i = (y * shot.width + x) * 4;
  return [shot.data[i], shot.data[i + 1], shot.data[i + 2], shot.data[i + 3]];
}

export interface PixelDiff {
  count: number;
  /** The first differing pixel in row order (top row first, left to right). */
  first: null | { x: number; y: number; a: Rgba; b: Rgba };
}

/** The pixels where two shots of one size differ, leaving out the first `left` and the last `right` columns. */
export function diffPixels(a: Shot, b: Shot, { left = 0, right = 0 }: { left?: number; right?: number } = {}): PixelDiff {
  assertShot(a);
  assertShot(b);
  if (a.width !== b.width || a.height !== b.height) throw new Error(`diffPixels: a ${a.width}x${a.height} shot against a ${b.width}x${b.height} one`);
  let count = 0;
  let first: PixelDiff["first"] = null;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = left; x < a.width - right; x += 1) {
      const i = (y * a.width + x) * 4;
      if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2] && a.data[i + 3] === b.data[i + 3]) continue;
      count += 1;
      if (first === null) first = { x, y, a: pixelAt(a, x, y), b: pixelAt(b, x, y) };
    }
  }
  return { count, first };
}

/** Pixels with alpha > 0. */
export function paintedPixels(shot: Shot): number {
  assertShot(shot);
  let count = 0;
  for (let i = 3; i < shot.data.length; i += 4) if (shot.data[i] > 0) count += 1;
  return count;
}

/** Every "r,g,b" a pixel with alpha > 0 holds. */
export function colours(shot: Shot): Set<string> {
  assertShot(shot);
  const found = new Set<string>();
  for (let i = 0; i < shot.data.length; i += 4) if (shot.data[i + 3] > 0) found.add(`${shot.data[i]},${shot.data[i + 1]},${shot.data[i + 2]}`);
  return found;
}

/** The "r,g,b" key `colours` uses for a colour. */
export function rgbKey(rgb: Rgb): string {
  return `${rgb.r},${rgb.g},${rgb.b}`;
}
