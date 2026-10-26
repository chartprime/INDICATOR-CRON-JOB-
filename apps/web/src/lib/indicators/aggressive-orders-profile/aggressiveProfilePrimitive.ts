import type { IChartApiBase, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time } from "lightweight-charts";
import type { BarFrame } from "../../../types/frames";
import type { CandleDelta } from "./aggressiveProfileReader";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, readerSettingsOf, type AggressiveProfileSettings } from "./aggressiveProfileSettings";
import type { AggressiveProfileSource, VisibleRange } from "./aggressiveProfileSource";

export type AggressiveProfileRead = (candles: readonly CandleDelta[] | null, range: VisibleRange | null, settings: AggressiveProfileSettings) => void;

export function visibleRangeOf(visible: { from: number; to: number } | null, bars: readonly BarFrame[]): VisibleRange | null {
  if (visible === null || bars.length === 0) return null;
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (visible.to * 1000 < first.ts_open) return null;
  const fromTs = Math.max(visible.from * 1000, first.ts_open);
  const toTs = Math.min(visible.to * 1000 + last.interval_ms, last.ts_open + last.interval_ms);
  if (!(toTs > fromTs)) return null;
  return { fromTs, toTs, open: visible.to * 1000 >= last.ts_open };
}

export class AggressiveProfilePrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _source: AggressiveProfileSource | null = null;
  private _settings: AggressiveProfileSettings;
  private readonly _bars: () => readonly BarFrame[];
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _range: VisibleRange | null = null;
  private _reported: readonly CandleDelta[] | null = null;
  private _dirty = false;
  onRead: AggressiveProfileRead | null = null;

  constructor(bars: () => readonly BarFrame[], settings: AggressiveProfileSettings = DEFAULT_AGGRESSIVE_PROFILE_SETTINGS) {
    this._bars = bars;
    this._settings = { ...settings };
  }

  get range(): VisibleRange | null {
    return this._range;
  }

  get settings(): AggressiveProfileSettings {
    return this._settings;
  }

  get source(): AggressiveProfileSource | null {
    return this._source;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._clearTimer();
    this._chart = null;
    this._requestUpdate = null;
    this._range = null;
    this._report(null);
  }

  setSource(source: AggressiveProfileSource | null): void {
    if (source === this._source) return;
    this._source = source;
    this._clearTimer();
    this._range = null;
    this._report(null);
    this._requestUpdate?.();
  }

  setSettings(settings: AggressiveProfileSettings): void {
    this._settings = { ...settings };
    this._dirty = true;
    this._requestUpdate?.();
  }

  repaint(): void {
    this._dirty = true;
    this._requestUpdate?.();
  }

  updateAllViews(): void {
    const source = this._source;
    const chart = this._chart;
    if (source === null || chart === null) return;
    const bars = this._bars();
    const visible = chart.timeScale().getVisibleRange();
    this._range = visibleRangeOf(visible === null ? null : { from: Number(visible.from), to: Number(visible.to) }, bars);
    if (this._range === null) {
      this._clearTimer();
      this._report(null);
      return;
    }
    const now = Date.now();
    const candles = source.read(this._range, readerSettingsOf(this._settings), bars, now);
    this._comeBackAt(source.settleAt, now);
    this._report(candles);
  }

  private _report(candles: readonly CandleDelta[] | null): void {
    if (candles === this._reported && !this._dirty) return;
    this._reported = candles;
    this._dirty = false;
    this.onRead?.(candles, candles === null ? null : this._range, this._settings);
  }

  private _comeBackAt(at: number | null, now: number): void {
    if (at === null) {
      this._clearTimer();
      return;
    }
    if (this._timer !== null) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._requestUpdate?.();
    }, Math.max(0, at - now));
  }

  private _clearTimer(): void {
    if (this._timer === null) return;
    clearTimeout(this._timer);
    this._timer = null;
  }
}
