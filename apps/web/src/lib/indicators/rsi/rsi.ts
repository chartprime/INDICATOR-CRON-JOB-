import type { LineOutputSpec, PlacementSpec, RuntimeIndicatorDef } from "../../chart/indicatorTypes";

export const RSI_LENGTH = 14;
const RSI_COLOR = "#4d3d78";

export interface RsiSettings {
  length: number;
}

interface RsiAverages {
  avgGain: number;
  avgLoss: number;
}

export interface RsiState {
  committedClose: number | null;
  averages: RsiAverages | null;
  seedGains: number[];
  seedLosses: number[];
  pendingClose: number | null;
  value: number | null;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function diffOf(prevClose: number, close: number): { gain: number; loss: number } | null {
  if (!Number.isFinite(prevClose) || !Number.isFinite(close)) return null;
  const change = close - prevClose;
  return { gain: Math.max(change, 0), loss: Math.max(-change, 0) };
}

function finalizeCommit(state: RsiState, newClose: number, length: number): void {
  if (!Number.isFinite(newClose)) return;
  if (state.committedClose !== null) {
    const diff = diffOf(state.committedClose, newClose);
    if (diff) {
      if (state.averages === null) {
        state.seedGains.push(diff.gain);
        state.seedLosses.push(diff.loss);
        if (state.seedGains.length === length) {
          state.averages = { avgGain: mean(state.seedGains), avgLoss: mean(state.seedLosses) };
        }
      } else {
        state.averages = {
          avgGain: (state.averages.avgGain * (length - 1) + diff.gain) / length,
          avgLoss: (state.averages.avgLoss * (length - 1) + diff.loss) / length,
        };
      }
    }
  }
  state.committedClose = newClose;
}

function tentativeValue(state: RsiState, close: number, length: number): number | null {
  if (state.committedClose === null) return null;
  const diff = diffOf(state.committedClose, close);
  if (!diff) return null;
  if (state.averages === null) {
    const candidateGains = [...state.seedGains, diff.gain];
    if (candidateGains.length !== length) return null;
    const candidateLosses = [...state.seedLosses, diff.loss];
    return rsiFromAverages(mean(candidateGains), mean(candidateLosses));
  }
  const avgGain = (state.averages.avgGain * (length - 1) + diff.gain) / length;
  const avgLoss = (state.averages.avgLoss * (length - 1) + diff.loss) / length;
  return rsiFromAverages(avgGain, avgLoss);
}

const RSI_LINES: readonly LineOutputSpec<RsiState>[] = [{ key: "value", color: () => RSI_COLOR }];

const RSI_PLACEMENT: PlacementSpec = {
  kind: "ownPane",
  priceLines: [30, 50, 70],
  autoscaleRange: { min: 0, max: 100 },
};

export const rsiIndicator: RuntimeIndicatorDef<RsiState, RsiSettings> = {
  kind: "runtime",
  id: "rsi",
  label: "RSI (14)",
  category: "technical",
  defaultSettings: { length: RSI_LENGTH },
  lines: RSI_LINES,
  placement: RSI_PLACEMENT,
  createState: () => ({
    committedClose: null,
    averages: null,
    seedGains: [],
    seedLosses: [],
    pendingClose: null,
    value: null,
  }),
  onBar: (ctx) => {
    const { bar, state, settings, replace } = ctx;
    const length = settings.length;
    if (!replace && state.pendingClose !== null) {
      finalizeCommit(state, state.pendingClose, length);
    }
    state.pendingClose = bar.close;
    state.value = tentativeValue(state, bar.close, length);
  },
  readOutput: (state) => ({ value: state.value }),
};
