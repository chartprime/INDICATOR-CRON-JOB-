import { HistogramSeries, LineStyle, type HistogramData, type IChartApi, type IPaneApi, type ISeriesApi, type Time, type UTCTimestamp, type WhitespaceData } from "lightweight-charts";
import type { BarFrame } from "../../../types/frames";
import { withAlpha } from "../axis-profile/axisProfileLayout";
import type { CandleDelta } from "./aggressiveProfileReader";
import type { AggressiveProfileSettings, ProfileView } from "./aggressiveProfileSettings";
import type { VisibleRange } from "./aggressiveProfileSource";
import { PaneTagPrimitive } from "./paneTagPrimitive";
import type { LivePrint } from "./rangePrintStore";

export const PANE_LABEL = "Aggressive Orders Profile";

export const ZERO_LINE_LIGHT = "rgba(10, 10, 10, 0.55)";
export const ZERO_LINE_DARK = "rgba(250, 250, 247, 0.32)";

export const LIVE_EASE_MS = 150;
export const LIVE_PULSE_MS = 300;
export const LIVE_PULSE_LIGHTEN = 0.45;
export const DIM_ALPHA = 0.45;

export type HistogramPoint = HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;

export type PaneLook = Pick<AggressiveProfileSettings, "buyColor" | "sellColor" | "profileView" | "outlierFrom">;

export interface PanePoints {
  main: HistogramPoint[];
  sells: HistogramPoint[];
  threshold: number | null;
}

interface LiveBar {
  read: readonly CandleDelta[];
  tsOpen: number;
  closeTs: number;
  time: UTCTimestamp;
  baseBuy: number;
  baseSell: number;
  extraBuy: number;
  extraSell: number;
  hasPrints: boolean;
  fromBuy: number;
  fromSell: number;
  at: number;
  pulseAt: number;
}

const NO_POINTS: PanePoints = { main: [], sells: [], threshold: null };

function printed(candle: CandleDelta | undefined): candle is CandleDelta {
  return candle !== undefined && candle.buyCount + candle.sellCount > 0;
}

export function outlierThreshold(candles: readonly CandleDelta[], view: ProfileView, outlierFrom: number): number | null {
  if (!(outlierFrom > 0)) return null;
  const sizes: number[] = [];
  for (const candle of candles) {
    if (!printed(candle)) continue;
    if (view === "delta") sizes.push(Math.abs(candle.delta));
    else {
      if (candle.buyVolume > 0) sizes.push(candle.buyVolume);
      if (candle.sellVolume > 0) sizes.push(candle.sellVolume);
    }
  }
  if (sizes.length === 0) return null;
  return (sizes.reduce((sum, size) => sum + size, 0) / sizes.length) * outlierFrom;
}

export function barColour(colour: string, size: number, threshold: number | null): string {
  return threshold === null || size >= threshold ? colour : withAlpha(colour, DIM_ALPHA);
}

export function panePoints(candles: readonly CandleDelta[], bars: readonly BarFrame[], range: Pick<VisibleRange, "fromTs" | "toTs"> | null, look: PaneLook): PanePoints {
  if (range === null) return NO_POINTS;
  const byTs = new Map<number, CandleDelta>();
  for (const candle of candles) byTs.set(candle.tsOpen, candle);
  const visible = bars.filter((bar) => bar.ts_open < range.toTs && bar.ts_open + bar.interval_ms > range.fromTs);
  const shown = visible.map((bar) => byTs.get(bar.ts_open)).filter(printed);
  const threshold = outlierThreshold(shown, look.profileView, look.outlierFrom);
  const main: HistogramPoint[] = [];
  const sells: HistogramPoint[] = [];
  for (const bar of visible) {
    const time = (bar.ts_open / 1000) as UTCTimestamp;
    const candle = byTs.get(bar.ts_open);
    if (!printed(candle)) {
      main.push({ time });
      if (look.profileView === "sides") sells.push({ time });
      continue;
    }
    if (look.profileView === "delta") {
      main.push({ time, value: candle.delta, color: barColour(candle.delta < 0 ? look.sellColor : look.buyColor, Math.abs(candle.delta), threshold) });
    } else {
      main.push({ time, value: candle.buyVolume, color: barColour(look.buyColor, candle.buyVolume, threshold) });
      sells.push({ time, value: 0 - candle.sellVolume, color: barColour(look.sellColor, candle.sellVolume, threshold) });
    }
  }
  return { main, sells, threshold };
}

