import type { BarFrame } from "../../../types/frames";
import type { IndicatorBarCtx, RuntimeIndicatorDef } from "../../chart/indicatorTypes";
import type { IndicatorLiquidity } from "../../chart/indicatorLiquidity";
import type { BandHistoryWant, IndicatorBandHistory } from "../../chart/bandHistory";
import type { BoxHandle } from "../../chart/draw/box";
import { absorptionFloorFor, absorptionSharesFor } from "../absorption-detector/absorptionSettings";
import { bandRowsFor, sizeUnitFor } from "../institutional-order-blocks-v2/institutionalV2Rules";
import { bandFactorFor } from "../passive-liquidity/liquiditySettings";
import { KILLZONE_MAX_INTERVAL_MS } from "../killzones/killzonesIndicator";
import type { LevelRules } from "./levelReader";
import { levelWant, rangeWant, readLevelRecording, readRangeRecording } from "./levelRecording";
import { shownVerdict } from "./levelWindow";
import { advanceLevel, applyRecording, createLevelStatus, needsRecording, type LevelStatus } from "./levelStatus";
import { readRangeStats, type RangeStats } from "./rangeStats";
import { levelHovers, rangeKey, type SessionLevelHover } from "./sessionLevelsHover";
import { createLevelSlots, createRangeSlots, renderLevels, renderRanges, type LevelSlot } from "./sessionLevelsRender";
import { DEFAULT_SESSION_LEVELS_SETTINGS, MAX_LEVELS, SESSION_LEVELS_SETTINGS_SCHEMA, levelKey, levelsOf, readsAsSweep, type Level, type SessionLevelsSettings } from "./sessionLevelsRules";
import { MAX_RANGES, applyBar, createRangeBuilder, type RangeBuilder } from "./sessionRanges";

export const MAX_KEPT_BARS = 2_000;

export interface SessionLevelsState {
  builder: RangeBuilder;
  slots: LevelSlot[];
  rangeSlots: BoxHandle[];
  statuses: Map<string, LevelStatus>;
  rangeStats: Map<string, RangeStats>;
  rangeWants: Map<string, BandHistoryWant>;
  hovers: SessionLevelHover[];
  bars: BarFrame[];
  rowWidth: number;
  epoch: number | null;
}

function keepBar(bars: BarFrame[], bar: BarFrame): void {
  const last = bars[bars.length - 1];
  if (last !== undefined && bar.ts_open < last.ts_open) return;
  if (last !== undefined && bar.ts_open === last.ts_open) bars[bars.length - 1] = bar;
  else bars.push(bar);
  if (bars.length > MAX_KEPT_BARS) bars.shift();
}

function advanceLevels(state: SessionLevelsState, levels: readonly Level[], bar: BarFrame, liquidity: IndicatorLiquidity, rules: LevelRules): void {
  for (const level of levels) {
    const key = levelKey(level);
    let status = state.statuses.get(key);
    if (status === undefined) {
      status = createLevelStatus();
      state.statuses.set(key, status);
    }
    advanceLevel(status, level, bar, liquidity.feed, liquidity.rowWidth, rules, state.bars);
  }
}

function readRecordedLevels(state: SessionLevelsState, levels: readonly Level[], bar: BarFrame, bands: IndicatorBandHistory | null, rowWidth: number, rules: LevelRules): void {
  for (const level of levels) {
    const status = state.statuses.get(levelKey(level));
    if (status === undefined) continue;
    if (status.want === null && needsRecording(status)) status.want = levelWant(level, bar.interval_ms, rowWidth, rules.bandRows);
    if (status.want === null) continue;
    const answer = bands?.feedFor(status.want.key) ?? null;
    if (answer === null) continue;
    if (status.recordedFrom !== answer.feed.fine.columns) {
      status.recordedFrom = answer.feed.fine.columns;
      status.recorded = readLevelRecording(answer, level, bar.interval_ms, state.bars, rules);
    }
    applyRecording(status);
  }
}

function wantsOf(state: SessionLevelsState): BandHistoryWant[] {
  const wants = [...state.rangeWants.values()];
  for (const status of state.statuses.values()) if (status.want !== null) wants.push(status.want);
  return wants;
}

