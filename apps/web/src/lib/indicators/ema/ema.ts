import type { LineOutputSpec, RuntimeIndicatorDef } from "../../chart/indicatorTypes";

export const EMA_SHORT_LENGTH = 12;
export const EMA_LONG_LENGTH = 21;
const EMA_UP_COLOR = "#0e9a66";
const EMA_DOWN_COLOR = "#c23854";

export interface EmaSettings {
  shortLength: number;
  longLength: number;
}

interface EmaLegState {
  average: number | null;
  seedValues: number[];
}

export interface EmaState {
  short: EmaLegState;
  long: EmaLegState;
  pendingClose: number | null;
  shortValue: number | null;
  longValue: number | null;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finalizeEmaLeg(leg: EmaLegState, newClose: number, length: number): void {
  if (!Number.isFinite(newClose)) return;
  if (leg.average === null) {
    leg.seedValues.push(newClose);
    if (leg.seedValues.length === length) {
      leg.average = mean(leg.seedValues);
    }
    return;
  }
  const k = 2 / (length + 1);
  leg.average = newClose * k + leg.average * (1 - k);
}

function tentativeEmaValue(leg: EmaLegState, close: number, length: number): number | null {
  if (!Number.isFinite(close)) return null;
  if (leg.average === null) {
    const candidate = [...leg.seedValues, close];
    if (candidate.length !== length) return null;
    return mean(candidate);
  }
  const k = 2 / (length + 1);
  return close * k + leg.average * (1 - k);
}

function trendColor(state: EmaState): string {
  if (state.shortValue === null || state.longValue === null) return EMA_UP_COLOR;
  return state.shortValue >= state.longValue ? EMA_UP_COLOR : EMA_DOWN_COLOR;
}

const EMA_LINES: readonly LineOutputSpec<EmaState>[] = [
  { key: "short", color: trendColor, lineWidth: 1 },
  { key: "long", color: trendColor, lineWidth: 2 },
];

export const emaIndicator: RuntimeIndicatorDef<EmaState, EmaSettings> = {
  kind: "runtime",
  id: "ema",
  label: "EMA (12 / 21)",
  category: "technical",
  defaultSettings: { shortLength: EMA_SHORT_LENGTH, longLength: EMA_LONG_LENGTH },
  lines: EMA_LINES,
  placement: { kind: "overlay" },
  createState: () => ({
    short: { average: null, seedValues: [] },
    long: { average: null, seedValues: [] },
    pendingClose: null,
    shortValue: null,
    longValue: null,
  }),
  onBar: (ctx) => {
    const { bar, state, settings, replace } = ctx;
    if (!replace && state.pendingClose !== null) {
      finalizeEmaLeg(state.short, state.pendingClose, settings.shortLength);
      finalizeEmaLeg(state.long, state.pendingClose, settings.longLength);
    }
    state.pendingClose = bar.close;
    state.shortValue = tentativeEmaValue(state.short, bar.close, settings.shortLength);
    state.longValue = tentativeEmaValue(state.long, bar.close, settings.longLength);
  },
  readOutput: (state) => ({ short: state.shortValue, long: state.longValue }),
};
