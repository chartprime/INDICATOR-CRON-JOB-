import type { Stream } from "../../chart/ta/stream";
import { ta } from "../../chart/ta";
import { draw } from "../../chart/draw";
import type {
  IndicatorBarCtx,
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import type { BoxHandle } from "../../chart/draw/box";
import type { LineHandle } from "../../chart/draw/line";
import type { LabelHandle } from "../../chart/draw/label";
import { withOpacity } from "../volume-profile/profilePeriodGeometry";
import type { BarFrame } from "../../../types/frames";
import { barSides } from "../barSides";

export const FVG_DELTA_DEFAULT_ATR_LENGTH = 14;
export const FVG_DELTA_DEFAULT_ATR_MULTIPLIER = 0.1;
export const FVG_DELTA_DEFAULT_MAX_DISPLAYED_LEVELS = 10;
export const FVG_DELTA_MAX_ATR_LENGTH = 200;
export const FVG_DELTA_MAX_ATR_MULTIPLIER = 10;
export const FVG_DELTA_MAX_DISPLAYED_LEVELS = 100;
export const FVG_DELTA_MAX_REPLAY_BARS = 2_000;
const MAX_STORED_BARS = 2000;
const MAX_STORED_EVENTS = MAX_STORED_BARS * 2;
const BULLISH_COLOR = "#22c55e";
const BEARISH_COLOR = "#ef4444";

export interface FVGDeltaSettings {
  atrLength: number;
  atrMultiplier: number;
  maxDisplayedLevels: number;
  showBullishFVG: boolean;
  showBearishFVG: boolean;
  bullishColor: string;
  bearishColor: string;
  displayMode: "boxes" | "lines";
}

interface FVGEvent {
  id: string;
  kind: "bullish" | "bearish";
  time: number;
  levelPrice: number;
  topPrice: number;
  bottomPrice: number;
  bubblePrice: number;
  delta: number;
  buyVolume: number;
  sellVolume: number;
  active: boolean;
  slot: number | null;
  box: BoxHandle | null;
  line: LineHandle | null;
  label: LabelHandle | null;
  endLabel: LabelHandle | null;
}

export interface FVGDeltaState {
  atr: Stream<{ high: number; low: number; close: number }, number>;
  boxPool: BoxHandle[];
  linePool: LineHandle[];
  labelPool: LabelHandle[];
  endLabelPool: LabelHandle[];
  barTimes: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  deltas: (number | null)[];
  buyVolumes: (number | null)[];
  events: FVGEvent[];
}

export interface FVGHoverData {
  kind: "bullish" | "bearish";
  time: number;
  levelPrice: number;
  topPrice: number;
  bottomPrice: number;
  displayMode: "boxes" | "lines";
  bubblePrice: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  score: number;
}

export const FVG_DELTA_SETTINGS_SCHEMA: readonly SettingsFieldSchema<FVGDeltaSettings>[] =
  [
    {
      key: "atrLength",
      label: "ATR Length",
      kind: "numeric",
      min: 1,
      max: 200,
      step: 1,
      affects: "recompute",
    },
    {
      key: "atrMultiplier",
      label: "FVG ATR Threshold",
      kind: "numeric",
      min: 0,
      max: 10,
      step: 0.1,
      affects: "recompute",
    },
    {
      key: "maxDisplayedLevels",
      label: "Max Displayed Levels",
      kind: "numeric",
      min: 1,
      max: 100,
      step: 1,
      affects: "recompute",
    },
    {
      key: "displayMode",
      label: "Display Mode",
      kind: "select",
      options: [
        { value: "boxes", label: "Zones (Boxes)" },
        { value: "lines", label: "Levels (Lines)" },
      ],
      affects: "recompute",
    },
    {
      key: "showBullishFVG",
      label: "Show Bullish FVG",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "showBearishFVG",
      label: "Show Bearish FVG",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "bullishColor",
      label: "Bullish FVG Color",
      kind: "color",
      tab: "visibility",
      affects: "recompute",
    },
    {
      key: "bearishColor",
      label: "Bearish FVG Color",
      kind: "color",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "staticHint",
      text: "Detects three-candle fair value gaps larger than the ATR threshold. Zones end on a later wick touch; midpoint levels end on a close through the level. Bubble text is a 0-10 score based on known trade-side delta.",
    },
  ];

function deltaForBar(bar: BarFrame): number | null {
  const sides = barSides(bar);
  return sides.known ? sides.delta : null;
}

function scoreColor(baseColor: string, score: number): string {
  const opacity = Math.max(0.5, Math.min(1, score / 10));
  return withOpacity(baseColor, opacity);
}

function eventId(
  kind: FVGEvent["kind"],
  time: number,
  levelPrice: number,
): string {
  return `${kind}:${time}:${levelPrice}`;
}

function setEventVisible(
  event: FVGEvent,
  color: string,
  endTime: number,
  displayMode: "boxes" | "lines",
): void {
  if (displayMode === "boxes") {
    event.box?.setLeftTop(event.time, event.topPrice);
    event.box?.setRightBottom(endTime, event.bottomPrice);
    event.box?.setBorderColor(color);
    event.box?.setBackgroundColor(withOpacity(color, 0.2));
    event.line?.setColor("transparent");
  } else {
    event.line?.setXY1(event.time, event.levelPrice);
    event.line?.setXY2(endTime, event.levelPrice);
    event.line?.setColor(color);
    event.box?.setBorderColor("transparent");
    event.box?.setBackgroundColor("transparent");
  }
}

function releaseEventDraw(event: FVGEvent): void {
  event.box?.setBorderColor("transparent");
  event.box?.setBackgroundColor("transparent");
  event.line?.setColor("transparent");
  event.label?.setColor("transparent");
  event.label?.setText("");
  event.endLabel?.setColor("transparent");
  event.endLabel?.setText("");
  event.slot = null;
  event.box = null;
  event.line = null;
  event.label = null;
  event.endLabel = null;
}

function normalizedMaxDisplayedLevels(settings: FVGDeltaSettings): number {
  const requested = Number.isFinite(settings.maxDisplayedLevels)
    ? settings.maxDisplayedLevels
    : FVG_DELTA_DEFAULT_MAX_DISPLAYED_LEVELS;
  return Math.max(
    1,
    Math.min(FVG_DELTA_MAX_DISPLAYED_LEVELS, Math.floor(requested)),
  );
}

function normalizedAtrLength(settings: FVGDeltaSettings): number {
  const requested = Number.isFinite(settings.atrLength)
    ? settings.atrLength
    : FVG_DELTA_DEFAULT_ATR_LENGTH;
  return Math.max(1, Math.min(FVG_DELTA_MAX_ATR_LENGTH, Math.floor(requested)));
}

function normalizedAtrMultiplier(settings: FVGDeltaSettings): number {
  const requested = Number.isFinite(settings.atrMultiplier)
    ? settings.atrMultiplier
    : FVG_DELTA_DEFAULT_ATR_MULTIPLIER;
  return Math.max(0, Math.min(FVG_DELTA_MAX_ATR_MULTIPLIER, requested));
}

function refreshVisibleLevels(
  state: FVGDeltaState,
  settings: FVGDeltaSettings,
  endTime: number,
): void {
  const maxDisplayedLevels = normalizedMaxDisplayedLevels(settings);
  const visibleEvents = state.events
    .filter((event) => event.active)
    .slice(-maxDisplayedLevels);
  const maxDelta = visibleEvents.reduce(
    (maximum, event) => Math.max(maximum, Math.abs(event.delta)),
    0,
  );
  const visibleEventSet = new Set(visibleEvents);
  const usedSlots = new Set<number>();
  for (const event of visibleEvents) {
    let slot = event.slot;
    if (slot === null || usedSlots.has(slot)) {
      const pool =
        settings.displayMode === "boxes" ? state.boxPool : state.linePool;
      slot = pool.findIndex((_, index) => !usedSlots.has(index));
      if (slot < 0) continue;
      event.slot = slot;
      event.box = settings.displayMode === "boxes" ? state.boxPool[slot] : null;
      event.line =
        settings.displayMode === "lines" ? state.linePool[slot] : null;
      event.label = state.labelPool[slot];
      event.endLabel = state.endLabelPool[slot];
    }
    usedSlots.add(slot);
  }

  for (const event of state.events) {
    if (!visibleEventSet.has(event)) {
      releaseEventDraw(event);
    }
  }

  for (const event of visibleEvents) {
    const baseColor =
      event.kind === "bullish" ? settings.bullishColor : settings.bearishColor;
    const score =
      maxDelta === 0
        ? 1
        : Math.max(1, Math.round((Math.abs(event.delta) / maxDelta) * 10));
    const color = scoreColor(baseColor, score);
    setEventVisible(event, color, endTime, settings.displayMode);
    event.label?.setXY(event.time, event.bubblePrice);
    event.label?.setText(String(score));
    event.label?.setColor(color);
    event.label?.setTextColor("#ffffff");
    event.label?.setSize(10 + score * 3);
    event.label?.setTextSize(15 + Math.min(score, 3));
    event.endLabel?.setXY(endTime, event.levelPrice);
    event.endLabel?.setText("");
    event.endLabel?.setColor(settings.displayMode === "boxes" ? "transparent" : color);
    event.endLabel?.setSize(6);
  }
}

export const fvgDeltaIndicator: RuntimeIndicatorDef<
  FVGDeltaState,
  FVGDeltaSettings
> = {
  kind: "runtime",
  id: "fvgDelta",
  label: "FVG Delta Bubbles & Levels",
  category: "l1",
  maxReplayBars: FVG_DELTA_MAX_REPLAY_BARS,
  defaultSettings: {
    atrLength: FVG_DELTA_DEFAULT_ATR_LENGTH,
    atrMultiplier: FVG_DELTA_DEFAULT_ATR_MULTIPLIER,
    maxDisplayedLevels: FVG_DELTA_DEFAULT_MAX_DISPLAYED_LEVELS,
    showBullishFVG: true,
    showBearishFVG: true,
    bullishColor: BULLISH_COLOR,
    bearishColor: BEARISH_COLOR,
    displayMode: "lines",
  },
  settingsSchema: FVG_DELTA_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  readOutput: () => ({}),
  getHoverData: (state, settings): FVGHoverData[] => {
    const visibleEvents = state.events
      .filter((event) => event.active)
      .slice(-normalizedMaxDisplayedLevels(settings));
    const maxDelta = visibleEvents.reduce(
      (maximum, event) => Math.max(maximum, Math.abs(event.delta)),
      0,
    );
    return visibleEvents.map((event) => ({
      kind: event.kind,
      time: event.time,
      levelPrice: event.levelPrice,
      topPrice: event.topPrice,
      bottomPrice: event.bottomPrice,
      displayMode: settings.displayMode,
      bubblePrice: event.bubblePrice,
      buyVolume: event.buyVolume,
      sellVolume: event.sellVolume,
      delta: event.delta,
      score:
        maxDelta === 0
          ? 1
          : Math.max(1, Math.round((Math.abs(event.delta) / maxDelta) * 10)),
    }));
  },
  createState(settings): FVGDeltaState {
    return {
      atr: ta.atr(normalizedAtrLength(settings)),
      boxPool: Array.from(
        { length: normalizedMaxDisplayedLevels(settings) },
        () =>
          draw.box({
            time1: 0,
            price1: 0,
            time2: 0,
            price2: 0,
            borderColor: "transparent",
            backgroundColor: "transparent",
            borderWidth: 0,
          }),
      ),
      linePool: Array.from(
        { length: normalizedMaxDisplayedLevels(settings) },
        () =>
          draw.line({
            time1: 0,
            price1: 0,
            time2: 0,
            price2: 0,
            color: "transparent",
            width: 2,
            style: "solid",
          }),
      ),
      labelPool: Array.from(
        { length: normalizedMaxDisplayedLevels(settings) },
        () =>
          draw.label({
            time: 0,
            price: 0,
            text: "",
            color: "transparent",
            textColor: "#ffffff",
            size: 10,
            textSize: 9,
          }),
      ),
      endLabelPool: Array.from(
        { length: normalizedMaxDisplayedLevels(settings) },
        () =>
          draw.label({
            time: 0,
            price: 0,
            text: "",
            color: "transparent",
            textColor: "transparent",
            size: 6,
            textSize: 1,
          }),
      ),
      barTimes: [],
      highs: [],
      lows: [],
      closes: [],
      deltas: [],
      buyVolumes: [],
      events: [],
    };
  },
  onBar(ctx: IndicatorBarCtx<FVGDeltaState, FVGDeltaSettings>): void {
    const { bar, state, settings, replace } = ctx;
    const atr = state.atr.push(bar, replace);
    const barDelta = deltaForBar(bar);

    if (!replace) {
      state.barTimes.push(bar.ts_open);
      state.highs.push(bar.high);
      state.lows.push(bar.low);
      state.closes.push(bar.close);
      state.deltas.push(barDelta);
      state.buyVolumes.push(barSides(bar).known ? barSides(bar).buy : null);
      if (state.barTimes.length > MAX_STORED_BARS) {
        state.barTimes.shift();
        state.highs.shift();
        state.lows.shift();
        state.closes.shift();
        state.deltas.shift();
        state.buyVolumes.shift();
      }
    } else if (state.barTimes.length > 0) {
      const index = state.barTimes.length - 1;
      state.barTimes[index] = bar.ts_open;
      state.highs[index] = bar.high;
      state.lows[index] = bar.low;
      state.closes[index] = bar.close;
      state.deltas[index] = barDelta;
      state.buyVolumes[index] = barSides(bar).known ? barSides(bar).buy : null;
    }

    if (!bar.closed) return;

    for (const event of state.events) {
      if (!event.active) continue;
      const crossed =
        settings.displayMode === "boxes"
          ? event.kind === "bullish"
            ? bar.low <= event.topPrice
            : bar.high >= event.bottomPrice
          : event.kind === "bullish"
            ? bar.close < event.levelPrice
            : bar.close > event.levelPrice;
      if (crossed) {
        event.active = false;
        releaseEventDraw(event);
      }
    }

    const length = state.barTimes.length;
    if (length < 3) {
      refreshVisibleLevels(state, settings, bar.ts_open);
      return;
    }

    const leftIndex = length - 3;
    const middleIndex = length - 2;
    const rightIndex = length - 1;
    const threshold =
      (atr ?? bar.high - bar.low) * normalizedAtrMultiplier(settings);
    const candidates: {
      kind: FVGEvent["kind"];
      gap: number;
      levelPrice: number;
      topPrice: number;
      bottomPrice: number;
      color: string;
    }[] = [];
    const bullishGap = state.lows[rightIndex] - state.highs[leftIndex];
    if (settings.showBullishFVG && bullishGap > threshold) {
      candidates.push({
        kind: "bullish",
        gap: bullishGap,
        levelPrice: (state.highs[leftIndex] + state.lows[rightIndex]) / 2,
        topPrice: state.lows[rightIndex],
        bottomPrice: state.highs[leftIndex],
        color: settings.bullishColor,
      });
    }
    const bearishGap = state.lows[leftIndex] - state.highs[rightIndex];
    if (settings.showBearishFVG && bearishGap > threshold) {
      candidates.push({
        kind: "bearish",
        gap: bearishGap,
        levelPrice: (state.lows[leftIndex] + state.highs[rightIndex]) / 2,
        topPrice: state.lows[leftIndex],
        bottomPrice: state.highs[rightIndex],
        color: settings.bearishColor,
      });
    }

    for (const candidate of candidates) {
      const leftBuyVolume = state.buyVolumes[leftIndex];
      const middleBuyVolume = state.buyVolumes[middleIndex];
      const rightBuyVolume = state.buyVolumes[rightIndex];
      const leftDelta = state.deltas[leftIndex];
      const middleDelta = state.deltas[middleIndex];
      const rightDelta = state.deltas[rightIndex];
      // A candle missing buy_volume means its taker-buy/sell split is
      // unknown, not zero -- fabricating a directional score from an
      // incomplete window would be worse than showing nothing.
      if (
        leftBuyVolume === null ||
        middleBuyVolume === null ||
        rightBuyVolume === null ||
        leftDelta === null ||
        middleDelta === null ||
        rightDelta === null
      )
        continue;
      const delta = leftDelta + middleDelta + rightDelta;
      const buyVolume = leftBuyVolume + middleBuyVolume + rightBuyVolume;
      const id = eventId(candidate.kind, bar.ts_open, candidate.levelPrice);
      if (state.events.some((event) => event.id === id)) continue;
      if (state.events.length >= MAX_STORED_EVENTS) {
        const staleIndex = state.events.findIndex((event) => !event.active);
        state.events.splice(staleIndex >= 0 ? staleIndex : 0, 1);
      }
      state.events.push({
        id,
        kind: candidate.kind,
        time: state.barTimes[middleIndex],
        levelPrice: candidate.levelPrice,
        topPrice: candidate.topPrice,
        bottomPrice: candidate.bottomPrice,
        bubblePrice:
          candidate.kind === "bullish"
            ? state.lows[rightIndex] - candidate.gap / 2
            : state.highs[rightIndex] + candidate.gap / 2,
        delta,
        buyVolume,
        sellVolume: buyVolume - delta,
        active: true,
        slot: null,
        box: null,
        line: null,
        label: null,
        endLabel: null,
      });
    }

    refreshVisibleLevels(state, settings, bar.ts_open);
  },
};
