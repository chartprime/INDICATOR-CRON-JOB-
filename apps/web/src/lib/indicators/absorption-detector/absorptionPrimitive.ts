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
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { ChartRowsProvider } from "../../chart/chartData";
import type { LiquidityGrid } from "../passive-liquidity/liquidityGrid";
import { css, sphereTones, type Rgb } from "../aggressive-orders/aggressiveOrdersRenderer";
import { parseRgb } from "../passive-liquidity/liquidityHeatmapHost";
import { DEFAULT_LIQUIDITY_SETTINGS, historyDaysLabel } from "../passive-liquidity/liquiditySettings";
import { STATUS_BADGE_SLOT, drawStatusBadge } from "../../chart/statusBadge";
import type { BarClose } from "../institutional-order-blocks-v2/bandTracker";
import { AbsorptionTracker, absorptionWallsKey, readPrint, type AbsorptionPrint, type AbsorptionRecord, type AbsorptionRules, type ColumnFeed, type ColumnTier } from "./absorptionEngine";
import { DEFAULT_ABSORPTION_SETTINGS, absorptionBubbleScaleOf, absorptionColorOf, absorptionHistoryDaysOf, absorptionShapeOf, type AbsorptionHistoryDays, type AbsorptionSettings, type AbsorptionShape } from "./absorptionSettings";
import type { AbsorptionHistory, AbsorptionHistoryStatus, HistoryBars } from "./absorptionHistory";
import { describeAbsorptionSphere, type AbsorptionHover } from "./absorptionHover";
import { AbsorptionStore } from "./absorptionStore";
import { mergePrints, mergedAlpha, withoutBroken, type MergedSphere } from "./absorptionMerge";

export { BASE_ALPHA, PENDING_ALPHA, REFILL_ALPHA_STEP, SECOND_SPHERE_ALPHA, printAlpha } from "./absorptionMerge";

const DEFAULT_BAR_INTERVAL_SEC = 60;
const INTERVAL_SAMPLE_BARS = 8;
const RECOMPUTE_MIN_INTERVAL_MS = 250;
const REPAINT_MIN_INTERVAL_MS = 100;

/** A live record and a history record of the same side and band whose attacks began this close in time are one attack: the history's is shown. */
export const LIVE_HISTORY_TWIN_MS = 120_000;

export const ABSORPTION_BID_FILL = parseRgb(DEFAULT_LIQUIDITY_SETTINGS.bidColor, DEFAULT_LIQUIDITY_SETTINGS.bidColor);
export const ABSORPTION_ASK_FILL = parseRgb(DEFAULT_LIQUIDITY_SETTINGS.askColor, DEFAULT_LIQUIDITY_SETTINGS.askColor);

export function absorptionFillFor(side: "bid" | "ask", settings: AbsorptionSettings = DEFAULT_ABSORPTION_SETTINGS): Rgb {
  const fallback = side === "bid" ? ABSORPTION_BID_FILL : ABSORPTION_ASK_FILL;
  const chosen = absorptionColorOf(settings, side);
  return chosen === (side === "bid" ? DEFAULT_LIQUIDITY_SETTINGS.bidColor : DEFAULT_LIQUIDITY_SETTINGS.askColor) ? fallback : parseRgb(chosen, chosen);
}

export interface AbsorptionBubble {
  x: number;
  y: number;
  r: number;
  alpha: number;
  pending: boolean;
  broken: boolean;
  sphere: MergedSphere;
}

export const ABSORPTION_BUBBLE_MIN_PX = 8;
export const ABSORPTION_BUBBLE_MAX_PX = 30;
/** The absorbed size, as a multiple of the book's typical level, that draws the largest sphere. */
export const ABSORPTION_RADIUS_FULL_MULTIPLE = 200;

export function absorptionRadius(absorbed: number, yardstick: number, scale: number): number {
  const share = yardstick > 0 ? Math.min(1, Math.max(0, absorbed / (yardstick * ABSORPTION_RADIUS_FULL_MULTIPLE))) : 1;
  return (ABSORPTION_BUBBLE_MIN_PX + (ABSORPTION_BUBBLE_MAX_PX - ABSORPTION_BUBBLE_MIN_PX) * Math.sqrt(share)) * scale;
}