export const sessionLevelsIndicator: RuntimeIndicatorDef<SessionLevelsState, SessionLevelsSettings> = {
  kind: "runtime",
  id: "sessionLevels",
  label: "Session Levels",
  category: "session",
  defaultSettings: DEFAULT_SESSION_LEVELS_SETTINGS,
  settingsSchema: SESSION_LEVELS_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  timeframeGate: (intervalMs) => intervalMs <= KILLZONE_MAX_INTERVAL_MS,
  readOutput: () => ({}),
  bandHistoryWanted: wantsOf,
  createState(): SessionLevelsState {
    return { builder: createRangeBuilder(), slots: createLevelSlots(MAX_LEVELS), rangeSlots: createRangeSlots(MAX_RANGES), statuses: new Map(), rangeStats: new Map(), rangeWants: new Map(), hovers: [], bars: [], rowWidth: NaN, epoch: null };
  },
  onBar(ctx: IndicatorBarCtx<SessionLevelsState, SessionLevelsSettings>): void {
    const { bar, state, settings, liquidity, bandHistory } = ctx;
    applyBar(state.builder, bar, settings);
    keepBar(state.bars, bar);
    const levels = levelsOf(state.builder.ranges);
    if (liquidity && liquidity.rowWidth > 0) {
      const rules: LevelRules = { bandRows: bandRowsFor(bar) * bandFactorFor(bar.interval_ms), floor: absorptionFloorFor(bar, bar.interval_ms), share: absorptionSharesFor(bar)[0] };
      if (liquidity.rowWidth !== state.rowWidth || liquidity.feed.epoch !== state.epoch) {
        for (const [key, status] of state.statuses) if (status.window === null || status.window.open || status.window.verdict === null) state.statuses.delete(key);
        state.rangeStats.clear();
        state.rowWidth = liquidity.rowWidth;
        state.epoch = liquidity.feed.epoch;
        for (const kept of state.bars) if (kept.ts_open < bar.ts_open) advanceLevels(state, levels, kept, liquidity, rules);
      }
      advanceLevels(state, levels, bar, liquidity, rules);
      readRecordedLevels(state, levels, bar, bandHistory ?? null, liquidity.rowWidth, rules);
      for (const range of state.builder.ranges) {
        const key = rangeKey(range);
        if (state.rangeStats.has(key)) continue;
        const stats = readRangeStats(liquidity.feed, range.startMs, range.endMs + bar.interval_ms);
        if (stats !== null) {
          state.rangeStats.set(key, stats);
          continue;
        }
        let want = state.rangeWants.get(key);
        if (want === undefined) {
          want = rangeWant(range, bar.interval_ms);
          state.rangeWants.set(key, want);
        }
        const answer = bandHistory?.feedFor(want.key) ?? null;
        const recorded = answer === null ? null : readRangeRecording(answer, range, bar.interval_ms);
        if (recorded !== null) state.rangeStats.set(key, recorded);
      }
    }
    const rangeKeys = new Set(state.builder.ranges.map(rangeKey));
    for (const key of state.rangeStats.keys()) if (!rangeKeys.has(key)) state.rangeStats.delete(key);
    for (const key of state.rangeWants.keys()) if (!rangeKeys.has(key)) state.rangeWants.delete(key);
    const keys = new Set(levels.map(levelKey));
    for (const key of state.statuses.keys()) if (!keys.has(key)) state.statuses.delete(key);
    renderRanges(state.rangeSlots, state.builder.ranges, bar.interval_ms, settings);
    const statusOf = (level: Level): LevelStatus | null => state.statuses.get(levelKey(level)) ?? null;
    renderLevels(state.slots, levels, bar.interval_ms, bar.ts_open, statusOf, sizeUnitFor(bar), settings);
    const hoverable = levels.filter((level) => settings.showSwept || !readsAsSweep(shownVerdict(statusOf(level)?.window)));
    state.hovers = levelHovers(hoverable, bar.interval_ms, bar.ts_open, (range) => state.rangeStats.get(rangeKey(range)) ?? null, sizeUnitFor(bar), statusOf);
  },
  getHoverData: (state): SessionLevelHover[] => state.hovers,
};
