import {
  type IndicatorBarCtx,
  type RuntimeIndicatorDef,
  type SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import { ta } from "../../chart/ta";
import { draw } from "../../chart/draw";
import type { LineHandle } from "../../chart/draw/line";
import type { LabelHandle } from "../../chart/draw/label";
import { barDelta } from "../barSides";

export const DEFAULT_SWING_LENGTH = 5;
export const MAX_STRUCTURE_OBJECTS = 100;

export interface MarketStructureSettings {
  swingLength: number;
  showBOS: boolean;
  showCHoCH: boolean;
  showProjections: boolean;
  bullishColor: string;
  bearishColor: string;
}

export const MARKET_STRUCTURE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<MarketStructureSettings>[] =
  [
    {
      key: "swingLength",
      label: "Swing Length",
      kind: "numeric",
      min: 1,
      max: 50,
      step: 1,
      affects: "recompute",
    },
    {
      key: "showBOS",
      label: "Show Break of Structure (BOS)",
      kind: "boolean",
      affects: "cosmetic",
    },
    {
      key: "showCHoCH",
      label: "Show Change of Character (CHoCH)",
      kind: "boolean",
      affects: "cosmetic",
    },
    {
      key: "showProjections",
      label: "Show Unbroken Swing Projections",
      kind: "boolean",
      affects: "cosmetic",
    },
    {
      key: "bullishColor",
      label: "Bullish Break Color",
      kind: "color",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      key: "bearishColor",
      label: "Bearish Break Color",
      kind: "color",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "staticHint",
      text: "Grades confirm breakout strength normalized against total volume using transaction-level taker buy volume: (++++/+++) imply strong supporting delta volume. (~) indicates a divergent breakout (opposite delta direction) warning of a potential fakeout or liquidity trap.",
    },
  ];

export interface StructureEvent {
  kind: "bullish" | "bearish";
  type: "BOS" | "CHoCH";
  pivotTime: number;
  breakTime: number;
  price: number;
  midTime: number;
  labelPrice: number;
  delta: number | null;
  ratio: number | null;
  grade: string;
}

export interface StructureSlot {
  line: LineHandle;
  label: LabelHandle;
  deltaLabel: LabelHandle;
}

export interface MarketStructureState {
  highStream: ReturnType<typeof ta.pivotHigh>;
  lowStream: ReturnType<typeof ta.pivotLow>;
  atr: ReturnType<typeof ta.atr>;
  highTimes: number[];
  lowTimes: number[];
  lastTrend: "bullish" | "bearish" | null;
  lastSwingHighTime: number | null;
  lastSwingHighPrice: number | null;
  lastSwingLowTime: number | null;
  lastSwingLowPrice: number | null;
  events: StructureEvent[];
  slots: StructureSlot[];
  barTimes: number[];
  deltas: (number | null)[];
  volumes: number[];
  activeHighLine: LineHandle;
  activeLowLine: LineHandle;
  activeHighLabel: LabelHandle;
  activeLowLabel: LabelHandle;
}

function candidateTime(
  times: readonly number[],
  rightBars: number,
): number | null {
  const index = times.length - rightBars - 1;
  return index >= 0 ? times[index] : null;
}

function parseHexColor(hex: string): [number, number, number] {
  let clean = hex.replace("#", "");
  if (clean.length === 3) {
    clean = clean
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function interpolateColor(targetHex: string, t: number): string {
  const [tr, tg, tb] = parseHexColor(targetHex);
  const yr = 234,
    yg = 179,
    yb = 8; // Yellow #eab308

  const r = Math.round(yr + (tr - yr) * t);
  const g = Math.round(yg + (tg - yg) * t);
  const b = Math.round(yb + (tb - yb) * t);

  return `rgb(${r}, ${g}, ${b})`;
}

export const GRADE_FULL_RATIO = 0.25;

function gradeFor(kind: "bullish" | "bearish", ratio: number | null): string {
  if (ratio === null) return "";
  const aligned = kind === "bullish" ? ratio : -ratio;
  if (aligned <= 0) return "~";
  if (aligned >= GRADE_FULL_RATIO) return "++++";
  if (aligned >= 0.15) return "+++";
  if (aligned >= 0.05) return "++";
  return "+";
}

function breakType(
  kind: "bullish" | "bearish",
  lastTrend: "bullish" | "bearish" | null,
): "BOS" | "CHoCH" {
  const opposite = kind === "bullish" ? "bearish" : "bullish";
  return lastTrend === opposite ? "CHoCH" : "BOS";
}

function spanDelta(
  state: MarketStructureState,
  pivotTime: number,
  breakTime: number,
): { delta: number | null; ratio: number | null; midTime: number } {
  const pivotIndex = state.barTimes.indexOf(pivotTime);
  const breakIndex = state.barTimes.indexOf(breakTime);
  if (pivotIndex === -1 || breakIndex === -1)
    return { delta: null, ratio: null, midTime: pivotTime };
  const midTime = state.barTimes[Math.floor((pivotIndex + breakIndex) / 2)];
  let delta = 0;
  let volume = 0;
  for (let i = pivotIndex; i <= breakIndex; i += 1) {
    const barDelta = state.deltas[i];
    if (barDelta === null) return { delta: null, ratio: null, midTime };
    delta += barDelta;
    volume += state.volumes[i];
  }
  if (volume <= 0) return { delta: null, ratio: null, midTime };
  return { delta, ratio: delta / volume, midTime };
}

function recordBreak(
  state: MarketStructureState,
  kind: "bullish" | "bearish",
  pivotTime: number,
  price: number,
  breakTime: number,
  labelPrice: number,
): void {
  const { delta, ratio, midTime } = spanDelta(state, pivotTime, breakTime);
  state.events.push({
    kind,
    type: breakType(kind, state.lastTrend),
    pivotTime,
    breakTime,
    price,
    midTime,
    labelPrice,
    delta,
    ratio,
    grade: gradeFor(kind, ratio),
  });
  if (state.events.length > MAX_STRUCTURE_OBJECTS) state.events.shift();
}

function hideSlot(slot: StructureSlot): void {
  slot.label.setText("");
  slot.line.setColor("transparent");
  slot.deltaLabel.setColor("transparent");
}

function updateRenderedEvents(
  state: MarketStructureState,
  settings: MarketStructureSettings,
): void {
  const visibleEvents = state.events.slice(-MAX_STRUCTURE_OBJECTS);
  for (let index = 0; index < state.slots.length; index += 1) {
    const slot = state.slots[index];
    const event = visibleEvents[index];
    if (!event) {
      hideSlot(slot);
      continue;
    }

    const showThisLabel =
      (event.type === "BOS" && settings.showBOS) ||
      (event.type === "CHoCH" && settings.showCHoCH);
    if (!showThisLabel) {
      hideSlot(slot);
      continue;
    }

    const color =
      event.kind === "bullish" ? settings.bullishColor : settings.bearishColor;

    slot.line.setXY1(event.pivotTime, event.price);
    slot.line.setXY2(event.breakTime, event.price);
    slot.line.setColor(color);
    slot.line.setStyle(event.type === "BOS" ? "dashed" : "solid");

    slot.label.setXY(event.midTime, event.labelPrice);
    slot.label.setText(
      event.grade === "" ? event.type : `${event.type} ${event.grade}`,
    );
    slot.label.setTextColor(color);

    if (event.ratio === null) {
      slot.deltaLabel.setColor("transparent");
      continue;
    }
    const t =
      event.grade === "~"
        ? 0
        : Math.min(Math.abs(event.ratio) / GRADE_FULL_RATIO, 1);
    slot.deltaLabel.setXY(event.pivotTime, event.price);
    slot.deltaLabel.setColor(interpolateColor(color, t));
  }
}

export const marketStructureIndicator: RuntimeIndicatorDef<
  MarketStructureState,
  MarketStructureSettings
> = {
  kind: "runtime",
  id: "marketStructure",
  label: "Market Structure Delta",
  category: "l1",
  defaultSettings: {
    swingLength: DEFAULT_SWING_LENGTH,
    showBOS: true,
    showCHoCH: true,
    showProjections: true,
    bullishColor: "#22c55e",
    bearishColor: "#ef4444",
  },
  settingsSchema: MARKET_STRUCTURE_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  readOutput: () => ({}),
  createState(settings: MarketStructureSettings): MarketStructureState {
    const L = settings.swingLength;
    return {
      highStream: ta.pivotHigh(L, L),
      lowStream: ta.pivotLow(L, L),
      atr: ta.atr(100),
      highTimes: [],
      lowTimes: [],
      lastTrend: null,
      lastSwingHighTime: null,
      lastSwingHighPrice: null,
      lastSwingLowTime: null,
      lastSwingLowPrice: null,
      events: [],
      slots: Array.from({ length: MAX_STRUCTURE_OBJECTS }, () => ({
        line: draw.line({
          time1: 0,
          price1: 0,
          time2: 0,
          price2: 0,
          color: "transparent",
          width: 1,
        }),
        label: draw.label({
          time: 0,
          price: 0,
          text: "",
          color: "transparent",
          textColor: "#ffffff",
          size: 12,
        }),
        deltaLabel: draw.label({
          time: 0,
          price: 0,
          text: "",
          color: "transparent",
          textColor: "#ffffff",
          size: 12,
        }),
      })),
      barTimes: [],
      deltas: [],
      volumes: [],
      activeHighLine: draw.line({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        color: "transparent",
        width: 1,
        style: "dotted",
      }),
      activeLowLine: draw.line({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        color: "transparent",
        width: 1,
        style: "dotted",
      }),
      activeHighLabel: draw.label({
        time: 0,
        price: 0,
        text: "",
        color: "transparent",
        textColor: "#ffffff",
        size: 11,
      }),
      activeLowLabel: draw.label({
        time: 0,
        price: 0,
        text: "",
        color: "transparent",
        textColor: "#ffffff",
        size: 11,
      }),
    };
  },
  onBar(
    ctx: IndicatorBarCtx<MarketStructureState, MarketStructureSettings>,
  ): void {
    const { bar, state, settings, replace } = ctx;
    const L = settings.swingLength;

    const totalVol = bar.volume;
    const delta_bar = barDelta(bar);

    if (!replace) {
      state.barTimes.push(bar.ts_open);
      if (state.barTimes.length > 2000) state.barTimes.shift();

      state.deltas.push(delta_bar);
      if (state.deltas.length > 2000) state.deltas.shift();

      state.volumes.push(totalVol);
      if (state.volumes.length > 2000) state.volumes.shift();

      state.highTimes.push(bar.ts_open);
      state.lowTimes.push(bar.ts_open);
      const maxWindow = L * 2 + 5;
      if (state.highTimes.length > maxWindow) state.highTimes.shift();
      if (state.lowTimes.length > maxWindow) state.lowTimes.shift();
    } else if (state.barTimes.length > 0) {
      state.barTimes[state.barTimes.length - 1] = bar.ts_open;
      state.deltas[state.deltas.length - 1] = delta_bar;
      state.volumes[state.volumes.length - 1] = totalVol;
    }

    const pivotHigh = state.highStream.push(bar.high, replace);
    const pivotLow = state.lowStream.push(bar.low, replace);

    const atr = state.atr.push(bar, replace) ?? bar.high - bar.low;
    if (!bar.closed) return;

    if (pivotHigh !== null) {
      const time = candidateTime(state.highTimes, L);
      if (time !== null) {
        state.lastSwingHighPrice = pivotHigh;
        state.lastSwingHighTime = time;
      }
    }

    if (pivotLow !== null) {
      const time = candidateTime(state.lowTimes, L);
      if (time !== null) {
        state.lastSwingLowPrice = pivotLow;
        state.lastSwingLowTime = time;
      }
    }

    if (
      state.lastSwingHighPrice !== null &&
      state.lastSwingHighTime !== null &&
      bar.close > state.lastSwingHighPrice
    ) {
      recordBreak(
        state,
        "bullish",
        state.lastSwingHighTime,
        state.lastSwingHighPrice,
        bar.ts_open,
        state.lastSwingHighPrice + atr * 0.3,
      );
      state.lastTrend = "bullish";
      state.lastSwingHighPrice = null;
    }

    if (
      state.lastSwingLowPrice !== null &&
      state.lastSwingLowTime !== null &&
      bar.close < state.lastSwingLowPrice
    ) {
      recordBreak(
        state,
        "bearish",
        state.lastSwingLowTime,
        state.lastSwingLowPrice,
        bar.ts_open,
        state.lastSwingLowPrice - atr * 0.3,
      );
      state.lastTrend = "bearish";
      state.lastSwingLowPrice = null;
    }

    if (ctx.drawNow === false) return;

    if (
      settings.showProjections &&
      state.lastSwingHighTime !== null &&
      state.lastSwingHighPrice !== null
    ) {
      state.activeHighLine.setXY1(
        state.lastSwingHighTime,
        state.lastSwingHighPrice,
      );
      state.activeHighLine.setXY2(bar.ts_open, state.lastSwingHighPrice);
      state.activeHighLine.setColor(settings.bullishColor);

      state.activeHighLabel.setXY(bar.ts_open, state.lastSwingHighPrice);
      state.activeHighLabel.setText(breakType("bullish", state.lastTrend));
      state.activeHighLabel.setTextColor(settings.bullishColor);
    } else {
      state.activeHighLine.setColor("transparent");
      state.activeHighLabel.setText("");
    }

    if (
      settings.showProjections &&
      state.lastSwingLowTime !== null &&
      state.lastSwingLowPrice !== null
    ) {
      state.activeLowLine.setXY1(
        state.lastSwingLowTime,
        state.lastSwingLowPrice,
      );
      state.activeLowLine.setXY2(bar.ts_open, state.lastSwingLowPrice);
      state.activeLowLine.setColor(settings.bearishColor);

      state.activeLowLabel.setXY(bar.ts_open, state.lastSwingLowPrice);
      state.activeLowLabel.setText(breakType("bearish", state.lastTrend));
      state.activeLowLabel.setTextColor(settings.bearishColor);
    } else {
      state.activeLowLine.setColor("transparent");
      state.activeLowLabel.setText("");
    }

    updateRenderedEvents(state, settings);
  },
};