export function layoutAbsorption(
  prints: readonly AbsorptionPrint[],
  scale: number,
  geometry: { xOf: (ms: number) => number | null; yOf: (price: number) => number | null; width: number; height: number },
  intervalMs = 0,
  bucketOf?: (ts: number) => number | null,
): AbsorptionBubble[] {
  const bubbles: AbsorptionBubble[] = [];
  for (const sphere of mergePrints(prints, intervalMs, bucketOf)) {
    const y = geometry.yOf(sphere.price);
    if (y === null) continue;
    const x = geometry.xOf(sphere.ts);
    if (x === null) continue;
    const r = absorptionRadius(sphere.absorbed, sphere.yardstick, scale);
    if (x + r < 0 || x - r > geometry.width || y + r < 0 || y - r > geometry.height) continue;
    bubbles.push({ x, y, r, alpha: mergedAlpha(sphere), pending: sphere.pending, broken: sphere.broken, sphere });
  }
  bubbles.sort((a, b) => a.r - b.r);
  return bubbles;
}

export function chartCandleOpen(bars: readonly { time: unknown }[], ts: number, intervalMs: number): number | null {
  if (!(intervalMs > 0) || !Number.isFinite(ts)) return null;
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(bars[mid].time) * 1000 <= ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return null;
  const open = Number(bars[lo - 1].time) * 1000;
  return Number.isFinite(open) && ts < open + intervalMs ? open : null;
}

export function barIntervalSecOf(bars: readonly { time: unknown }[]): number {
  let intervalSec = Infinity;
  for (let i = bars.length - 1; i > 0 && i > bars.length - 1 - INTERVAL_SAMPLE_BARS; i -= 1) {
    const gap = Number(bars[i].time) - Number(bars[i - 1].time);
    if (Number.isFinite(gap) && gap > 0 && gap < intervalSec) intervalSec = gap;
  }
  return Number.isFinite(intervalSec) ? intervalSec : DEFAULT_BAR_INTERVAL_SEC;
}

export function barCloses(bars: readonly { time: unknown; close?: unknown }[], rowWidth: number): BarClose[] {
  if (bars.length < 2 || !(rowWidth > 0)) return [];
  const intervalSec = barIntervalSecOf(bars);
  const closes: BarClose[] = [];
  for (let i = 0; i < bars.length - 1; i += 1) {
    const bar = bars[i];
    const time = Number(bar.time);
    const close = Number(bar.close);
    if (!Number.isFinite(time) || !Number.isFinite(close)) continue;
    closes.push({ ts: (time + intervalSec) * 1000, row: Math.floor(close / rowWidth) });
  }
  return closes;
}

/** "PRIME ABSORPTION · LOADING 1 DAY" while the chosen reach is on its way; "HISTORY UNAVAILABLE" when the host refuses it; nothing once it is drawn. */
export function absorptionStatusText(status: AbsorptionHistoryStatus | null, days: AbsorptionHistoryDays): string | null {
  if (status === null || days === 0) return null;
  if (status.loading) return `PRIME ABSORPTION · LOADING ${historyDaysLabel(days).toUpperCase()}`;
  if (status.unavailable !== null && status.reachTs === null) return "PRIME ABSORPTION · HISTORY UNAVAILABLE";
  return null;
}

class AbsorptionStatusRenderer implements IPrimitivePaneRenderer {
  private readonly _host: { history: AbsorptionHistory | null; settings: AbsorptionSettings };
  constructor(host: { history: AbsorptionHistory | null; settings: AbsorptionSettings }) {
    this._host = host;
  }
  draw(target: CanvasRenderingTarget2D): void {
    const text = absorptionStatusText(this._host.history?.status() ?? null, absorptionHistoryDaysOf(this._host.settings));
    if (text === null) return;
    target.useMediaCoordinateSpace(({ context }) => drawStatusBadge(context, STATUS_BADGE_SLOT.absorption, text));
  }
}

