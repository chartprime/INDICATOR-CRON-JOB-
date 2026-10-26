import type {
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { BarFrame } from "../../types/frames";
import { formatCountdown } from "./formatCountdown";

const ROW_HEIGHT_PX = 15;
const FIXED_COORDINATE_UNUSED = -1_000_000;
const UP_BACK_COLOR = "#f8f8f5";
const UP_PRICE_TEXT_COLOR = "#111111";
const UP_COUNTDOWN_TEXT_COLOR = "rgba(10, 10, 10, 0.55)";
const DOWN_BACK_COLOR = "#111111";
const DOWN_PRICE_TEXT_COLOR = "#f8f8f5";
const DOWN_COUNTDOWN_TEXT_COLOR = "rgba(248, 248, 245, 0.55)";

export interface CandleCloseTimerState {
  price: number;
  closeAtMs: number | null;
  nowMs: number;
  up: boolean;
}

export function barToCandleCloseTimerState(bar: BarFrame | null, nowMs: number): CandleCloseTimerState | null {
  if (!bar) return null;
  return {
    price: bar.close,
    closeAtMs: bar.closed ? null : bar.ts_open + bar.interval_ms,
    nowMs,
    up: bar.close >= bar.open,
  };
}

class FixedAxisLabel implements ISeriesPrimitiveAxisView {
  private readonly _text: string;
  private readonly _textColor: string;
  private readonly _backColor: string;
  private readonly _y: number;

  constructor(text: string, textColor: string, backColor: string, y: number) {
    this._text = text;
    this._textColor = textColor;
    this._backColor = backColor;
    this._y = y;
  }

  coordinate(): number {
    return FIXED_COORDINATE_UNUSED;
  }

  fixedCoordinate(): number {
    return this._y;
  }

  text(): string {
    return this._text;
  }

  textColor(): string {
    return this._textColor;
  }

  backColor(): string {
    return this._backColor;
  }
}

export class CandleCloseTimerPrimitive implements ISeriesPrimitive<Time> {
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _state: CandleCloseTimerState | null = null;
  private _views: readonly ISeriesPrimitiveAxisView[] = [];

  attached(param: SeriesAttachedParameter<Time>): void {
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._series = null;
    this._requestUpdate = null;
    this._state = null;
    this._views = [];
  }

  updateAllViews(): void {
    const series = this._series;
    const state = this._state;
    if (!series || !state) {
      this._views = [];
      return;
    }
    const y = series.priceToCoordinate(state.price);
    if (y === null) {
      this._views = [];
      return;
    }
    const backColor = state.up ? UP_BACK_COLOR : DOWN_BACK_COLOR;
    const priceTextColor = state.up ? UP_PRICE_TEXT_COLOR : DOWN_PRICE_TEXT_COLOR;
    const priceText = series.priceFormatter().format(state.price);
    if (state.closeAtMs === null) {
      this._views = [new FixedAxisLabel(priceText, priceTextColor, backColor, y)];
      return;
    }
    const countdownTextColor = state.up ? UP_COUNTDOWN_TEXT_COLOR : DOWN_COUNTDOWN_TEXT_COLOR;
    const countdownText = formatCountdown(state.closeAtMs - state.nowMs);
    this._views = [
      new FixedAxisLabel(priceText, priceTextColor, backColor, y - ROW_HEIGHT_PX / 2),
      new FixedAxisLabel(countdownText, countdownTextColor, backColor, y + ROW_HEIGHT_PX / 2),
    ];
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this._views;
  }

  setState(state: CandleCloseTimerState | null): void {
    this._state = state;
    this._requestUpdate?.();
  }
}
