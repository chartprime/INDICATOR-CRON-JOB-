import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitiveHoveredItem,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { ChartRowsProvider } from "../../chart/chartData";
import { withAlpha } from "../axis-profile/axisProfileLayout";
import { candleMsOf, logicalOfTime, logicalOfX, nearestLine, timeOfLogical, tradedSpans, xOfLogical, type WindowLine, type WindowLines } from "./liveRangeGeometry";
import type { LiveRangeHistory } from "./liveRangeHistory";
import { PrintLedger, type PrintRead } from "./liveRangePrints";
import { gridGaps, readLiveRange, type Gap, type HostColumn, type LiveRangeRead, type RangeGrid } from "./liveRangeReader";
import { DEFAULT_LIVE_RANGE_SETTINGS, VERDICT_Z_FROM, type LiveRangeMode, type LiveRangeSettings, rangeModeOf, zFromOf, zoneOpacityOf, zoneShownOf } from "./liveRangeSettings";
import { MIN_WINDOW_MS, WHOLE_WINDOW, originOf, windowBounds, windowFor, windowFromMinutes, windowToMinutes, type LiveRangeWindow, type WindowBounds } from "./liveRangeWindow";
import { headText, rangeLine, rangeNote, rangeRows, verdictOf, zText } from "./liveRangeWords";

export interface ClockedRangeGrid extends RangeGrid {
  clockMs(): number;
}

export interface LiveRangeReport {
  mode: LiveRangeMode;
  fromTs: number;
  toTs: number;
  live: boolean;
  read: LiveRangeRead | null;
  prints: PrintRead | null;
  loading: boolean;
}

export interface VisibleSpan {
  fromTs: number;
  toTs: number;
}

interface ReadRange extends VisibleSpan {
  live: boolean;
}

export const LIVE_TICK_MS = 1_000;
export const READ_SETTLE_MS = 120;
export const LINE_WIDTH_PX = 1.5;
export const ACTIVE_LINE_WIDTH_PX = 3;

const WINDOW_LINES: readonly WindowLine[] = Object.freeze(["from", "to"]);

export function reportSignature(report: LiveRangeReport | null, zFrom: number = VERDICT_Z_FROM.normal): string {
  if (report === null) return "off";
  const { read, mode } = report;
  const verdict = verdictOf(read, zFrom);
  return JSON.stringify([
    headText(mode),
    rangeLine(mode, report.fromTs, report.toTs, report.live),
    read === null ? null : rangeRows(read, report.prints),
    rangeNote(read, mode, report.loading),
    report.loading,
    verdict === null ? null : [verdict.text, verdict.z === null ? null : zText(verdict.z)],
  ]);
}

export function visibleSpan(rows: readonly { time: number }[], logical: { from: number; to: number } | null, nowMs: number): VisibleSpan | null {
  if (logical === null || rows.length === 0) return null;
  const first = Math.max(0, Math.round(logical.from));
  const last = Math.min(rows.length - 1, Math.round(logical.to));
  if (first > last) return null;
  const fromTs = rows[first].time * 1_000;
  const toTs = Math.min(nowMs, rows[last].time * 1_000 + candleMsOf(rows));
  return toTs > fromTs ? { fromTs, toTs } : null;
}

class ShadeRenderer implements IPrimitivePaneRenderer {
  private readonly _host: LiveRangePrimitive;

  constructor(host: LiveRangePrimitive) {
    this._host = host;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const lines = this._host.lines;
    if (lines === null) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const left = Math.max(-1, Math.min(lines.left, lines.right));
      const right = Math.min(mediaSize.width + 1, Math.max(lines.left, lines.right));
      if (!(right > left)) return;
      context.save();
      try {
        context.fillStyle = withAlpha(this._host.zoneColor, zoneOpacityOf(this._host.settings) / 100);
        context.fillRect(left, 0, right - left, mediaSize.height);
      } finally {
        context.restore();
      }
    });
  }
}

class LineRenderer implements IPrimitivePaneRenderer {
  private readonly _host: LiveRangePrimitive;

  constructor(host: LiveRangePrimitive) {
    this._host = host;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const lines = this._host.lines;
    if (lines === null) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      try {
        context.strokeStyle = this._host.zoneColor;
        context.setLineDash([]);
        for (const line of WINDOW_LINES) {
          const x = lines[line];
          if (x === null) continue;
          context.lineWidth = this._host.activeLine === line ? ACTIVE_LINE_WIDTH_PX : LINE_WIDTH_PX;
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, mediaSize.height);
          context.stroke();
        }
      } finally {
        context.restore();
      }
    });
  }
}

