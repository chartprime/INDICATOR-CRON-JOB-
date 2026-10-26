import { draw } from "../../chart/draw";
import type { BoxHandle } from "../../chart/draw/box";
import type { LabelHandle } from "../../chart/draw/label";
import type { LineHandle } from "../../chart/draw/line";
import type {
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import type { Stream } from "../../chart/ta/stream";
import { ta } from "../../chart/ta";
import {
  computeSwingProfileBins,
  computeSwingValueArea,
  type SwingProfileBin,
  type SwingValueArea,
} from "./swingAlphabetProfileBins";
import {
  computeSwingVolumeBubbles,
  type SwingBubbleBar,
  type SwingVolumeBubble,
} from "./swingAlphabetProfileBubbles";

export const SWING_ALPHABET_PROFILE_MAX_SWING_LINES = 200;
export const SWING_ALPHABET_PROFILE_DEFAULT_MAX_SWING_LINES = 10;
export const SWING_ALPHABET_PROFILE_DEFAULT_SWING_LENGTH = 100;
export const SWING_ALPHABET_PROFILE_MAX_REPLAY_BARS = 5_000;
export const SWING_ALPHABET_PROFILE_MAX_PROFILE_BINS = 5_000;
export const SWING_ALPHABET_PROFILE_DEFAULT_MAX_PROFILE_BINS = 2_000;
export const SWING_ALPHABET_PROFILE_DEFAULT_PROFILE_RESOLUTION = 0.5;
export const SWING_ALPHABET_PROFILE_DEFAULT_PROFILE_WIDTH_LEN = 20;
export const SWING_ALPHABET_PROFILE_DEFAULT_BUBBLE_MIN_PERCENT = 50;
const SWING_ALPHABET_PROFILE_ATR_LENGTH = 200;
const SWING_ALPHABET_PROFILE_MAX_LEG_BARS = 5_000;
const SWING_ALPHABET_PROFILE_MAX_DEV_BINS = 500;
const SWING_ALPHABET_PROFILE_MAX_BUBBLES = 600;
const SWING_ALPHABET_PROFILE_MAX_DEV_BUBBLES = 200;

const HIDDEN_COLOR = "rgba(0, 0, 0, 0)";
const BUBBLE_TEXT_COLOR = "#ffffff";
const SWING_LINE_WIDTH = 1;

export interface SwingAlphabetProfileSettings {
  swingLength: number;
  showSwings: boolean;
  swingLineColor: string;
  maxSwingLines: number;
  showProfile: boolean;
  profileResolution: number;
  profileWidthLen: number;
  profileTextColor: string;
  maxProfileBins: number;
  showValueArea: boolean;
  valueAreaPercent: number;
  valueAreaColor: string;
  valueAreaLineWidth: number;
  showPoc: boolean;
  pocColor: string;
  pocLineWidth: number;
  showBubbles: boolean;
  bubbleMinPercent: number;
  bullBubbleColor: string;
  bearBubbleColor: string;
}

export const DEFAULT_SWING_ALPHABET_PROFILE_SETTINGS: SwingAlphabetProfileSettings =
  {
    swingLength: SWING_ALPHABET_PROFILE_DEFAULT_SWING_LENGTH,
    showSwings: true,
    swingLineColor: "#787b86",
    maxSwingLines: SWING_ALPHABET_PROFILE_DEFAULT_MAX_SWING_LINES,
    showProfile: true,
    profileResolution: SWING_ALPHABET_PROFILE_DEFAULT_PROFILE_RESOLUTION,
    profileWidthLen: SWING_ALPHABET_PROFILE_DEFAULT_PROFILE_WIDTH_LEN,
    profileTextColor: "#787b86",
    maxProfileBins: SWING_ALPHABET_PROFILE_DEFAULT_MAX_PROFILE_BINS,
    showValueArea: true,
    valueAreaPercent: 70,
    valueAreaColor: "#1491da",
    valueAreaLineWidth: 4,
    showPoc: true,
    pocColor: "#1491da",
    pocLineWidth: 2,
    showBubbles: true,
    bubbleMinPercent: SWING_ALPHABET_PROFILE_DEFAULT_BUBBLE_MIN_PERCENT,
    bullBubbleColor: "#26a69a",
    bearBubbleColor: "#ef5350",
  };

const SETTINGS_SCHEMA: readonly SettingsFieldSchema<SwingAlphabetProfileSettings>[] =
  [
    {
      kind: "slider",
      key: "swingLength",
      label: "Swing length",
      tab: "inputs",
      min: 10,
      max: 500,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "numeric",
      key: "maxSwingLines",
      label: "Max swing lines kept",
      tab: "inputs",
      min: 1,
      max: SWING_ALPHABET_PROFILE_MAX_SWING_LINES,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "slider",
      key: "profileResolution",
      label: "Profile resolution",
      tab: "inputs",
      min: 0.05,
      max: 1,
      step: 0.01,
      affects: "recompute",
    },
    {
      kind: "slider",
      key: "profileWidthLen",
      label: "Profile max text width",
      tab: "inputs",
      min: 5,
      max: 50,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "numeric",
      key: "maxProfileBins",
      label: "Max profile bins kept",
      tab: "inputs",
      min: 1,
      max: SWING_ALPHABET_PROFILE_MAX_PROFILE_BINS,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "slider",
      key: "valueAreaPercent",
      label: "Value area (%)",
      tab: "inputs",
      min: 1,
      max: 100,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "slider",
      key: "valueAreaLineWidth",
      label: "Value area line width",
      tab: "inputs",
      min: 1,
      max: 10,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "slider",
      key: "pocLineWidth",
      label: "POC line width",
      tab: "inputs",
      min: 1,
      max: 10,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "slider",
      key: "bubbleMinPercent",
      label: "Volume bubble threshold (%)",
      tab: "inputs",
      min: 1,
      max: 100,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "boolean",
      key: "showSwings",
      label: "Show swing structure lines",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "color",
      key: "swingLineColor",
      label: "Swing line color",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "boolean",
      key: "showProfile",
      label: "Show letter profile",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "color",
      key: "profileTextColor",
      label: "Profile text color",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "boolean",
      key: "showValueArea",
      label: "Show value area",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "color",
      key: "valueAreaColor",
      label: "Value area color",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "boolean",
      key: "showPoc",
      label: "Show point of control (POC)",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "color",
      key: "pocColor",
      label: "POC color",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "boolean",
      key: "showBubbles",
      label: "Show volume bubbles",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "color",
      key: "bullBubbleColor",
      label: "Bull bubble color",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "color",
      key: "bearBubbleColor",
      label: "Bear bubble color",
      tab: "visibility",
      affects: "recompute",
    },
  ];

interface SwingPoint {
  price: number;
  time: number;
}

export interface SwingSegment {
  time1: number;
  price1: number;
  time2: number;
  price2: number;
}

interface SwingLineSlot {
  line: LineHandle;
  active: boolean;
}

export interface ProfileBinRecord {
  anchorTime: number;
  time1: number;
  time2: number;
  priceLow: number;
  priceHigh: number;
  text: string;
  isPoc: boolean;
  isInValueArea: boolean;
}

interface ProfileBoxSlot {
  box: BoxHandle;
  active: boolean;
}

export interface ValueAreaRecord {
  time: number;
  sBottom: number;
  sTop: number;
  vahPrice: number | null;
  valPrice: number | null;
}

interface ValueAreaLineSlot {
  outlineLine: LineHandle;
  areaLine: LineHandle;
  active: boolean;
}

export interface PocRecord {
  anchorTime: number;
  time1: number;
  time2: number;
  price: number | null;
}

interface BubbleSlot {
  label: LabelHandle;
  active: boolean;
}

export interface SwingAlphabetProfileState {
  highStream: Stream<number, number>;
  lowStream: Stream<number, number>;
  atrStream: Stream<{ high: number; low: number; close: number }, number>;
  isDownMove: boolean;
  hasPending: boolean;
  prevIsDownMove: boolean | null;
  prevBarHigh: number | null;
  prevBarLow: number | null;
  prevHighestSwingHigh: number | null;
  prevLowestSwingLow: number | null;
  prevBarTime: number | null;
  pendingBarHigh: number | null;
  pendingBarLow: number | null;
  pendingHighestSwingHigh: number | null;
  pendingLowestSwingLow: number | null;
  pendingIsDownMove: boolean;
  pendingBarTime: number | null;
  highSwing: SwingPoint | null;
  lowSwing: SwingPoint | null;
  segments: SwingSegment[];
  slots: SwingLineSlot[];
  legBars: SwingBubbleBar[];
  lastLegBarTime: number | null;
  barTimes: number[];
  profileBins: ProfileBinRecord[];
  profileSlots: ProfileBoxSlot[];
  legBinCounts: number[];
  valueAreaRecords: ValueAreaRecord[];
  valueAreaSlots: ValueAreaLineSlot[];
  pocRecords: PocRecord[];
  pocSlots: SwingLineSlot[];
  bubbleRecords: SwingVolumeBubble[];
  legBubbleCounts: number[];
  bubbleSlots: BubbleSlot[];
  lastFinalizedLegStartTime: number | null;
  lastFinalizedLegEndTime: number | null;
  devProfileSlots: ProfileBoxSlot[];
  devValueAreaSlot: ValueAreaLineSlot;
  devPocSlot: SwingLineSlot;
  devBubbleSlots: BubbleSlot[];
}

function maxBinsPerLeg(settings: SwingAlphabetProfileSettings): number {
  return Math.max(
    1,
    Math.floor(settings.maxProfileBins / settings.maxSwingLines),
  );
}

function hideSlot(slot: SwingLineSlot): void {
  slot.active = false;
  slot.line.setColor(HIDDEN_COLOR);
}

function renderSlots(
  state: SwingAlphabetProfileState,
  settings: SwingAlphabetProfileSettings,
): void {
  const color = settings.showSwings ? settings.swingLineColor : HIDDEN_COLOR;
  for (let index = 0; index < state.slots.length; index += 1) {
    const slot = state.slots[index];
    const segment = state.segments[index];
    if (!segment) {
      if (slot.active) hideSlot(slot);
      continue;
    }
    slot.active = true;
    slot.line.setColor(color);
    slot.line.setXY1(segment.time1, segment.price1);
    slot.line.setXY2(segment.time2, segment.price2);
  }
}

function hideProfileSlot(slot: ProfileBoxSlot): void {
  slot.active = false;
  slot.box.setText("");
  slot.box.setTextColor(HIDDEN_COLOR);
  slot.box.setBackgroundColor(HIDDEN_COLOR);
}

const POC_BIN_TEXT_COLOR = "#8fcaec";

function renderProfileSlots(
  state: SwingAlphabetProfileState,
  settings: SwingAlphabetProfileSettings,
): void {
  const textColor = settings.showProfile
    ? settings.profileTextColor
    : HIDDEN_COLOR;
  const valueAreaTextColor = settings.showProfile
    ? settings.valueAreaColor
    : HIDDEN_COLOR;
  const pocBackgroundColor = settings.showProfile
    ? settings.pocColor
    : HIDDEN_COLOR;
  for (let index = 0; index < state.profileSlots.length; index += 1) {
    const slot = state.profileSlots[index];
    const bin = state.profileBins[index];
    if (!bin) {
      if (slot.active) hideProfileSlot(slot);
      continue;
    }
    slot.active = true;
    slot.box.setLeftTop(bin.time1, bin.priceHigh);
    slot.box.setRightBottom(bin.time2, bin.priceLow);
    slot.box.setText(bin.text);
    const isPocHighlighted = bin.isPoc && settings.showPoc;
    slot.box.setBackgroundColor(
      isPocHighlighted ? pocBackgroundColor : HIDDEN_COLOR,
    );
    slot.box.setTextColor(
      isPocHighlighted
        ? POC_BIN_TEXT_COLOR
        : bin.isInValueArea && settings.showValueArea
          ? valueAreaTextColor
          : textColor,
    );
  }
}

function hideValueAreaSlot(slot: ValueAreaLineSlot): void {
  slot.active = false;
  slot.outlineLine.setColor(HIDDEN_COLOR);
  slot.areaLine.setColor(HIDDEN_COLOR);
}

function renderValueAreaSlots(
  state: SwingAlphabetProfileState,
  settings: SwingAlphabetProfileSettings,
): void {
  const color = settings.showValueArea ? settings.valueAreaColor : HIDDEN_COLOR;
  for (let index = 0; index < state.valueAreaSlots.length; index += 1) {
    const slot = state.valueAreaSlots[index];
    const record = state.valueAreaRecords[index];
    if (!record) {
      if (slot.active) hideValueAreaSlot(slot);
      continue;
    }
    slot.active = true;
    slot.outlineLine.setColor(color);
    slot.outlineLine.setStyle("dotted");
    slot.outlineLine.setXY1(record.time, record.sTop);
    slot.outlineLine.setXY2(record.time, record.sBottom);
    if (record.vahPrice !== null && record.valPrice !== null) {
      slot.areaLine.setColor(color);
      slot.areaLine.setXY1(record.time, record.vahPrice);
      slot.areaLine.setXY2(record.time, record.valPrice);
    } else {
      slot.areaLine.setColor(HIDDEN_COLOR);
    }
  }
}

function renderPocSlots(
  state: SwingAlphabetProfileState,
  settings: SwingAlphabetProfileSettings,
): void {
  const color = settings.showPoc ? settings.pocColor : HIDDEN_COLOR;
  for (let index = 0; index < state.pocSlots.length; index += 1) {
    const slot = state.pocSlots[index];
    const record = state.pocRecords[index];
    if (!record || record.price === null) {
      if (slot.active) hideSlot(slot);
      continue;
    }
    slot.active = true;
    slot.line.setColor(color);
    slot.line.setXY1(record.time1, record.price);
    slot.line.setXY2(record.time2, record.price);
  }
}

function hideDevProfile(state: SwingAlphabetProfileState): void {
  for (const slot of state.devProfileSlots) {
    if (slot.active) hideProfileSlot(slot);
  }
  if (state.devValueAreaSlot.active) hideValueAreaSlot(state.devValueAreaSlot);
  if (state.devPocSlot.active) hideSlot(state.devPocSlot);
}

function hideBubbleSlot(slot: BubbleSlot): void {
  slot.active = false;
  slot.label.setText("");
  slot.label.setColor(HIDDEN_COLOR);
  slot.label.setTextColor(HIDDEN_COLOR);
}

function renderBubbleSlots(
  slots: readonly BubbleSlot[],
  bubbles: readonly SwingVolumeBubble[],
  settings: SwingAlphabetProfileSettings,
): void {
  // Slots hold the most recent bubbles when history overflows them.
  const offset = Math.max(0, bubbles.length - slots.length);
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const bubble = bubbles[offset + index];
    if (!bubble || !settings.showBubbles) {
      if (slot.active) hideBubbleSlot(slot);
      continue;
    }
    slot.active = true;
    slot.label.setXY(bubble.time, bubble.price);
    slot.label.setSize(bubble.sizePx);
    slot.label.setTextSize(bubble.textSizePx);
    slot.label.setText(bubble.text);
    slot.label.setColor(bubble.color);
    slot.label.setTextColor(BUBBLE_TEXT_COLOR);
  }
}