class AbsorptionPaneView implements IPrimitivePaneView {
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

/** The mark's outline on the path: a circle, a triangle pointing up on a bid wall and down on an ask wall, or a square, each the mark's size. */
export function traceMark(context: Pick<CanvasRenderingContext2D, "arc" | "moveTo" | "lineTo" | "rect" | "closePath">, shape: AbsorptionShape, x: number, y: number, r: number, side: "bid" | "ask"): void {
  if (shape === "square") {
    context.rect(x - r, y - r, 2 * r, 2 * r);
    return;
  }
  if (shape === "triangle") {
    const apex = side === "bid" ? -1 : 1;
    context.moveTo(x, y + apex * r);
    context.lineTo(x + r, y - apex * r);
    context.lineTo(x - r, y - apex * r);
    context.closePath();
    return;
  }
  context.arc(x, y, r, 0, Math.PI * 2);
}

class AbsorptionRenderer implements IPrimitivePaneRenderer {
  private readonly _host: { bubbles: readonly AbsorptionBubble[]; settings: AbsorptionSettings };
  constructor(host: { bubbles: readonly AbsorptionBubble[]; settings: AbsorptionSettings }) {
    this._host = host;
  }
  draw(target: CanvasRenderingTarget2D): void {
    const { bubbles, settings } = this._host;
    if (bubbles.length === 0) return;
    const opacity = Math.min(1, Math.max(0, settings.opacity));
    const tones = { bid: sphereTones(absorptionFillFor("bid", settings)), ask: sphereTones(absorptionFillFor("ask", settings)) };
    const shape = absorptionShapeOf(settings);
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      try {
        for (const bubble of bubbles) {
          const alpha = bubble.alpha * opacity;
          const tone = tones[bubble.sphere.side];
          context.beginPath();
          traceMark(context, shape, bubble.x, bubble.y, bubble.r, bubble.sphere.side);
          if (bubble.pending) {
            context.strokeStyle = css(tone.body, Math.min(1, alpha + 0.3));
            context.lineWidth = 1.5;
            context.setLineDash([3, 3]);
            context.stroke();
            context.setLineDash([]);
            continue;
          }
          if (bubble.broken) {
            context.strokeStyle = css(tone.body, Math.min(1, alpha + 0.3));
            context.lineWidth = 1.5;
            context.stroke();
            continue;
          }
          const gradient = context.createRadialGradient(bubble.x - bubble.r * 0.35, bubble.y - bubble.r * 0.35, bubble.r * 0.05, bubble.x, bubble.y, bubble.r);
          gradient.addColorStop(0, css(tone.highlight, alpha));
          gradient.addColorStop(0.55, css(tone.body, alpha));
          gradient.addColorStop(1, css(tone.rim, alpha));
          context.fillStyle = gradient;
          context.fill();
          context.strokeStyle = css(tone.rim, Math.min(1, alpha + 0.2));
          context.lineWidth = 1;
          context.stroke();
        }
      } finally {
        context.restore();
      }
    });
  }
}