class LiveRangePaneView implements IPrimitivePaneView {
  private readonly _zOrder: PrimitivePaneViewZOrder;
  private readonly _renderer: IPrimitivePaneRenderer;

  constructor(zOrder: PrimitivePaneViewZOrder, renderer: IPrimitivePaneRenderer) {
    this._zOrder = zOrder;
    this._renderer = renderer;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return this._zOrder;
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }
}

export class LiveRangePrimitive implements ISeriesPrimitive<Time> {
  onRead: ((report: LiveRangeReport | null) => void) | null = null;
  lines: WindowLines | null = null;
  activeLine: WindowLine | null = null;
  zoneColor: string = DEFAULT_LIVE_RANGE_SETTINGS.zoneColor;
  private _chart: IChartApiBase<Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _readTimer: ReturnType<typeof setTimeout> | null = null;
  private _shown = false;
  private _dragging = false;
  private _grid: ClockedRangeGrid | null = null;
  private _window: LiveRangeWindow = WHOLE_WINDOW;
  private _history: LiveRangeHistory | null = null;
  private _settings: LiveRangeSettings = DEFAULT_LIVE_RANGE_SETTINGS;
  private _unit = "";
  private _reported: string | null = null;
  private readonly _prints = new PrintLedger();
  private readonly _rows: ChartRowsProvider;
  private readonly _clock: () => number;
  private readonly _views: readonly IPrimitivePaneView[];

  constructor(rows: ChartRowsProvider, clock: () => number = () => Date.now()) {
    this._rows = rows;
    this._clock = clock;
    this._views = [new LiveRangePaneView("bottom", new ShadeRenderer(this)), new LiveRangePaneView("top", new LineRenderer(this))];
  }

  get settings(): LiveRangeSettings {
    return this._settings;
  }

  get unit(): string {
    return this._unit;
  }

  get window(): LiveRangeWindow {
    return this._window;
  }

