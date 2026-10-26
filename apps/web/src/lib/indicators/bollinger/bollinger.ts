import type { LineOutputSpec, RuntimeIndicatorDef } from "../../chart/indicatorTypes";

export const BOLLINGER_LENGTH = 20;
export const BOLLINGER_MULT = 2;
const BASIS_COLOR = "#4d3d78";
const BAND_COLOR = "#8672b3";

export interface BollingerSettings {
  length: number;
  mult: number;
}

export interface BollingerState {
  committedWindow: number[];
  pendingClose: number | null;
  basis: number | null;
  upper: number | null;
  lower: number | null;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function effectiveWindow(window: readonly number[], length: number): readonly number[] | null {
  const trimmed = window.length > length ? window.slice(window.length - length) : window;
  return trimmed.length === length ? trimmed : null;
}

function bandsFromWindow(window: readonly number[], mult: number): { basis: number; upper: number; lower: number } {
  const basis = mean(window);
  let variance = 0;
  for (const value of window) variance += (value - basis) * (value - basis);
  variance /= window.length;
  const dev = Math.sqrt(variance) * mult;
  return { basis, upper: basis + dev, lower: basis - dev };
}

function finalizeCommit(state: BollingerState, newClose: number, length: number): void {
  if (!Number.isFinite(newClose)) return;
  state.committedWindow.push(newClose);
  if (state.committedWindow.length > length) state.committedWindow.shift();
}

function tentativeBands(
  state: BollingerState,
  close: number,
  length: number,
  mult: number,
): { basis: number; upper: number; lower: number } | null {
  if (!Number.isFinite(close) || !Number.isFinite(mult) || mult < 0) return null;
  const window = effectiveWindow([...state.committedWindow, close], length);
  return window ? bandsFromWindow(window, mult) : null;
}

const BOLLINGER_LINES: readonly LineOutputSpec<BollingerState>[] = [
  { key: "basis", color: () => BASIS_COLOR },
  { key: "upper", color: () => BAND_COLOR },
  { key: "lower", color: () => BAND_COLOR },
];

export const bollingerIndicator: RuntimeIndicatorDef<BollingerState, BollingerSettings> = {
  kind: "runtime",
  id: "bollinger",
  label: "Bollinger Bands (20, 2)",
  category: "technical",
  defaultSettings: { length: BOLLINGER_LENGTH, mult: BOLLINGER_MULT },
  lines: BOLLINGER_LINES,
  placement: { kind: "overlay" },
  createState: () => ({
    committedWindow: [],
    pendingClose: null,
    basis: null,
    upper: null,
    lower: null,
  }),
  onBar: (ctx) => {
    const { bar, state, settings, replace } = ctx;
    if (!replace && state.pendingClose !== null) {
      finalizeCommit(state, state.pendingClose, settings.length);
    }
    state.pendingClose = bar.close;
    const bands = tentativeBands(state, bar.close, settings.length, settings.mult);
    state.basis = bands?.basis ?? null;
    state.upper = bands?.upper ?? null;
    state.lower = bands?.lower ?? null;
  },
  readOutput: (state) => ({ basis: state.basis, upper: state.upper, lower: state.lower }),
};