export function tweened(from: number, target: number, at: number, now: number): number {
  const share = Math.max(0, (now - at) / LIVE_EASE_MS);
  return share >= 1 ? target : from + (target - from) * share;
}

export function pulseAt(pulsedAt: number, now: number): number {
  return Math.max(0, 1 - (now - pulsedAt) / LIVE_PULSE_MS);
}

export function lighten(color: string, amount: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i.exec(color.trim());
  let parts: [number, number, number];
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    parts = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  } else if (rgb) parts = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  else return color;
  const mixed = parts.map((part) => Math.round(part + (255 - part) * Math.min(1, Math.max(0, amount))));
  const alpha = rgb?.[4];
  return alpha === undefined ? `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})` : `rgba(${mixed[0]}, ${mixed[1]}, ${mixed[2]}, ${alpha})`;
}

export class AggressiveProfilePane {
  private readonly _chart: IChartApi;
  private readonly _dark: boolean;
  private _main: ISeriesApi<"Histogram"> | null = null;
  private _sells: ISeriesApi<"Histogram"> | null = null;
  private _tag: PaneTagPrimitive | null = null;
  private _tagHost: IPaneApi<Time> | null = null;
  private _look: PaneLook | null = null;
  private _threshold: number | null = null;
  private _live: LiveBar | null = null;
  private _frame: number | null = null;

  constructor({ chart, dark }: { chart: IChartApi; dark: boolean }) {
    this._chart = chart;
    this._dark = dark;
  }

  get attached(): boolean {
    return this._main !== null;
  }

  get liveCandle(): number | null {
    return this._live?.tsOpen ?? null;
  }

  get tagHost(): IPaneApi<Time> | null {
    return this._tagHost;
  }