function hideDevBubbles(state: SwingAlphabetProfileState): void {
  for (const slot of state.devBubbleSlots) {
    if (slot.active) hideBubbleSlot(slot);
  }
}

/** Recomputes and redraws the still-forming leg's profile every bar -- the developing/real-time counterpart of the finalized-leg rendering above. */
function barTimeAfter(
  times: readonly number[],
  anchor: number,
  offset: number,
  latestTime: number,
  intervalMs: number,
): number {
  let lo = 0;
  let hi = times.length - 1;
  let index = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= anchor) {
      index = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (index < 0) return anchor + offset * intervalMs;
  if (index + offset < times.length) return times[index + offset];
  let tail = times[times.length - 1];
  let remaining = index + offset - (times.length - 1);
  if (latestTime > tail) {
    tail = latestTime;
    remaining -= 1;
  }
  return tail + remaining * intervalMs;
}

function resolveExtrapolatedEdges(
  state: SwingAlphabetProfileState,
  settings: SwingAlphabetProfileSettings,
  previousTail: number,
  latestTime: number,
  intervalMs: number,
): boolean {
  let changed = false;
  for (const bin of state.profileBins) {
    if (bin.time2 <= previousTail) continue;
    const time1 = barTimeAfter(state.barTimes, bin.anchorTime, 1, latestTime, intervalMs);
    const time2 = barTimeAfter(state.barTimes, bin.anchorTime, settings.profileWidthLen, latestTime, intervalMs);
    if (time1 !== bin.time1 || time2 !== bin.time2) {
      bin.time1 = time1;
      bin.time2 = time2;
      changed = true;
    }
  }
  for (const poc of state.pocRecords) {
    if (poc.time1 <= previousTail) continue;
    const time1 = barTimeAfter(state.barTimes, poc.anchorTime, settings.profileWidthLen, latestTime, intervalMs);
    if (time1 !== poc.time1) {
      poc.time1 = time1;
      changed = true;
    }
  }
  return changed;
}

