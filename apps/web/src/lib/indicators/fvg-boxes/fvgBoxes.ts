import { draw } from "../../chart/draw";
import type { BoxHandle } from "../../chart/draw/box";
import type { LineHandle } from "../../chart/draw/line";
import type { LineStyleKind } from "../../chart/draw/line";
import type {
  IndicatorBarCtx,
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import { withOpacity } from "../volume-profile/profilePeriodGeometry";
import { barSides } from "../barSides";

export const FVG_BOXES_MAX_ACTIVE_ZONES = 10;
export const FVG_BOXES_DEFAULT_MAX_DISPLAYED = 10;
export const FVG_BOXES_MAX_REPLAY_BARS = 3_000;
const MAX_STORED_EVENTS = 2000;
const VOLUME_LOOKBACK = 100;
const BULLISH_COLOR = "#0eaf87";
const BEARISH_COLOR = "#df2525";
const HIDDEN_COLOR = "transparent";
const MIN_VOLUME_BAR_DURATION_RATIO = 0.02;

export interface FVGBoxesSettings {
  maxDisplayedFVGs: number;
  volumeThreshold: number;
  showMeanLine: boolean;
  meanLineStyle: LineStyleKind;
  showTradingActivity: boolean;
  hideOverlappedFVGs: boolean;
  showBullishFVG: boolean;
  showBearishFVG: boolean;
  bullishColor: string;
  bearishColor: string;
}

interface FVGBoxEvent {
  id: string;
  kind: "bullish" | "bearish";
  startTime: number;
  levelTop: number;
  levelBottom: number;
  mitigationPrice: number;
  buyVolume: number | null;
  sellVolume: number | null;
  active: boolean;
  slot: number | null;
  zoneBox: BoxHandle | null;
  buyBox: BoxHandle | null;
  sellBox: BoxHandle | null;
  meanLine: LineHandle | null;
}

export interface FVGBoxesState {
  barTimes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  buyVolumes: (number | null)[];
  sellVolumes: (number | null)[];
  events: FVGBoxEvent[];
  zonePool: BoxHandle[];
  buyPool: BoxHandle[];
  sellPool: BoxHandle[];
  meanLinePool: LineHandle[];
}

export const FVG_BOXES_SETTINGS_SCHEMA: readonly SettingsFieldSchema<FVGBoxesSettings>[] =
  [
    {
      key: "maxDisplayedFVGs",
      label: "Max Displayed FVGs",
      kind: "numeric",
      min: 1,
      max: 100,
      step: 1,
      affects: "recompute",
    },
    {
      key: "volumeThreshold",
      label: "FVG Volume Threshold",
      kind: "numeric",
      min: 0,
      max: 1,
      step: 0.05,
      affects: "recompute",
    },
    {
      key: "showMeanLine",
      label: "Show FVG Mean Line",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "meanLineStyle",
      label: "Mean FVG Line Style",
      kind: "select",
      tab: "visibility",
      options: [
        { value: "solid", label: "Solid" },
        { value: "dashed", label: "Dashed" },
        { value: "dotted", label: "Dotted" },
      ],
      affects: "recompute",
    },
    {
      key: "showTradingActivity",
      label: "Show Trading Activity",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "hideOverlappedFVGs",
      label: "Hide Overlapped FVGs",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "showBullishFVG",
      label: "Show Bullish FVGs",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "showBearishFVG",
      label: "Show Bearish FVGs",
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
      text: "Plots the ten newest three-candle fair value gaps as boxes. A bullish zone is mitigated when a later low reaches its upper edge; a bearish zone is mitigated when a later high reaches its lower edge.",
    },
  ];

function eventId(
  kind: FVGBoxEvent["kind"],
  time: number,
  top: number,
  bottom: number,
): string {
  return `${kind}:${time}:${top}:${bottom}`;
}

function hideEvent(event: FVGBoxEvent): void {
  for (const box of [event.zoneBox, event.buyBox, event.sellBox]) {
    box?.setBorderColor(HIDDEN_COLOR);
    box?.setBackgroundColor(HIDDEN_COLOR);
    box?.setText("");
  }
  event.meanLine?.setColor(HIDDEN_COLOR);
  event.slot = null;
  event.zoneBox = null;
  event.buyBox = null;
  event.sellBox = null;
  event.meanLine = null;
}

function maxDisplayedFVGs(settings: FVGBoxesSettings): number {
  const requested = Number.isFinite(settings.maxDisplayedFVGs)
    ? settings.maxDisplayedFVGs
    : FVG_BOXES_DEFAULT_MAX_DISPLAYED;
  return Math.max(1, Math.min(100, Math.floor(requested)));
}

function normalizedVolumeThreshold(settings: FVGBoxesSettings): number {
  const requested = Number.isFinite(settings.volumeThreshold)
    ? settings.volumeThreshold
    : 0;
  return Math.max(0, Math.min(1, requested));
}

function formatVolume(volume: number): string {
  return Math.round(volume).toLocaleString("en-US");
}

function rollingHighVolume(volumes: number[], uptoIndex: number): number {
  const from = Math.max(0, uptoIndex - VOLUME_LOOKBACK + 1);
  let high = 0;
  for (let index = from; index <= uptoIndex; index += 1) {
    if (volumes[index] > high) high = volumes[index];
  }
  return high;
}

function volumeRatio(buyVolume: number, sellVolume: number): number {
  const total = Math.max(0, buyVolume) + Math.max(0, sellVolume);
  if (total <= 0) return 0.5;
  return Math.max(0, Math.min(1, Math.max(0, buyVolume) / total));
}

function refreshVisibleBoxes(
  state: FVGBoxesState,
  settings: FVGBoxesSettings,
): void {
  const visibleEvents = state.events
    .filter((event) => event.active)
    .slice(-maxDisplayedFVGs(settings));
  const visibleSet = new Set(visibleEvents);
  const usedSlots = new Set<number>();

  for (const event of state.events) {
    if (!visibleSet.has(event)) hideEvent(event);
  }

  for (const event of visibleEvents) {
    let slot = event.slot;
    if (slot === null || usedSlots.has(slot)) {
      const availableSlot = state.buyPool.findIndex(
        (_, index) => !usedSlots.has(index),
      );
      if (availableSlot < 0) continue;
      slot = availableSlot;
      event.slot = availableSlot;
      event.zoneBox = state.zonePool[availableSlot];
      event.buyBox = state.buyPool[availableSlot];
      event.sellBox = state.sellPool[availableSlot];
      event.meanLine = state.meanLinePool[availableSlot];
      event.zoneBox.setBorderColor(HIDDEN_COLOR);
      event.zoneBox.setBorderWidth(0);
      event.zoneBox.setBackgroundColor(
        withOpacity(
          event.kind === "bullish"
            ? settings.bullishColor
            : settings.bearishColor,
          0.12,
        ),
      );
      event.buyBox.setBorderColor(HIDDEN_COLOR);
      event.buyBox.setBorderWidth(0);
      event.buyBox.setBackgroundColor(withOpacity(settings.bullishColor, 0.4));
      event.buyBox.setTextColor("#ffffff");
      event.sellBox.setBorderColor(HIDDEN_COLOR);
      event.sellBox.setBorderWidth(0);
      event.sellBox.setBackgroundColor(withOpacity(settings.bearishColor, 0.4));
      event.sellBox.setTextColor("#ffffff");
      if (event.buyVolume !== null && event.sellVolume !== null) {
        const buyRatio = volumeRatio(event.buyVolume, event.sellVolume);
        event.buyBox.setText(
          `${Math.round(buyRatio * 100)}% (${formatVolume(event.buyVolume)}) `,
        );
        event.sellBox.setText(
          `${Math.round((1 - buyRatio) * 100)}% (${formatVolume(event.sellVolume)}) `,
        );
      } else {
        event.buyBox.setText("");
        event.sellBox.setText("");
      }
      event.meanLine.setWidth(1);
      event.meanLine.setStyle(settings.meanLineStyle);
    }
    usedSlots.add(slot);
  }

  for (const event of visibleEvents) {
    const knownBuyVolume = event.buyVolume;
    const knownSellVolume = event.sellVolume;
    const hasFlow = knownBuyVolume !== null && knownSellVolume !== null;
    const buyRatio =
      knownBuyVolume !== null && knownSellVolume !== null
        ? volumeRatio(knownBuyVolume, knownSellVolume)
        : 0.5;
    const splitPrice =
      event.levelBottom + (event.levelTop - event.levelBottom) / 2;
    const lastBarTime =
      state.barTimes[state.barTimes.length - 1] ?? event.startTime;
    const previousBarTime = state.barTimes[state.barTimes.length - 2];
    const intervalMs =
      previousBarTime !== undefined
        ? Math.max(1, lastBarTime - previousBarTime)
        : 60_000;
    const barSpan = Math.max(
      0,
      Math.round((lastBarTime - event.startTime) / intervalMs),
    );
    const minimumBars = Math.max(
      1,
      Math.round(barSpan * MIN_VOLUME_BAR_DURATION_RATIO),
    );
    const barsFor = (ratio: number, volume: number): number => {
      if (volume <= 0 || barSpan <= 0) return 0;
      return Math.min(
        barSpan,
        Math.max(minimumBars, Math.round(barSpan * ratio)),
      );
    };
    const buyBars = hasFlow ? barsFor(buyRatio, event.buyVolume ?? 0) : 0;
    const sellBars = hasFlow
      ? barsFor(1 - buyRatio, event.sellVolume ?? 0)
      : 0;
    const buyEndTime =
      buyBars > 0 ? event.startTime + buyBars * intervalMs : event.startTime;
    const sellEndTime =
      sellBars > 0 ? event.startTime + sellBars * intervalMs : event.startTime;
    event.buyBox?.setBorderColor(HIDDEN_COLOR);
    event.buyBox?.setBorderWidth(0);
    event.buyBox?.setBackgroundColor(withOpacity(settings.bullishColor, 0.55));
    event.sellBox?.setBorderColor(HIDDEN_COLOR);
    event.sellBox?.setBorderWidth(0);
    event.sellBox?.setBackgroundColor(withOpacity(settings.bearishColor, 0.55));
    event.zoneBox?.setBorderColor(HIDDEN_COLOR);
    event.zoneBox?.setBorderWidth(0);
    event.zoneBox?.setBackgroundColor(
      withOpacity(
        event.kind === "bullish"
          ? settings.bullishColor
          : settings.bearishColor,
        0.12,
      ),
    );
    event.zoneBox?.setLeftTop(event.startTime, event.levelTop);
    event.zoneBox?.setRightBottom(lastBarTime, event.levelBottom);
    event.meanLine?.setXY1(event.startTime, splitPrice);
    event.meanLine?.setXY2(lastBarTime, splitPrice);
    event.meanLine?.setColor(
      settings.showMeanLine
        ? event.kind === "bullish"
          ? settings.bullishColor
          : settings.bearishColor
        : HIDDEN_COLOR,
    );
    if (!settings.showTradingActivity || !hasFlow) {
      event.buyBox?.setBackgroundColor(HIDDEN_COLOR);
      event.buyBox?.setText("");
      event.sellBox?.setBackgroundColor(HIDDEN_COLOR);
      event.sellBox?.setText("");
    } else {
      event.buyBox?.setBackgroundColor(
        withOpacity(settings.bullishColor, 0.55),
      );
      event.sellBox?.setBackgroundColor(
        withOpacity(settings.bearishColor, 0.55),
      );
    }
    event.buyBox?.setLeftTop(event.startTime, event.levelTop);
    event.buyBox?.setRightBottom(buyEndTime, splitPrice);
    event.sellBox?.setLeftTop(event.startTime, splitPrice);
    event.sellBox?.setRightBottom(sellEndTime, event.levelBottom);
  }
}

export const fvgBoxesIndicator: RuntimeIndicatorDef<
  FVGBoxesState,
  FVGBoxesSettings
> = {
  kind: "runtime",
  id: "fvgBoxes",
  label: "FVG Boxes",
  category: "l1",
  maxReplayBars: FVG_BOXES_MAX_REPLAY_BARS,
  defaultSettings: {
    maxDisplayedFVGs: FVG_BOXES_DEFAULT_MAX_DISPLAYED,
    volumeThreshold: 0.15,
    showBullishFVG: true,
    showBearishFVG: true,
    showMeanLine: true,
    meanLineStyle: "dashed",
    showTradingActivity: true,
    hideOverlappedFVGs: false,
    bullishColor: BULLISH_COLOR,
    bearishColor: BEARISH_COLOR,
  },
  settingsSchema: FVG_BOXES_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  readOutput: () => ({}),
  createState: (settings) => ({
    barTimes: [],
    highs: [],
    lows: [],
    volumes: [],
    buyVolumes: [],
    sellVolumes: [],
    events: [],
    zonePool: Array.from({ length: maxDisplayedFVGs(settings) }, () =>
      draw.box({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        borderColor: HIDDEN_COLOR,
        backgroundColor: HIDDEN_COLOR,
        borderWidth: 0,
      }),
    ),
    buyPool: Array.from({ length: maxDisplayedFVGs(settings) }, () =>
      draw.box({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        borderColor: HIDDEN_COLOR,
        backgroundColor: HIDDEN_COLOR,
        borderWidth: 0,
        textColor: "#ffffff",
        textAlign: "right",
        fontSize: 9,
      }),
    ),
    sellPool: Array.from({ length: maxDisplayedFVGs(settings) }, () =>
      draw.box({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        borderColor: HIDDEN_COLOR,
        backgroundColor: HIDDEN_COLOR,
        borderWidth: 0,
        textColor: "#ffffff",
        textAlign: "right",
        fontSize: 9,
      }),
    ),
    meanLinePool: Array.from({ length: maxDisplayedFVGs(settings) }, () =>
      draw.line({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        color: HIDDEN_COLOR,
        width: 1,
        style: "solid",
      }),
    ),
  }),
  onBar: (ctx: IndicatorBarCtx<FVGBoxesState, FVGBoxesSettings>): void => {
    const { bar, state, settings, replace } = ctx;
    if (!replace) {
      state.barTimes.push(bar.ts_open);
      state.highs.push(bar.high);
      state.lows.push(bar.low);
      state.volumes.push(bar.volume);
      const pushed = barSides(bar);
      state.buyVolumes.push(pushed.known ? pushed.buy : null);
      state.sellVolumes.push(pushed.known ? pushed.sell : null);
      if (state.barTimes.length > 2000) {
        state.barTimes.shift();
        state.highs.shift();
        state.lows.shift();
        state.volumes.shift();
        state.buyVolumes.shift();
        state.sellVolumes.shift();
      }
    } else if (state.barTimes.length > 0) {
      const index = state.barTimes.length - 1;
      state.barTimes[index] = bar.ts_open;
      state.highs[index] = bar.high;
      state.lows[index] = bar.low;
      state.volumes[index] = bar.volume;
      const replaced = barSides(bar);
      state.buyVolumes[index] = replaced.known ? replaced.buy : null;
      state.sellVolumes[index] = replaced.known ? replaced.sell : null;
    }

    if (!bar.closed) return;

    for (const event of state.events) {
      if (!event.active) continue;
      const mitigated =
        event.kind === "bullish"
          ? bar.low <= event.mitigationPrice
          : bar.high >= event.mitigationPrice;
      if (mitigated) {
        event.active = false;
        hideEvent(event);
      }
    }

    const length = state.barTimes.length;
    if (length < 3) return;
    const leftIndex = length - 3;
    const rightIndex = length - 1;
    const leftTime = state.barTimes[leftIndex];
    const bullishGap = state.lows[rightIndex] - state.highs[leftIndex];
    const bearishGap = state.lows[leftIndex] - state.highs[rightIndex];
    const candidates: Array<{
      kind: FVGBoxEvent["kind"];
      top: number;
      bottom: number;
      mitigationPrice: number;
    }> = [];

    if (settings.showBullishFVG && bullishGap > 0) {
      candidates.push({
        kind: "bullish",
        top: state.lows[rightIndex],
        bottom: state.highs[leftIndex],
        mitigationPrice: state.lows[rightIndex],
      });
    }
    if (settings.showBearishFVG && bearishGap > 0) {
      candidates.push({
        kind: "bearish",
        top: state.lows[leftIndex],
        bottom: state.highs[rightIndex],
        mitigationPrice: state.highs[rightIndex],
      });
    }

    for (const candidate of candidates) {
      if (
        settings.hideOverlappedFVGs &&
        state.events.some(
          (event) =>
            event.active &&
            candidate.bottom <= event.levelTop &&
            candidate.top >= event.levelBottom,
        )
      ) {
        continue;
      }
      const fvgVolume = state.volumes[rightIndex];
      const highVolume = rollingHighVolume(state.volumes, rightIndex);
      const volumeRatioToRollingHigh =
        highVolume > 0 ? fvgVolume / highVolume : 0;
      if (volumeRatioToRollingHigh < normalizedVolumeThreshold(settings))
        continue;
      const id = eventId(
        candidate.kind,
        leftTime,
        candidate.top,
        candidate.bottom,
      );
      if (state.events.some((event) => event.id === id)) continue;
      if (state.events.length >= MAX_STORED_EVENTS) {
        const staleIndex = state.events.findIndex((event) => !event.active);
        state.events.splice(staleIndex >= 0 ? staleIndex : 0, 1);
      }
      state.events.push({
        id,
        kind: candidate.kind,
        startTime: leftTime,
        levelTop: candidate.top,
        levelBottom: candidate.bottom,
        mitigationPrice: candidate.mitigationPrice,
        buyVolume: state.buyVolumes[rightIndex],
        sellVolume: state.sellVolumes[rightIndex],
        active: true,
        slot: null,
        zoneBox: null,
        buyBox: null,
        sellBox: null,
        meanLine: null,
      });
    }

    refreshVisibleBoxes(state, settings);
  },
};
