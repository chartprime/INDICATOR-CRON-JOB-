import type { LineOutputSpec, RuntimeIndicatorDef, SettingsFieldSchema } from "../../chart/indicatorTypes";

export const SMA_LENGTH = 20;
export const SMA_DEFAULT_COLOR = "purple";

const COLOR_HEX: Record<SmaSettings["color"], string> = {
  purple: "#8672b3",
  blue: "#2563eb",
  green: "#16a34a",
};

export interface SmaSettings {
  length: number;
  color: "purple" | "blue" | "green";
}

export interface SmaState {
  committedWindow: number[];
  pendingClose: number | null;
  value: number | null;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function effectiveWindow(window: readonly number[], length: number): readonly number[] | null {
  const trimmed = window.length > length ? window.slice(window.length - length) : window;
  return trimmed.length === length ? trimmed : null;
}

function finalizeCommit(state: SmaState, newClose: number, length: number): void {
  if (!Number.isFinite(newClose)) return;
  state.committedWindow.push(newClose);
  if (state.committedWindow.length > length) state.committedWindow.shift();
}

function tentativeValue(state: SmaState, close: number, length: number): number | null {
  if (!Number.isFinite(close)) return null;
  const window = effectiveWindow([...state.committedWindow, close], length);
  return window ? mean(window) : null;
}

const SMA_LINES: readonly LineOutputSpec<SmaState, SmaSettings>[] = [
  {
    key: "value",
    color: (_state, settings) => COLOR_HEX[settings.color],
    recolor: (_currentColor, settings) => COLOR_HEX[settings.color],
  },
];

const SMA_SETTINGS_SCHEMA: readonly SettingsFieldSchema<SmaSettings>[] = [
  { kind: "numeric", key: "length", label: "Length", min: 2, max: 500, step: 1, affects: "recompute" },
  {
    kind: "radioGroup",
    key: "color",
    label: "Color",
    affects: "cosmetic",
    options: [
      { value: "purple", label: "Purple" },
      { value: "blue", label: "Blue" },
      { value: "green", label: "Green" },
    ],
  },
];

export const smaIndicator: RuntimeIndicatorDef<SmaState, SmaSettings> = {
  kind: "runtime",
  id: "sma",
  label: "SMA (20)",
  category: "community",
  defaultSettings: { length: SMA_LENGTH, color: SMA_DEFAULT_COLOR },
  lines: SMA_LINES,
  settingsSchema: SMA_SETTINGS_SCHEMA,
  placement: { kind: "overlay" },
  createState: () => ({ committedWindow: [], pendingClose: null, value: null }),
  onBar: (ctx) => {
    const { bar, state, settings, replace } = ctx;
    if (!replace && state.pendingClose !== null) {
      finalizeCommit(state, state.pendingClose, settings.length);
    }
    state.pendingClose = bar.close;
    state.value = tentativeValue(state, bar.close, settings.length);
  },
  readOutput: (state) => ({ value: state.value }),
};