  attach(): void {
    if (this._main !== null) return;
    const paneIndex = this._chart.panes().length;
    const bars = { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "volume" as const } };
    const main = this._chart.addSeries(HistogramSeries, bars, paneIndex);
    const sells = this._chart.addSeries(HistogramSeries, bars, paneIndex);
    main.createPriceLine({
      price: 0,
      color: this._dark ? ZERO_LINE_DARK : ZERO_LINE_LIGHT,
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
    });
    this._main = main;
    this._sells = sells;
    this._tag = new PaneTagPrimitive(PANE_LABEL, this._dark, this._chart.options().layout.fontFamily);
    this.placeTag();
  }

  detach(): void {
    this._stopFrames();
    this._live = null;
    if (this._main === null) return;
    if (this._tag !== null) this._tagHost?.detachPrimitive(this._tag);
    this._tagHost = null;
    this._tag = null;
    if (this._sells !== null) this._chart.removeSeries(this._sells);
    this._chart.removeSeries(this._main);
    this._main = null;
    this._sells = null;
  }

  render(candles: readonly CandleDelta[], bars: readonly BarFrame[], range: Pick<VisibleRange, "fromTs" | "toTs" | "open"> | null, look: PaneLook): void {
    if (this._main === null) return;
    this.placeTag();
    this._look = look;
    const points = panePoints(candles, bars, range, look);
    this._main.setData(points.main);
    this._sells?.setData(points.sells);
    this._threshold = points.threshold;
    this._setLiveCandle(candles, bars, range, Date.now());
  }

  pushLive(print: LivePrint): void {
    const live = this._live;
    if (live === null || this._main === null || print.ts < live.tsOpen || print.ts >= live.closeTs) return;
    const now = Date.now();
    live.fromBuy = this._shownBuy(live, now);
    live.fromSell = this._shownSell(live, now);
    live.at = now;
    live.pulseAt = now;
    if (print.buy) live.extraBuy += print.size;
    else live.extraSell += print.size;
    live.hasPrints = true;
    this._startFrames();
  }

  tick(now: number = Date.now()): boolean {
    const live = this._live;
    const main = this._main;
    const look = this._look;
    if (live === null || main === null || look === null || !live.hasPrints) return false;
    const buy = this._shownBuy(live, now);
    const sell = this._shownSell(live, now);
    const pulse = pulseAt(live.pulseAt, now);
    const glow = (colour: string) => (pulse > 0 ? lighten(colour, LIVE_PULSE_LIGHTEN * pulse) : colour);
    if (look.profileView === "delta") {
      const delta = buy - sell;
      main.update({ time: live.time, value: delta, color: glow(barColour(delta < 0 ? look.sellColor : look.buyColor, Math.abs(delta), this._threshold)) });
    } else {
      main.update({ time: live.time, value: buy, color: glow(barColour(look.buyColor, buy, this._threshold)) });
      if (this._live === live) this._sells?.update({ time: live.time, value: 0 - sell, color: glow(barColour(look.sellColor, sell, this._threshold)) });
    }
    return buy !== live.baseBuy + live.extraBuy || sell !== live.baseSell + live.extraSell || pulse > 0;
  }

  placeTag(): void {
    const main = this._main;
    const tag = this._tag;
    if (main === null || tag === null) return;
    const above = this._chart.panes()[main.getPane().paneIndex() - 1] ?? null;
    if (above === this._tagHost) return;
    this._tagHost?.detachPrimitive(tag);
    above?.attachPrimitive(tag);
    this._tagHost = above;
  }

  private _shownBuy(live: LiveBar, now: number): number {
    return tweened(live.fromBuy, live.baseBuy + live.extraBuy, live.at, now);
  }

  private _shownSell(live: LiveBar, now: number): number {
    return tweened(live.fromSell, live.baseSell + live.extraSell, live.at, now);
  }

  private _setLiveCandle(candles: readonly CandleDelta[], bars: readonly BarFrame[], range: Pick<VisibleRange, "fromTs" | "toTs" | "open"> | null, now: number): void {
    const last = bars[bars.length - 1];
    if (range === null || !range.open || last === undefined || last.ts_open >= range.toTs) {
      this._live = null;
      this._stopFrames();
      return;
    }
    const candle = candles.find((entry) => entry.tsOpen === last.ts_open);
    const baseBuy = candle?.buyVolume ?? 0;
    const baseSell = candle?.sellVolume ?? 0;
    const hasPrints = printed(candle);
    const held = this._live;
    if (held !== null && held.tsOpen === last.ts_open) {
      if (held.read === candles) {
        if (held.hasPrints) this._startFrames();
        return;
      }
      held.read = candles;
      held.fromBuy = this._shownBuy(held, now);
      held.fromSell = this._shownSell(held, now);
      held.at = now;
      held.baseBuy = baseBuy;
      held.baseSell = baseSell;
      held.extraBuy = 0;
      held.extraSell = 0;
      held.hasPrints = hasPrints;
      if (held.fromBuy !== baseBuy || held.fromSell !== baseSell) this._startFrames();
      return;
    }
    this._stopFrames();
    this._live = { read: candles, tsOpen: last.ts_open, closeTs: last.ts_open + last.interval_ms, time: (last.ts_open / 1000) as UTCTimestamp, baseBuy, baseSell, extraBuy: 0, extraSell: 0, hasPrints, fromBuy: baseBuy, fromSell: baseSell, at: now, pulseAt: -Infinity };
  }

  private _startFrames(): void {
    if (this._frame !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      this.tick();
      return;
    }
    const frame = () => {
      this._frame = this.tick() ? requestAnimationFrame(frame) : null;
    };
    this._frame = requestAnimationFrame(frame);
  }

  private _stopFrames(): void {
    if (this._frame === null) return;
    cancelAnimationFrame(this._frame);
    this._frame = null;
  }
}