  attached({ chart, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this._chart = chart;
    this._requestUpdate = requestUpdate;
    this._sync();
  }

  detached(): void {
    this._stopTimer();
    this._cancelRead();
    this._chart = null;
    this._requestUpdate = null;
    this._dragging = false;
    this.activeLine = null;
    this.lines = null;
    this._report(null);
  }

  setShown(shown: boolean): void {
    if (shown === this._shown) return;
    this._shown = shown;
    this._sync();
    this._requestUpdate?.();
  }

  setGrid(grid: ClockedRangeGrid | null): void {
    if (grid === this._grid) return;
    this._grid = grid;
    this.readNow();
  }

  setWindow(window: LiveRangeWindow): void {
    if (window.fromMs === this._window.fromMs && window.toMs === this._window.toMs) return;
    this._window = window;
    this._requestUpdate?.();
    this.readNow();
  }

  setHistory(history: LiveRangeHistory | null): void {
    if (history === this._history) return;
    this._history = history;
    this.readNow();
  }

  setSettings(settings: LiveRangeSettings, unit: string = this._unit): void {
    if (settings === this._settings && unit === this._unit) return;
    this._settings = settings;
    this._unit = unit;
    this.zoneColor = settings.zoneColor;
    this._requestUpdate?.();
    this.readNow();
  }

  updateAllViews(): void {
    const chart = this._chart;
    if (!this._shown || chart === null) {
      this.lines = null;
      return;
    }
    const mode = rangeModeOf(this._settings);
    if (mode === "visible") {
      this.lines = null;
      this._requestRead();
      return;
    }
    this.lines = zoneShownOf(this._settings) ? this._linesOf(chart, mode) : null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }

  lineAt(x: number, y: number): WindowLine | null {
    const chart = this._chart;
    if (!this._shown || chart === null || !(y >= 0 && y <= chart.paneSize(0).height)) return null;
    return nearestLine(this.lines, x);
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const line = this.lineAt(x, y);
    const at = line === null || this.lines === null ? null : this.lines[line];
    if (line === null || at === null) return null;
    return { cursorStyle: "ew-resize", externalId: `live-range-${line}`, zOrder: "top", distance: Math.abs(x - at), hitTestPriority: 1 };
  }

  hoverLine(line: WindowLine | null): void {
    if (this._dragging || line === this.activeLine) return;
    this.activeLine = line;
    this._requestUpdate?.();
  }

  dragTo(line: WindowLine, x: number): LiveRangeWindow | null {
    const chart = this._chart;
    const mode = rangeModeOf(this._settings);
    if (chart === null || mode === "visible") return null;
    const rows = this._rows();
    const logical = logicalOfX(chart.timeScale(), x);
    const ms = logical === null ? null : timeOfLogical(rows, logical, candleMsOf(rows));
    if (ms === null) return null;
    const now = this._now();
    const origin = originOf(now);
    const minutes = windowToMinutes(origin, windowFor(mode, this._window), now);
    const minute = Math.round((ms - origin) / MIN_WINDOW_MS);
    this._window = line === "from" ? windowFromMinutes(origin, minute, minutes.to, minutes.max) : windowFromMinutes(origin, minutes.from, minute, minutes.max);
    this._dragging = true;
    this.activeLine = line;
    this._requestUpdate?.();
    return this._window;
  }

  endDrag(): LiveRangeWindow {
    this._dragging = false;
    this.activeLine = null;
    this._requestUpdate?.();
    this.readNow();
    return this._window;
  }

  span(): VisibleSpan | null {
    const range = this._range();
    return range === null ? null : { fromTs: range.fromTs, toTs: range.toTs };
  }

  readNow(): void {
    const range = this._shown && this._chart !== null ? this._range() : null;
    if (range === null) {
      this._report(null);
      return;
    }
    const mode = rangeModeOf(this._settings);
    const history = this._history;
    history?.keep(range.fromTs, range.toTs);
    const gaps = gridGaps(this._grid, range.fromTs, range.toTs);
    const hostColumns = this._hostColumns(gaps);
    const rows = this._rows();
    const read = readLiveRange(this._grid, range.fromTs, range.toTs, hostColumns, tradedSpans(rows, candleMsOf(rows), range.fromTs, range.toTs));
    const threshold = this._settings.bigPrint > 0 ? this._settings.bigPrint : 0;
    this._prints.update(this._grid, history?.columns(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY) ?? [], threshold);
    const prints = this._prints.read(range.fromTs, range.toTs, this._unit);
    const loading = history !== null && gaps.some(([fromTs, beforeTs]) => !history.covered(fromTs, beforeTs));
    this._report({ mode, fromTs: range.fromTs, toTs: range.toTs, live: range.live, read, prints, loading });
  }

  private _now(): number {
    return this._grid?.clockMs() ?? this._clock();
  }

  private _bounds(now: number): WindowBounds {
    return windowBounds(originOf(now), windowFor(rangeModeOf(this._settings), this._window), now);
  }

  private _linesOf(chart: IChartApiBase<Time>, mode: LiveRangeMode): WindowLines | null {
    const rows = this._rows();
    const candleMs = candleMsOf(rows);
    const now = this._now();
    const bounds = this._bounds(now);
    const timeScale = chart.timeScale();
    const xOf = (ms: number): number | null => {
      const logical = logicalOfTime(rows, ms, candleMs);
      return logical === null ? null : xOfLogical(timeScale, logical);
    };
    const left = xOf(bounds.fromMs);
    const right = xOf(bounds.toMs ?? now);
    if (left === null || right === null) return null;
    return { left, right, from: left, to: mode === "selected" ? right : null };
  }

  private _range(): ReadRange | null {
    const chart = this._chart;
    if (chart === null) return null;
    const now = this._now();
    if (rangeModeOf(this._settings) === "visible") {
      const span = visibleSpan(this._rows(), chart.timeScale().getVisibleLogicalRange(), now);
      return span === null ? null : { ...span, live: false };
    }
    const bounds = this._bounds(now);
    return { fromTs: bounds.fromMs, toTs: bounds.toMs ?? now, live: bounds.toMs === null };
  }

  private _hostColumns(gaps: readonly Gap[]): readonly HostColumn[] {
    const history = this._history;
    if (history === null || gaps.length === 0) return [];
    const fromTs = gaps[0][0];
    const beforeTs = gaps[gaps.length - 1][1];
    history.want(fromTs, beforeTs, rangeModeOf(this._settings) !== "visible");
    return history.columns(fromTs, beforeTs);
  }

  private _sync(): void {
    const live = this._shown && this._chart !== null;
    if (live && this._timer === null) this._timer = setInterval(() => this.readNow(), LIVE_TICK_MS);
    if (!live) this._stopTimer();
    this.readNow();
  }

  private _requestRead(): void {
    if (this._readTimer !== null) return;
    this._readTimer = setTimeout(() => {
      this._readTimer = null;
      this.readNow();
    }, READ_SETTLE_MS);
  }

  private _cancelRead(): void {
    if (this._readTimer === null) return;
    clearTimeout(this._readTimer);
    this._readTimer = null;
  }

  private _stopTimer(): void {
    if (this._timer === null) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  private _report(report: LiveRangeReport | null): void {
    const signature = reportSignature(report, zFromOf(this._settings));
    if (signature === this._reported) return;
    this._reported = signature;
    this.onRead?.(report);
  }
}
