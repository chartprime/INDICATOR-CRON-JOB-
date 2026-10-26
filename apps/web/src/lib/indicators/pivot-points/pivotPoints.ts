import type { Stream } from "../../chart/ta/stream";
import { ta } from "../../chart/ta";
import type {
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";

export const PIVOT_POINTS_DEFAULT_LEFT_BARS = 5;
export const PIVOT_POINTS_DEFAULT_RIGHT_BARS = 5;
const PIVOT_POINTS_MIN_BARS = 1;
const PIVOT_POINTS_MAX_BARS = 20;
export const PIVOT_POINTS_MAX_REPLAY_BARS = 3_000;

export type PivotMarkerColor = "red" | "green" | "blue" | "orange" | "purple";

const PIVOT_MARKER_COLORS: Record<PivotMarkerColor, string> = {
  red: "#dc2626",
  green: "#16a34a",
  blue: "#2563eb",
  orange: "#ea580c",
  purple: "#7c3aed",
};

export interface PivotPointsSettings {
  leftBars: number;
  rightBars: number;
  upperColor: PivotMarkerColor;
  lowerColor: PivotMarkerColor;
}

export interface PivotPointsState {
  highStream: Stream<number, number>;
  lowStream: Stream<number, number>;
  committedHighTimes: number[];
  committedLowTimes: number[];
  pendingHighTime: number | null;
  pendingLowTime: number | null;
}

const PIVOT_POINTS_SETTINGS_SCHEMA: readonly SettingsFieldSchema<PivotPointsSettings>[] =
  [
    {
      kind: "numeric",
      key: "leftBars",
      label: "Left bars",
      min: PIVOT_POINTS_MIN_BARS,
      max: PIVOT_POINTS_MAX_BARS,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "numeric",
      key: "rightBars",
      label: "Right bars",
      min: PIVOT_POINTS_MIN_BARS,
      max: PIVOT_POINTS_MAX_BARS,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "radioGroup",
      key: "upperColor",
      label: "Upper marker color",
      affects: "recompute",
      options: [
        { value: "red", label: "Red" },
        { value: "orange", label: "Orange" },
        { value: "blue", label: "Blue" },
        { value: "purple", label: "Purple" },
        { value: "green", label: "Green" },
      ],
    },
    {
      kind: "radioGroup",
      key: "lowerColor",
      label: "Lower marker color",
      affects: "recompute",
      options: [
        { value: "green", label: "Green" },
        { value: "blue", label: "Blue" },
        { value: "red", label: "Red" },
        { value: "orange", label: "Orange" },
        { value: "purple", label: "Purple" },
      ],
    },
  ];

function candidateTime(
  committedTimes: readonly number[],
  currentTime: number,
  rightBars: number,
): number | null {
  const values = [...committedTimes, currentTime];
  const index = values.length - 1 - rightBars;
  return index >= 0 ? values[index] : null;
}

export const pivotPointsIndicator: RuntimeIndicatorDef<
  PivotPointsState,
  PivotPointsSettings
> = {
  kind: "runtime",
  id: "pivotPoints",
  label: "Pivot Points",
  category: "technical",
  defaultSettings: {
    leftBars: PIVOT_POINTS_DEFAULT_LEFT_BARS,
    rightBars: PIVOT_POINTS_DEFAULT_RIGHT_BARS,
    upperColor: "red",
    lowerColor: "green",
  },
  settingsSchema: PIVOT_POINTS_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  maxReplayBars: PIVOT_POINTS_MAX_REPLAY_BARS,
  createState: (settings) => ({
    highStream: ta.pivotHigh(settings.leftBars, settings.rightBars),
    lowStream: ta.pivotLow(settings.leftBars, settings.rightBars),
    committedHighTimes: [],
    committedLowTimes: [],
    pendingHighTime: null,
    pendingLowTime: null,
  }),
  onBar: (ctx) => {
    const { bar, state, settings, replace } = ctx;
    const timeWindowSize = settings.leftBars + settings.rightBars + 1;
    if (!replace) {
      if (state.pendingHighTime !== null) {
        state.committedHighTimes.push(state.pendingHighTime);
        if (state.committedHighTimes.length > timeWindowSize) {
          state.committedHighTimes.splice(0, state.committedHighTimes.length - timeWindowSize);
        }
      }
      if (state.pendingLowTime !== null) {
        state.committedLowTimes.push(state.pendingLowTime);
        if (state.committedLowTimes.length > timeWindowSize) {
          state.committedLowTimes.splice(0, state.committedLowTimes.length - timeWindowSize);
        }
      }
    }
    state.pendingHighTime = bar.ts_open;
    state.pendingLowTime = bar.ts_open;

    const pivotHigh = state.highStream.push(bar.high, replace);
    const pivotLow = state.lowStream.push(bar.low, replace);
    if (!bar.closed) return;

    if (pivotHigh !== null) {
      const time = candidateTime(
        state.committedHighTimes,
        bar.ts_open,
        settings.rightBars,
      );
      if (time !== null) {
        ctx.markers.plotshape({
          time,
          shape: "arrowDown",
          position: "aboveBar",
          color: PIVOT_MARKER_COLORS[settings.upperColor],
          price: pivotHigh,
        });
      }
    }
    if (pivotLow !== null) {
      const time = candidateTime(
        state.committedLowTimes,
        bar.ts_open,
        settings.rightBars,
      );
      if (time !== null) {
        ctx.markers.plotshape({
          time,
          shape: "arrowUp",
          position: "belowBar",
          color: PIVOT_MARKER_COLORS[settings.lowerColor],
          price: pivotLow,
        });
      }
    }
  },
  readOutput: () => ({}),
};