export class AbsorptionPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _settings: AbsorptionSettings = { ...DEFAULT_ABSORPTION_SETTINGS };
  private _rules: AbsorptionRules | null = null;
  private _grid: LiquidityGrid | null = null;
  private _frame: number | null = null;
  private _frameKind: "raf" | "timer" | null = null;
  private _tracker = new AbsorptionTracker();
  private _history: AbsorptionHistory | null = null;
  private _historyUnsubscribe: (() => void) | null = null;
  private readonly _store: AbsorptionStore;
  private _kept: readonly AbsorptionRecord[] = [];
  private _walls = "";
  private _shownFrom = -Infinity;
  private _closes: { count: number; lastTime: number; rowWidth: number; closes: BarClose[]; bars: HistoryBars } | null = null;
  private _computedAt = -Infinity;
  private _lastPaintAt = -Infinity;
  private _dirty = true;
  private _recomputeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _paneViews: readonly IPrimitivePaneView[];
  bubbles: readonly AbsorptionBubble[] = [];

  private readonly _rows: ChartRowsProvider | null;

  constructor(store: AbsorptionStore = new AbsorptionStore(), rows: ChartRowsProvider | null = null) {
    this._store = store;
    this._rows = rows;
    this._paneViews = [new AbsorptionPaneView(new AbsorptionRenderer(this)), new AbsorptionPaneView(new AbsorptionStatusRenderer(this))];
  }

  get settings(): AbsorptionSettings {
    return this._settings;
  }

  get records(): readonly AbsorptionRecord[] {
    const source = absorptionHistoryDaysOf(this._settings) === 0 ? null : this._history;
    const history = source?.records ?? [];
    const seen = new Set(history.map((record) => record.key));
    const twins = new Map<string, number[]>();
    for (const record of history) {
      const band = `${record.side}:${record.band}`;
      twins.set(band, [...(twins.get(band) ?? []), record.attackTs]);
    }
    // A saved record is never taken back: within the reach it shows unless the history read the same attack, one of its side and band begun within two minutes.
    const twinned = (record: AbsorptionRecord) => (twins.get(`${record.side}:${record.band}`) ?? []).some((ts) => Math.abs(ts - record.attackTs) <= LIVE_HISTORY_TWIN_MS);
    return [...history, ...this._kept.filter((record) => record.ts >= this._shownFrom && !seen.has(record.key) && !twinned(record))];
  }

  /** The records read at the rule's numbers in hand: what is drawn, hovered and merged. */
  get prints(): readonly AbsorptionPrint[] {
    const rules = this._rules;
    if (rules === null) return [];
    const prints: AbsorptionPrint[] = [];
    for (const record of this.records) {
      const print = readPrint(record, rules);
      if (print !== null) prints.push(print);
    }
    return prints;
  }

  get history(): AbsorptionHistory | null {
    return this._history;
  }

  setHistory(history: AbsorptionHistory | null): void {
    if (history === this._history) return;
    this._historyUnsubscribe?.();
    this._historyUnsubscribe = null;
    this._history = history;
    if (history === null) this._shownFrom = -Infinity;
    if (history !== null) {
      history.setRules(this._rules, this._grid?.rowWidth ?? 0);
      this._historyUnsubscribe = history.subscribe(() => this.refresh());
    }
    this.refresh();
  }

  // Saves are throttled to one every few seconds; a page that closes or reloads writes what is left first.
  private readonly _onPageHide = (): void => this._store.flush();

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
    if (typeof window !== "undefined") window.addEventListener("pagehide", this._onPageHide);
  }

  detached(): void {
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this._onPageHide);
    this._store.flush();
    this.setSources(null);
    this.setHistory(null);
    this._cancelScheduledUpdate();
    if (this._recomputeTimer !== null) clearTimeout(this._recomputeTimer);
    this._recomputeTimer = null;
    this.bubbles = [];
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  bubbleAt(x: number, y: number): AbsorptionHover | null {
    const grid = this._grid;
    if (!grid) return null;
    for (let i = this.bubbles.length - 1; i >= 0; i -= 1) {
      const bubble = this.bubbles[i];
      const dx = x - bubble.x;
      const dy = y - bubble.y;
      if (dx * dx + dy * dy <= bubble.r * bubble.r) return describeAbsorptionSphere(bubble.sphere, grid.rowWidth, grid.baseAsset);
    }
    return null;
  }

  setSources(grid: LiquidityGrid | null): void {
    if (grid !== this._grid) {
      this._grid = grid;
      this._tracker = new AbsorptionTracker();
      this._closes = null;
      if (grid?.provider === "DATABENTO") this._computedAt = -Infinity;
      this._reload();
    }
    this._markDirty();
  }

  refresh(): void {
    this._markDirty();
  }

  setSettings(settings: AbsorptionSettings): void {
    this._settings = settings;
    this._markDirty(true);
  }

  setRules(rules: AbsorptionRules | null): void {
    this._rules = rules;
    this._reload();
    this._history?.setRules(rules, this._grid?.rowWidth ?? 0);
    this._markDirty(true);
  }

  private _reload(): void {
    const rules = this._rules;
    this._walls = rules === null ? "" : absorptionWallsKey(rules, this._grid?.rowWidth ?? 0);
    this._kept = rules === null || this._grid?.provider === "DATABENTO" ? [] : this._store.load(this._walls);
  }

  private _markDirty(force = false): void {
    this._dirty = true;
    if (force) this._computedAt = -Infinity;
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

  private _scheduleRecompute(now: number): void {
    if (this._recomputeTimer !== null) return;
    const elapsed = now - this._computedAt;
    const delay = Number.isFinite(elapsed)
      ? Math.max(50, RECOMPUTE_MIN_INTERVAL_MS - elapsed + 5)
      : RECOMPUTE_MIN_INTERVAL_MS + 5;
    this._recomputeTimer = setTimeout(() => {
      this._recomputeTimer = null;
      this._schedule();
    }, delay);
  }

  private _wantHistory(series: ISeriesApi<SeriesType, Time>, grid: LiquidityGrid, rules: AbsorptionRules): void {
    const history = this._history;
    if (history === null) return;
    const reachMs = absorptionHistoryDaysOf(this._settings) * 86_400_000;
    const bars = this._barsFor(series, grid.rowWidth);
    history.setRules(reachMs === 0 ? null : rules, grid.rowWidth, bars.intervalMs);
    const seam = grid.deepColumns[0]?.ts ?? grid.columns[0]?.ts;
    if (seam === undefined) return;
    this._shownFrom = seam - reachMs;
    if (reachMs === 0) return;
    history.want(seam - reachMs, seam, seam, reachMs, grid.deepColumns.length > 0 ? { columns: grid.deepColumns, columnMs: grid.deepColumnMs } : null, bars);
  }

  /** The ten-second columns alone, the width the host's history is read at, so a live sphere and a history sphere come from the same inputs. */
  private _feed(grid: LiquidityGrid): ColumnFeed {
    const feed = grid.historicalFeed;
    if (!feed) {
      return {
        epoch: grid.epoch,
        deep: grid.deepColumns.length > 0 ? { columns: grid.deepColumns, columnMs: grid.deepColumnMs } : null,
        fine: { columns: [], columnMs: grid.columnMs },
        reference: grid.referenceSize,
      };
    }
    const own = new Map(grid.columns.map((column) => [column.ts, column]));
    const graded = (tier: ColumnTier): ColumnTier => ({ ...tier, columns: tier.columns.map((column) => own.get(column.ts) ?? column) });
    return { ...feed, deep: feed.deep === null ? null : graded(feed.deep), fine: graded(feed.fine) };
  }

  private _barsFor(series: ISeriesApi<SeriesType, Time>, rowWidth: number): HistoryBars {
    const bars = (this._rows?.() ?? series.data()) as readonly { time: unknown; close?: unknown }[];
    const lastTime = bars.length > 0 ? Number(bars[bars.length - 1].time) : 0;
    const cached = this._closes;
    if (cached !== null && cached.count === bars.length && cached.lastTime === lastTime && cached.rowWidth === rowWidth) return cached.bars;
    const closes = barCloses(bars, rowWidth);
    const fromTs = bars.length > 0 ? Number(bars[0].time) * 1000 : Infinity;
    const history: HistoryBars = { closes, intervalMs: barIntervalSecOf(bars) * 1000, fromTs: Number.isFinite(fromTs) ? fromTs : Infinity };
    this._closes = { count: bars.length, lastTime, rowWidth, closes, bars: history };
    return history;
  }

  private _closesFor(series: ISeriesApi<SeriesType, Time>, rowWidth: number): readonly BarClose[] {
    return this._barsFor(series, rowWidth).closes;
  }

  updateAllViews(): void {
    const chart = this._chart;
    const series = this._series;
    const grid = this._grid;
    const rules = this._rules;
    this.bubbles = [];
    if (!chart || !series || !grid || !rules || !(grid.rowWidth > 0)) return;
    const historical = grid.provider === "DATABENTO";
    const now = grid.clockMs();
    this._wantHistory(series, grid, rules);
    if (this._dirty && (historical || now - this._computedAt >= RECOMPUTE_MIN_INTERVAL_MS)) {
      const records = this._tracker.update(this._feed(grid), grid.rowWidth, rules, now, this._closesFor(series, grid.rowWidth));
      this._kept = historical ? records : this._store.add(this._walls, records, now);
      this._computedAt = now;
      this._dirty = false;
    } else if (this._dirty) this._scheduleRecompute(now);
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
    const height = chart.paneSize().height;
    const width = timeScale.width();
    if (!(height > 0) || !(width > 0)) return;
    const geometry = {
      xOf: (ms: number) => {
        const center = timeScale.timeToCoordinate((ms / 1000) as Time);
        return center === null ? null : Number(center);
      },
      yOf: (price: number) => {
        const y = series.priceToCoordinate(price);
        return y === null ? null : Number(y);
      },
      width,
      height,
    };
    const shown = this._settings.showBroken === false ? withoutBroken(this.prints) : this.prints;
    const intervalMs = intervalSec * 1000;
    this.bubbles = layoutAbsorption(shown, absorptionBubbleScaleOf(this._settings), geometry, intervalMs, (ts) => chartCandleOpen(bars, ts, intervalMs));
  }
}
