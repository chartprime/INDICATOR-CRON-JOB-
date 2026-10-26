import { draw } from "../../chart/draw";
import type { BoxHandle } from "../../chart/draw/box";
import type { LineHandle } from "../../chart/draw/line";
import type { LevelStatus } from "./levelStatus";
import { shownVerdict } from "./levelWindow";
import { CHIP_FILL, CHIP_PADDING, CHIP_RADIUS, CHIP_TEXT, LEVEL_FONT_FAMILY, LEVEL_FONT_SIZE, DEFAULT_SESSION_LEVELS_SETTINGS, LEVEL_LINE_WIDTH, describeLevel, labelSpans, rangeColor, readsAsSweep, shadeOf, sharesPriceWithEarlier, shortenLevel, textOffsetFor, type Level, type SessionLevelsSettings } from "./sessionLevelsRules";
import type { Range } from "./sessionRanges";

const HIDDEN = "transparent";

export interface LevelSlot {
  line: LineHandle;
  text: BoxHandle;
}

export function createLevelSlots(count: number): LevelSlot[] {
  return Array.from({ length: count }, () => ({
    line: draw.line({ time1: 0, price1: 0, time2: 0, price2: 0, color: HIDDEN, width: LEVEL_LINE_WIDTH, style: "solid" }),
    text: draw.box({
      time1: 0, price1: 0, time2: 0, price2: 0, borderColor: HIDDEN, backgroundColor: HIDDEN, borderWidth: 0,
      text: "", textColor: HIDDEN, fontSize: LEVEL_FONT_SIZE, fontFamily: LEVEL_FONT_FAMILY, textAlign: "left", textPadding: CHIP_PADDING, cornerRadius: CHIP_RADIUS, textOverLines: true,
    }),
  }));
}

export function createRangeSlots(count: number): BoxHandle[] {
  return Array.from({ length: count }, () => draw.box({ time1: 0, price1: 0, time2: 0, price2: 0, borderColor: HIDDEN, backgroundColor: HIDDEN, borderWidth: 0 }));
}

function hide(slot: LevelSlot): void {
  slot.line.setXY1(0, 0);
  slot.line.setXY2(0, 0);
  slot.line.setColor(HIDDEN);
  slot.text.setLeftTop(0, 0);
  slot.text.setRightBottom(0, 0);
  slot.text.setText("");
  slot.text.setTextFallbacks([]);
  slot.text.setTextColor(HIDDEN);
  slot.text.setTextBackground("");
  slot.text.setTextAccent("");
}

export function lineEnd(level: Level, barTs: number): number {
  return level.touchMs ?? barTs;
}

export function renderLevels(slots: readonly LevelSlot[], levels: readonly Level[], barMs: number, barTs: number, statusOf: (level: Level) => LevelStatus | null = () => null, unit = "", settings: SessionLevelsSettings = DEFAULT_SESSION_LEVELS_SETTINGS): void {
  const shown = levels.slice(-slots.length);
  const spans = labelSpans([...new Set(shown.map((level) => level.range))], barMs);
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const level = shown[index];
    const status = level === undefined ? null : statusOf(level);
    if (level === undefined || (!settings.showSwept && readsAsSweep(shownVerdict(status?.window)))) {
      hide(slot);
      continue;
    }
    const { range, price } = level;
    const color = rangeColor(range, settings);
    const [labelFrom, labelTo] = spans.get(range) ?? [range.startMs, range.startMs];
    slot.line.setXY1(sharesPriceWithEarlier(level, shown) ? labelFrom : range.startMs, price);
    slot.line.setXY2(lineEnd(level, barTs), price);
    slot.line.setColor(color);
    slot.text.setLeftTop(labelFrom, price);
    slot.text.setRightBottom(labelTo, price);
    slot.text.setTextOffsetY(textOffsetFor(level.side));
    slot.text.setText(describeLevel(level, status, unit));
    slot.text.setTextFallbacks(shortenLevel(level, status, unit));
    slot.text.setTextColor(CHIP_TEXT);
    slot.text.setTextBackground(CHIP_FILL);
    slot.text.setTextAccent(color);
  }
}

export function renderRanges(slots: readonly BoxHandle[], ranges: readonly Range[], barMs: number, settings: SessionLevelsSettings = DEFAULT_SESSION_LEVELS_SETTINGS): void {
  const shown = ranges.slice(-slots.length);
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const range = shown[index];
    if (range === undefined) {
      slot.setLeftTop(0, 0);
      slot.setRightBottom(0, 0);
      slot.setBackgroundColor(HIDDEN);
      continue;
    }
    slot.setLeftTop(range.startMs, range.high);
    slot.setRightBottom(range.endMs + barMs, range.low);
    slot.setBackgroundColor(shadeOf(range, settings));
  }
}