function renderDevProfile(
  state: SwingAlphabetProfileState,
  settings: SwingAlphabetProfileSettings,
  bins: readonly SwingProfileBin[],
  time1: number,
  time2: number,
  devStartTime: number,
  devEndTime: number,
  sBottom: number,
  sTop: number,
  valueArea: SwingValueArea | null,
): void {
  const textColor = settings.showProfile
    ? settings.profileTextColor
    : HIDDEN_COLOR;
  const valueAreaTextColor = settings.showProfile
    ? settings.valueAreaColor
    : HIDDEN_COLOR;
  const pocBackgroundColor = settings.showProfile
    ? settings.pocColor
    : HIDDEN_COLOR;
  for (let index = 0; index < state.devProfileSlots.length; index += 1) {
    const slot = state.devProfileSlots[index];
    const bin = bins[index];
    if (!bin) {
      if (slot.active) hideProfileSlot(slot);
      continue;
    }
    slot.active = true;
    slot.box.setLeftTop(time1, bin.priceHigh);
    slot.box.setRightBottom(time2, bin.priceLow);
    slot.box.setText(bin.text);
    const isInValueArea =
      valueArea !== null &&
      index >= valueArea.valIndex &&
      index <= valueArea.vahIndex;
    const isPocHighlighted = bin.isPoc && settings.showPoc;
    slot.box.setBackgroundColor(
      isPocHighlighted ? pocBackgroundColor : HIDDEN_COLOR,
    );
    slot.box.setTextColor(
      isPocHighlighted
        ? POC_BIN_TEXT_COLOR
        : isInValueArea && settings.showValueArea
          ? valueAreaTextColor
          : textColor,
    );
  }

  const valueAreaColor = settings.showValueArea
    ? settings.valueAreaColor
    : HIDDEN_COLOR;
  state.devValueAreaSlot.active = true;
  state.devValueAreaSlot.outlineLine.setColor(valueAreaColor);
  state.devValueAreaSlot.outlineLine.setStyle("dotted");
  state.devValueAreaSlot.outlineLine.setXY1(devStartTime, sTop);
  state.devValueAreaSlot.outlineLine.setXY2(devStartTime, sBottom);
  if (valueArea !== null) {
    state.devValueAreaSlot.areaLine.setColor(valueAreaColor);
    state.devValueAreaSlot.areaLine.setXY1(devStartTime, valueArea.vahPrice);
    state.devValueAreaSlot.areaLine.setXY2(devStartTime, valueArea.valPrice);
  } else {
    state.devValueAreaSlot.areaLine.setColor(HIDDEN_COLOR);
  }

  const pocLineColor = settings.showPoc ? settings.pocColor : HIDDEN_COLOR;
  const pocBin = bins.find((bin) => bin.isPoc);
  if (pocBin) {
    state.devPocSlot.active = true;
    state.devPocSlot.line.setColor(pocLineColor);
    const pocPrice = (pocBin.priceLow + pocBin.priceHigh) / 2;
    state.devPocSlot.line.setXY1(time2, pocPrice);
    state.devPocSlot.line.setXY2(devEndTime, pocPrice);
  } else {
    hideSlot(state.devPocSlot);
  }
}

