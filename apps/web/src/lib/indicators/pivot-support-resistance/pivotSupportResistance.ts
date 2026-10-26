import { draw } from "../../chart/draw";
import type { LabelHandle } from "../../chart/draw/label";
import type { LineHandle, LineStyleKind } from "../../chart/draw/line";
import type {
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import type { Stream } from "../../chart/ta/stream";
import { ta } from "../../chart/ta";

export const PIVOT_SUPPORT_RESISTANCE_MAX_LEVELS = 100;
export const PIVOT_SUPPORT_RESISTANCE_DEFAULT_MAX_LEVELS = 10;
export const PIVOT_SUPPORT_RESISTANCE_DEFAULT_LEFT_BARS = 5;
export const PIVOT_SUPPORT_RESISTANCE_DEFAULT_RIGHT_BARS = 5;
export const PIVOT_SUPPORT_RESISTANCE_MAX_REPLAY_BARS = 3_000;

const LEVEL_LINE_WIDTH = 1;
const HIDDEN_COLOR = "rgba(0, 0, 0, 0)";

export interface PivotSupportResistanceSettings {
  leftBars: number;
  rightBars: number;
  maxLevels: number;
  supportColor: string;
  resistanceColor: string;
  lineStyle: LineStyleKind;
}

export const DEFAULT_PIVOT_SUPPORT_RESISTANCE_SETTINGS: PivotSupportResistanceSettings =
  {
    leftBars: PIVOT_SUPPORT_RESISTANCE_DEFAULT_LEFT_BARS,
    rightBars: PIVOT_SUPPORT_RESISTANCE_DEFAULT_RIGHT_BARS,
    maxLevels: PIVOT_SUPPORT_RESISTANCE_DEFAULT_MAX_LEVELS,
    supportColor: "#16a34a",
    resistanceColor: "#dc2626",
    lineStyle: "solid",
  };

type LevelKind = "support" | "resistance";

interface LevelSlot {
  line: LineHandle;
  dot: LabelHandle;
  label: LabelHandle;
  active: boolean;
  kind: LevelKind | null;
  price: number | null;
  pivotTime: number | null;
  createdOrder: number;
}

interface StoredLevel {
  kind: LevelKind;
  price: number;
  pivotTime: number;
  createdOrder: number;
}

export interface PivotSupportResistanceState {
  highStream: Stream<number, number>;
  lowStream: Stream<number, number>;
  highTimes: number[];
  lowTimes: number[];
  pendingHighTime: number | null;
  pendingLowTime: number | null;
  levels: StoredLevel[];
  renderSlots: LevelSlot[];
  nextCreatedOrder: number;
}

const SETTINGS_SCHEMA: readonly SettingsFieldSchema<PivotSupportResistanceSettings>[] =
  [
    {
      kind: "numeric",
      key: "leftBars",
      label: "Left bars",
      min: 1,
      max: 20,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "numeric",
      key: "rightBars",
      label: "Right bars",
      min: 1,
      max: 20,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "numeric",
      key: "maxLevels",
      label: "Max levels displayed",
      min: 1,
      max: PIVOT_SUPPORT_RESISTANCE_MAX_LEVELS,
      step: 1,
      affects: "recompute",
    },
  ];

function levelColor(
  kind: LevelKind,
  settings: PivotSupportResistanceSettings,
): string {
  const color =
    kind === "resistance" ? settings.resistanceColor : settings.supportColor;
  return color;
}

function formatLevelPrice(price: number): string {
  return price.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function candidateTime(
  times: readonly number[],
  rightBars: number,
): number | null {
  const index = times.length - rightBars;
  return index >= 0 ? times[index] : null;
}

function hideLevel(level: LevelSlot): void {
  level.active = false;
  level.kind = null;
  level.price = null;
  level.pivotTime = null;
  level.line.setColor(HIDDEN_COLOR);
  level.dot.setColor(HIDDEN_COLOR);
  level.dot.setTextColor(HIDDEN_COLOR);
  level.dot.setText("");
  level.label.setColor(HIDDEN_COLOR);
  level.label.setTextColor(HIDDEN_COLOR);
  level.label.setText("");
}

function activateLevel(
  level: LevelSlot,
  kind: LevelKind,
  price: number,
  pivotTime: number,
  order: number,
  settings: PivotSupportResistanceSettings,
): void {
  const color = levelColor(kind, settings);
  level.active = true;
  level.kind = kind;
  level.price = price;
  level.pivotTime = pivotTime;
  level.createdOrder = order;
  level.line.setColor(color);
  level.line.setStyle(settings.lineStyle);
  level.dot.setColor(color);
  level.dot.setTextColor(HIDDEN_COLOR);
  level.dot.setText("");
  level.label.setColor(HIDDEN_COLOR);
  level.label.setTextColor(color);
  level.label.setText(
    `${kind === "resistance" ? "R" : "S"} ${formatLevelPrice(price)}`,
  );
}

function addLevel(
  state: PivotSupportResistanceState,
  kind: LevelKind,
  price: number,
  pivotTime: number,
): void {
  const existing = state.levels.find(
    (level) => level.kind === kind && level.price === price,
  );
  if (existing) return;
  state.levels.push({
    kind,
    price,
    pivotTime,
    createdOrder: state.nextCreatedOrder,
  });
  state.nextCreatedOrder += 1;
}

function updateRenderedLevels(
  state: PivotSupportResistanceState,
  currentTime: number,
  settings: PivotSupportResistanceSettings,
): void {
  const visibleLevels = state.levels.slice(-settings.maxLevels);
  for (let index = 0; index < state.renderSlots.length; index += 1) {
    const slot = state.renderSlots[index];
    const level = visibleLevels[index];
    if (!level) {
      if (slot.active) hideLevel(slot);
      continue;
    }
    activateLevel(
      slot,
      level.kind,
      level.price,
      level.pivotTime,
      level.createdOrder,
      settings,
    );
    slot.line.setXY1(level.pivotTime, level.price);
    slot.line.setXY2(currentTime, level.price);
    slot.dot.setXY(currentTime, level.price);
    slot.label.setXY(currentTime, level.price);
  }
}

function crossed(level: StoredLevel, high: number, low: number): boolean {
  return level.kind === "resistance" ? high >= level.price : low <= level.price;
}

export const pivotSupportResistanceIndicator: RuntimeIndicatorDef<
  PivotSupportResistanceState,
  PivotSupportResistanceSettings
> = {
  kind: "runtime",
  id: "pivotSupportResistance",
  label: "Pivot Support / Resistance",
  category: "technical",
  defaultSettings: {
    ...DEFAULT_PIVOT_SUPPORT_RESISTANCE_SETTINGS,
  },
  settingsSchema: SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  maxReplayBars: PIVOT_SUPPORT_RESISTANCE_MAX_REPLAY_BARS,
  createState: (settings) => ({
    highStream: ta.pivotHigh(settings.leftBars, settings.rightBars),
    lowStream: ta.pivotLow(settings.leftBars, settings.rightBars),
    highTimes: [],
    lowTimes: [],
    pendingHighTime: null,
    pendingLowTime: null,
    levels: [],
    renderSlots: Array.from(
      { length: PIVOT_SUPPORT_RESISTANCE_MAX_LEVELS },
      () => {
        const line = draw.line({
          time1: 0,
          price1: 0,
          time2: 0,
          price2: 0,
          color: HIDDEN_COLOR,
          width: LEVEL_LINE_WIDTH,
          style: settings.lineStyle,
        });
        const label = draw.label({
          time: 0,
          price: 0,
          text: "",
          color: HIDDEN_COLOR,
          textColor: HIDDEN_COLOR,
          size: 12,
          textAlign: "left",
          offsetX: 8,
        });
        const dot = draw.label({
          time: 0,
          price: 0,
          text: "",
          color: HIDDEN_COLOR,
          textColor: HIDDEN_COLOR,
          size: 5,
        });
        return {
          line,
          dot,
          label,
          active: false,
          kind: null,
          price: null,
          pivotTime: null,
          createdOrder: -1,
        };
      },
    ),
    nextCreatedOrder: 0,
  }),
  onBar: (ctx) => {
    const { bar, state, settings, replace } = ctx;
    const timeWindowSize = settings.leftBars + settings.rightBars + 1;
    if (!replace) {
      if (state.pendingHighTime !== null) {
        state.highTimes.push(state.pendingHighTime);
        if (state.highTimes.length > timeWindowSize) {
          state.highTimes.splice(0, state.highTimes.length - timeWindowSize);
        }
      }
      if (state.pendingLowTime !== null) {
        state.lowTimes.push(state.pendingLowTime);
        if (state.lowTimes.length > timeWindowSize) {
          state.lowTimes.splice(0, state.lowTimes.length - timeWindowSize);
        }
      }
    }
    state.pendingHighTime = bar.ts_open;
    state.pendingLowTime = bar.ts_open;

    const pivotHigh = state.highStream.push(bar.high, replace);
    const pivotLow = state.lowStream.push(bar.low, replace);
    if (!bar.closed) return;

    state.levels = state.levels.filter(
      (level) => !crossed(level, bar.high, bar.low),
    );
    updateRenderedLevels(state, bar.ts_open, settings);

    if (pivotHigh !== null) {
      const time = candidateTime(state.highTimes, settings.rightBars);
      if (time !== null && bar.high < pivotHigh)
        addLevel(state, "resistance", pivotHigh, time);
    }
    if (pivotLow !== null) {
      const time = candidateTime(state.lowTimes, settings.rightBars);
      if (time !== null && bar.low > pivotLow)
        addLevel(state, "support", pivotLow, time);
    }
    updateRenderedLevels(state, bar.ts_open, settings);
  },
  readOutput: () => ({}),
};
