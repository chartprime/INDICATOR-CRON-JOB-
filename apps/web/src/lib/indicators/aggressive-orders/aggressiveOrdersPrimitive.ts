import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { ChartRowsProvider } from "../../chart/chartData";
import type { AggressiveTape } from "./aggressiveTape";
import { AggressiveOrdersRenderer, bubbleAt, layoutBubbles, type AggressiveBubble, type AggressiveOrdersHost, type BubblePalette } from "./aggressiveOrdersRenderer";
import type { BubbleHover } from "./aggressiveOrdersHover";
import { DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, clusterRulesFor, sizeReferenceFor, visibleOrders, type AggressiveOrdersSettings } from "./aggressiveOrdersSettings";
import type { ClusterRules } from "./aggressiveTape";

export const REPAINT_MIN_INTERVAL_MS = 66;
const DEFAULT_BAR_INTERVAL_SEC = 60;
const INTERVAL_SAMPLE_BARS = 8;

/**
 * The x of a moment: inside the candle the chart holds it in, as far along the candle's own slot as the moment is
 * along the candle; a moment in a session break sits at the right edge of the candle before it, where the chart
 * gives the break its one bar of room; one before the first candle has no place. The chart's time axis is not time
 * (a break of an hour is one bar wide), so a line from the last candle put every bubble before a break a hole's
 * width off its candle on NQ.
 */
export function candleX(bars: readonly { time: unknown }[], ms: number, intervalMs: number, barSpacing: number, centerOf: (time: Time) => number | null): number | null {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(bars[mid].time) * 1000 <= ms) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return null;
  const bar = bars[lo - 1];
  const open = Number(bar.time) * 1000;
  const center = centerOf(bar.time as Time);
  if (center === null || !Number.isFinite(open) || !(intervalMs > 0)) return null;
  const along = Math.min(1, (ms - open) / intervalMs);
  return Number(center) + (along - 0.5) * barSpacing;
}

class AggressiveOrdersPaneView implements IPrimitivePaneView {
  private readonly _renderer: IPrimitivePaneRenderer;

  constructor(renderer: IPrimitivePaneRenderer) {
    this._renderer = renderer;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this._renderer;
  }
}

export class AggressiveOrdersPrimitive implements ISeriesPrimitive<Time>, AggressiveOrdersHost {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _settings: AggressiveOrdersSettings = { ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS };
  private _tape: AggressiveTape | null = null;
  private _rules: ClusterRules | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _frame: number | null = null;
  private _frameKind: "raf" | "timer" | null = null;
  private _lastPaintAt = -Infinity;
  private _pulseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  readonly palette: BubblePalette;
  bubbles: readonly AggressiveBubble[] = [];
  floor = 0;

  private readonly _rows: ChartRowsProvider | null;

  constructor(palette: BubblePalette, rows: ChartRowsProvider | null = null) {
    this.palette = palette;
    this._rows = rows;
    this._paneViews = [new AggressiveOrdersPaneView(new AggressiveOrdersRenderer(this))];
  }

  get settings(): AggressiveOrdersSettings {
    return this._settings;
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    if (this._pulseTimer !== null) clearTimeout(this._pulseTimer);
    this._pulseTimer = null;
    this.setTape(null);
    this._cancelScheduledUpdate();
    this.bubbles = [];
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  bubbleAt(x: number, y: number): BubbleHover | null {
    const bubble = bubbleAt(this.bubbles, x, y);
    return bubble ? { side: bubble.side, volume: bubble.volume, price: bubble.price, ts: bubble.ts, count: bubble.count } : null;
  }

  setTape(tape: AggressiveTape | null): void {
    if (tape === this._tape) return;
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._tape = tape;
    if (tape) this._unsubscribe = tape.subscribe(() => this._schedule());
    this._schedule();
  }

  setSettings(settings: AggressiveOrdersSettings): void {
    this._settings = settings;
    this._schedule();
  }

  setRules(rules: ClusterRules | null): void {
    this._rules = rules;
    this._schedule();
  }

  private _schedule(): void {
    if (this._frame !== null) return;
    const hasAnimationFrame = typeof requestAnimationFrame === "function";
    const raf = hasAnimationFrame
      ? requestAnimationFrame
      : (callback: () => void) => setTimeout(callback, 16) as unknown as number;
    const paint = () => {
      this._frame = raf(() => {
        this._frame = null;
        this._frameKind = null;
        this._lastPaintAt = Date.now();
        this._requestUpdate?.();
      });
      this._frameKind = hasAnimationFrame ? "raf" : "timer";
    };
    const wait = REPAINT_MIN_INTERVAL_MS - (Date.now() - this._lastPaintAt);
    if (wait <= 0) paint();
    else {
      this._frame = setTimeout(paint, wait) as unknown as number;
      this._frameKind = "timer";
    }
  }

  private _cancelScheduledUpdate(): void {
    if (this._frame === null || this._frameKind === null) return;
    if (this._frameKind === "raf") cancelAnimationFrame(this._frame);
    else clearTimeout(this._frame);
    this._frame = null;
    this._frameKind = null;
  }

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    const tape = this._tape;
    this.bubbles = [];
    if (!chart || !series || !tape) return;
    const bars = this._rows?.() ?? series.data();
    if (bars.length === 0) return;
    const last = bars[bars.length - 1];
    const lastSec = Number(last.time);
    if (!Number.isFinite(lastSec)) return;
    let intervalSec = Infinity;
    for (let i = bars.length - 1; i > 0 && i > bars.length - 1 - INTERVAL_SAMPLE_BARS; i -= 1) {
      const gap = Number(bars[i].time) - Number(bars[i - 1].time);
      if (Number.isFinite(gap) && gap > 0 && gap < intervalSec) intervalSec = gap;
    }
    if (!Number.isFinite(intervalSec)) intervalSec = DEFAULT_BAR_INTERVAL_SEC;
    const timeScale = chart.timeScale();
    const barSpacing = timeScale.options().barSpacing;
    if (!(barSpacing > 0)) return;
    const intervalMs = intervalSec * 1000;
    const height = chart.paneSize().height;
    const width = timeScale.width();
    if (!(height > 0) || !(width > 0)) return;
    const now = tape.clockMs();
    const rules = this._rules ?? clusterRulesFor(this._settings);
    this.floor = tape.floor(rules.minVolume, now);
    const visible = timeScale.getVisibleRange();
    const fromMs = (visible === null ? Number(bars[0].time) : Number(visible.from)) * 1000 - intervalMs;
    const toMs = (visible === null ? lastSec : Number(visible.to)) * 1000 + 2 * intervalMs;
    const orders = visibleOrders(tape.bubbles(rules, now, fromMs, toMs), this._settings);
    const reference = sizeReferenceFor(this._settings, tape.autoFloor(now));
    this.bubbles = layoutBubbles(orders, reference, this._settings, {
      xOf: (ms) => candleX(bars, ms, intervalMs, barSpacing, (time) => timeScale.timeToCoordinate(time)),
      yOf: (price) => {
        const y = series.priceToCoordinate(price);
        return y === null ? null : Number(y);
      },
      width,
      height,
      link: rules.bucketMs > 0 ? { bucketMs: rules.bucketMs, offsetPx: Math.min(barSpacing * 0.22, 14) } : null,
    }, now);
    if (!tape.historical && this._pulseTimer === null && this.bubbles.some((bubble) => bubble.pulse > 0)) {
      this._pulseTimer = setTimeout(() => {
        this._pulseTimer = null;
        this._schedule();
      }, 1000 / 30);
    }
  }
}