export const swingAlphabetProfileIndicator: RuntimeIndicatorDef<
  SwingAlphabetProfileState,
  SwingAlphabetProfileSettings
> = {
  kind: "runtime",
  id: "swingAlphabetProfile",
  label: "Swing Alphabet Profile",
  category: "community",
  defaultSettings: DEFAULT_SWING_ALPHABET_PROFILE_SETTINGS,
  settingsSchema: SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  maxReplayBars: SWING_ALPHABET_PROFILE_MAX_REPLAY_BARS,
  createState: (settings) => ({
    highStream: ta.highest(settings.swingLength),
    lowStream: ta.lowest(settings.swingLength),
    atrStream: ta.atr(SWING_ALPHABET_PROFILE_ATR_LENGTH),
    isDownMove: false,
    hasPending: false,
    prevIsDownMove: null,
    prevBarHigh: null,
    prevBarLow: null,
    prevHighestSwingHigh: null,
    prevLowestSwingLow: null,
    prevBarTime: null,
    pendingBarHigh: null,
    pendingBarLow: null,
    pendingHighestSwingHigh: null,
    pendingLowestSwingLow: null,
    pendingIsDownMove: false,
    pendingBarTime: null,
    highSwing: null,
    lowSwing: null,
    segments: [],
    slots: Array.from({ length: settings.maxSwingLines }, () => ({
      line: draw.line({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        color: HIDDEN_COLOR,
        width: SWING_LINE_WIDTH,
      }),
      active: false,
    })),
    legBars: [],
    lastLegBarTime: null,
    barTimes: [],
    profileBins: [],
    profileSlots: Array.from({ length: settings.maxProfileBins }, () => ({
      box: draw.box({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        borderWidth: 0,
        backgroundColor: HIDDEN_COLOR,
        textColor: HIDDEN_COLOR,
        fontSize: 9,
      }),
      active: false,
    })),
    legBinCounts: [],
    valueAreaRecords: [],
    valueAreaSlots: Array.from({ length: settings.maxSwingLines }, () => ({
      outlineLine: draw.line({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        color: HIDDEN_COLOR,
        width: SWING_LINE_WIDTH,
        style: "dotted",
      }),
      areaLine: draw.line({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        color: HIDDEN_COLOR,
        width: settings.valueAreaLineWidth,
      }),
      active: false,
    })),
    pocRecords: [],
    pocSlots: Array.from({ length: settings.maxSwingLines }, () => ({
      line: draw.line({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        color: HIDDEN_COLOR,
        width: settings.pocLineWidth,
      }),
      active: false,
    })),
    lastFinalizedLegStartTime: null,
    lastFinalizedLegEndTime: null,
    bubbleRecords: [],
    legBubbleCounts: [],
    bubbleSlots: Array.from(
      { length: SWING_ALPHABET_PROFILE_MAX_BUBBLES },
      () => ({
        label: draw.label({
          time: 0,
          price: 0,
          text: "",
          color: HIDDEN_COLOR,
          textColor: HIDDEN_COLOR,
        }),
        active: false,
      }),
    ),
    devBubbleSlots: Array.from(
      { length: SWING_ALPHABET_PROFILE_MAX_DEV_BUBBLES },
      () => ({
        label: draw.label({
          time: 0,
          price: 0,
          text: "",
          color: HIDDEN_COLOR,
          textColor: HIDDEN_COLOR,
        }),
        active: false,
      }),
    ),
    devProfileSlots: Array.from(
      { length: SWING_ALPHABET_PROFILE_MAX_DEV_BINS },
      () => ({
        box: draw.box({
          time1: 0,
          price1: 0,
          time2: 0,
          price2: 0,
          borderWidth: 0,
          backgroundColor: HIDDEN_COLOR,
          textColor: HIDDEN_COLOR,
          fontSize: 9,
        }),
        active: false,
      }),
    ),
    devValueAreaSlot: {
      outlineLine: draw.line({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        color: HIDDEN_COLOR,
        width: SWING_LINE_WIDTH,
        style: "dotted",
      }),
      areaLine: draw.line({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        color: HIDDEN_COLOR,
        width: settings.valueAreaLineWidth,
      }),
      active: false,
    },
    devPocSlot: {
      line: draw.line({
        time1: 0,
        price1: 0,
        time2: 0,
        price2: 0,
        color: HIDDEN_COLOR,
        width: settings.pocLineWidth,
      }),
      active: false,
    },
  }),
  onBar: (ctx) => {
    const { bar, state, settings, replace } = ctx;

    // Lag-1 ("[1]") snapshot advances exactly once per new bar, mirroring
    // Pine's own `high[1]`/`isDownMove[1]` semantics.
    if (!replace && state.hasPending) {
      state.prevBarHigh = state.pendingBarHigh;
      state.prevBarLow = state.pendingBarLow;
      state.prevHighestSwingHigh = state.pendingHighestSwingHigh;
      state.prevLowestSwingLow = state.pendingLowestSwingLow;
      state.prevIsDownMove = state.pendingIsDownMove;
      state.prevBarTime = state.pendingBarTime;
    }

    const highestSwingHigh = state.highStream.push(bar.high, replace);
    const lowestSwingLow = state.lowStream.push(bar.low, replace);
    const atrValue = state.atrStream.push(
      { high: bar.high, low: bar.low, close: bar.close },
      replace,
    );

    if (bar.closed && state.lastLegBarTime !== bar.ts_open) {
      state.legBars.push({
        time: bar.ts_open,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      });
      if (state.legBars.length > SWING_ALPHABET_PROFILE_MAX_LEG_BARS) {
        state.legBars.splice(
          0,
          state.legBars.length - SWING_ALPHABET_PROFILE_MAX_LEG_BARS,
        );
      }
      state.lastLegBarTime = bar.ts_open;
      const previousTail = state.barTimes.length === 0 ? -Infinity : state.barTimes[state.barTimes.length - 1];
      state.barTimes.push(bar.ts_open);
      if (state.barTimes.length > SWING_ALPHABET_PROFILE_MAX_LEG_BARS) {
        state.barTimes.splice(0, state.barTimes.length - SWING_ALPHABET_PROFILE_MAX_LEG_BARS);
      }
      if (resolveExtrapolatedEdges(state, settings, previousTail, bar.ts_open, bar.interval_ms)) {
        renderProfileSlots(state, settings);
        renderPocSlots(state, settings);
      }
    }

    if (bar.closed && highestSwingHigh !== null && lowestSwingLow !== null) {
      if (bar.high >= highestSwingHigh) state.isDownMove = true;
      if (bar.low <= lowestSwingLow) state.isDownMove = false;

      if (
        state.prevBarHigh !== null &&
        state.prevHighestSwingHigh !== null &&
        state.prevBarHigh === state.prevHighestSwingHigh &&
        bar.high < highestSwingHigh
      ) {
        state.highSwing = {
          price: state.prevBarHigh,
          time: state.prevBarTime!,
        };
      }
      if (
        state.prevBarLow !== null &&
        state.prevLowestSwingLow !== null &&
        state.prevBarLow === state.prevLowestSwingLow &&
        bar.low > lowestSwingLow
      ) {
        state.lowSwing = { price: state.prevBarLow, time: state.prevBarTime! };
      }

      if (
        state.prevIsDownMove !== null &&
        state.isDownMove !== state.prevIsDownMove &&
        state.highSwing &&
        state.lowSwing &&
        state.highSwing.time !== state.lowSwing.time
      ) {
        const [first, second] =
          state.highSwing.time < state.lowSwing.time
            ? [state.highSwing, state.lowSwing]
            : [state.lowSwing, state.highSwing];
        state.lastFinalizedLegStartTime = first.time;
        state.lastFinalizedLegEndTime = second.time;
        state.segments.push({
          time1: first.time,
          price1: first.price,
          time2: second.time,
          price2: second.price,
        });
        if (state.segments.length > settings.maxSwingLines) {
          state.segments.splice(
            0,
            state.segments.length - settings.maxSwingLines,
          );
        }
        renderSlots(state, settings);

        const bubbleBars = state.legBars.filter(
          (legBar) => legBar.time >= first.time && legBar.time < second.time,
        );
        const legBubbles = computeSwingVolumeBubbles(
          bubbleBars,
          settings.bullBubbleColor,
          settings.bearBubbleColor,
          settings.bubbleMinPercent,
        );
        state.bubbleRecords.push(...legBubbles);
        state.legBubbleCounts.push(legBubbles.length);
        if (state.legBubbleCounts.length > settings.maxSwingLines) {
          const excessBubbleLegs =
            state.legBubbleCounts.length - settings.maxSwingLines;
          let bubbleDropCount = 0;
          for (let i = 0; i < excessBubbleLegs; i += 1) {
            bubbleDropCount += state.legBubbleCounts[i];
          }
          state.legBubbleCounts.splice(0, excessBubbleLegs);
          state.bubbleRecords.splice(0, bubbleDropCount);
        }
        renderBubbleSlots(state.bubbleSlots, state.bubbleRecords, settings);

        const priceBinSize =
          atrValue !== null ? atrValue * settings.profileResolution : null;
        if (priceBinSize !== null && priceBinSize > 0) {
          const legBarsInRange = state.legBars.filter(
            (legBar) => legBar.time >= first.time && legBar.time <= second.time,
          );
          const bins = computeSwingProfileBins(
            legBarsInRange,
            first.price,
            second.price,
            priceBinSize,
            first.time,
            settings.profileWidthLen,
            maxBinsPerLeg(settings),
          );
          const time1 = barTimeAfter(state.barTimes, first.time, 1, bar.ts_open, bar.interval_ms);
          const time2 = barTimeAfter(state.barTimes, first.time, settings.profileWidthLen, bar.ts_open, bar.interval_ms);
          const valueArea = computeSwingValueArea(
            bins,
            settings.valueAreaPercent / 100,
          );
          bins.forEach((bin, binIndex) => {
            state.profileBins.push({
              anchorTime: first.time,
              time1,
              time2,
              priceLow: bin.priceLow,
              priceHigh: bin.priceHigh,
              text: bin.text,
              isPoc: bin.isPoc,
              isInValueArea:
                valueArea !== null &&
                binIndex >= valueArea.valIndex &&
                binIndex <= valueArea.vahIndex,
            });
          });

          // Caps the number of retained *profiles* (whole legs) to the same
          // count as the swing lines, rather than an unrelated raw bin count.
          if (bins.length > 0) {
            state.legBinCounts.push(bins.length);
            state.valueAreaRecords.push({
              time: first.time,
              sBottom: Math.min(first.price, second.price),
              sTop: Math.max(first.price, second.price),
              vahPrice: valueArea?.vahPrice ?? null,
              valPrice: valueArea?.valPrice ?? null,
            });
            const pocBin = bins.find((bin) => bin.isPoc);
            state.pocRecords.push({
              anchorTime: first.time,
              time1: time2,
              time2: second.time,
              price: pocBin ? (pocBin.priceLow + pocBin.priceHigh) / 2 : null,
            });
            if (state.legBinCounts.length > settings.maxSwingLines) {
              const excessLegs =
                state.legBinCounts.length - settings.maxSwingLines;
              let dropCount = 0;
              for (let i = 0; i < excessLegs; i += 1) {
                dropCount += state.legBinCounts[i];
              }
              state.legBinCounts.splice(0, excessLegs);
              state.profileBins.splice(0, dropCount);
              state.valueAreaRecords.splice(0, excessLegs);
              state.pocRecords.splice(0, excessLegs);
            }
          }
          renderProfileSlots(state, settings);
          renderValueAreaSlots(state, settings);
          renderPocSlots(state, settings);
        }

        state.legBars = state.legBars.filter(
          (legBar) => legBar.time >= second.time,
        );
      }
    }

    // Real-time profile: recomputed every bar from the earlier of the two
    // most recent swing points up to *this* bar, mirroring Pine's own
    // `barstate.islast` section -- distinct from the finalized-leg history
    // above, which only updates once a leg's trend actually flips.
    if (
      state.highSwing &&
      state.lowSwing &&
      state.highSwing.time !== state.lowSwing.time
    ) {
      const devStartPoint =
        state.highSwing.time < state.lowSwing.time
          ? state.highSwing
          : state.lowSwing;
      const justFinalizedThisBar =
        state.lastFinalizedLegStartTime === devStartPoint.time &&
        state.lastFinalizedLegEndTime === bar.ts_open;
      const priceBinSize =
        atrValue !== null ? atrValue * settings.profileResolution : null;
      const devBarsBase = state.legBars.filter(
        (legBar) =>
          legBar.time >= devStartPoint.time && legBar.time <= bar.ts_open,
      );
      const devBars = bar.closed
        ? devBarsBase
        : [
            ...devBarsBase,
            {
              time: bar.ts_open,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
            },
          ];
      if (justFinalizedThisBar) {
        hideDevBubbles(state);
      } else {
        renderBubbleSlots(
          state.devBubbleSlots,
          computeSwingVolumeBubbles(
            devBars,
            settings.bullBubbleColor,
            settings.bearBubbleColor,
            settings.bubbleMinPercent,
          ),
          settings,
        );
      }
      if (!justFinalizedThisBar && priceBinSize !== null && priceBinSize > 0) {
        const devSwingBottom = Math.min(
          state.highSwing.price,
          state.lowSwing.price,
        );
        const devSwingTop = Math.max(
          state.highSwing.price,
          state.lowSwing.price,
        );
        const devBins = computeSwingProfileBins(
          devBars,
          devSwingBottom,
          devSwingTop,
          priceBinSize,
          devStartPoint.time,
          settings.profileWidthLen,
          SWING_ALPHABET_PROFILE_MAX_DEV_BINS,
        );
        const devTime1 = barTimeAfter(state.barTimes, devStartPoint.time, 1, bar.ts_open, bar.interval_ms);
        const devTime2 = barTimeAfter(state.barTimes, devStartPoint.time, settings.profileWidthLen, bar.ts_open, bar.interval_ms);
        const devValueArea = computeSwingValueArea(
          devBins,
          settings.valueAreaPercent / 100,
        );
        renderDevProfile(
          state,
          settings,
          devBins,
          devTime1,
          devTime2,
          devStartPoint.time,
          bar.ts_open,
          devSwingBottom,
          devSwingTop,
          devValueArea,
        );
      } else {
        hideDevProfile(state);
      }
    } else {
      hideDevProfile(state);
      hideDevBubbles(state);
    }

    state.pendingBarHigh = bar.high;
    state.pendingBarLow = bar.low;
    state.pendingHighestSwingHigh = highestSwingHigh;
    state.pendingLowestSwingLow = lowestSwingLow;
    state.pendingIsDownMove = state.isDownMove;
    state.pendingBarTime = bar.ts_open;
    state.hasPending = true;
  },
  readOutput: () => ({}),
};
