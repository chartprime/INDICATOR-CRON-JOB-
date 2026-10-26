import type { BarFrame, TradeFrame } from "../../types/frames";
import type { ChartBarMutation } from "./chartData";
import { withDrawOwnerScope } from "./draw/creationScope";
import {
  DEFAULT_FILL_KEY,
  overwriteLastFillPoint,
  pushFillPoint,
  type FillOptions,
  type FillPoint,
} from "./draw/fill";
import {
  overwriteBarMarkerCalls,
  plotCharCall,
  plotShapeCall,
  pushMarkerCalls,
  resetMarkerCalls,
  type MarkerCall,
} from "./draw/markers";
import { clearForIndicator, withNotificationsDeferred } from "./draw/registry";
import type { IndicatorLiquidity } from "./indicatorLiquidity";
import type { IndicatorL2 } from "./indicatorL2";
import type { BandHistoryWant, IndicatorBandHistory } from "./bandHistory";
import type { IndicatorTicks } from "./indicatorTicks";
import { flushTableCells } from "./draw/table";
import type {
  IndicatorBarCtx,
  RuntimeIndicatorDef,
  SettingsFieldSchema,
  TradeAvailability,
} from "./indicatorTypes";

const EMPTY_NAMESPACE = Object.freeze({});
const EMPTY_TRADES: readonly TradeFrame[] = Object.freeze([]);

interface ActivationRecord {
  def: RuntimeIndicatorDef<unknown, unknown>;
  /** A chart-runtime-local identity; def.id is only a logical name. */
  drawOwnerId: string;
  settings: unknown;
  state: unknown;
  lastTailTsOpen: number | null;
  outputs: Record<string, (number | null)[]>;
  colors: Record<string, (string | undefined)[]>;
  faulted: boolean;
  /** One point per bar per named band, so several fills stay positional. */
  fillPointsByKey: Map<string, (FillPoint | null)[]>;
  fillOptionsByKey: Map<string, FillOptions>;
  fills: boolean;
  markerCalls: MarkerCall[];
  pendingFillPoints: Map<string, FillPoint | null>;
  /** Bars committed so far -- what a band first used late has to backfill. */
  fillBars: number;
  pendingMarkerCalls: MarkerCall[];
  liquidity: IndicatorLiquidity | null;
  l2: IndicatorL2 | null;
  bandHistory: IndicatorBandHistory | null;
  ticks: IndicatorTicks | null;
}

export interface IndicatorRuntime {
  setActive(
    ids: ReadonlySet<string>,
    settingsById: Readonly<Record<string, unknown>>,
    bars: readonly BarFrame[],
  ): void;
  onSnapshot(bars: readonly BarFrame[]): void;
  setActiveAndReplay(
    ids: ReadonlySet<string>,
    settingsById: Readonly<Record<string, unknown>>,
    bars: readonly BarFrame[],
  ): void;
  onBar(
    bar: BarFrame,
    mutation: ChartBarMutation,
    bars: readonly BarFrame[],
    tradesForBar?: readonly TradeFrame[],
    tradeAvailability?: TradeAvailability,
  ): void;
  setLiquidity(
    liquidity: IndicatorLiquidity | null,
    bars?: readonly BarFrame[],
  ): void;
  setBandHistory(bandHistory: IndicatorBandHistory | null, bars?: readonly BarFrame[]): void;
  /** Hand over the terminal's L1 print store (or null when there is none). */
  setTicks(ticks: IndicatorTicks | null, bars?: readonly BarFrame[]): void;
  /** Replay the indicators that read `ctx.ticks`: the store took history for bars already drawn. */
  refreshTicks(bars: readonly BarFrame[]): void;
  bandHistoryWants(): BandHistoryWant[];
  onLiquidityAdvanced(bars: readonly BarFrame[]): void;
  setL2(l2: IndicatorL2 | null, bars?: readonly BarFrame[]): void;
  onL2Advanced(bars: readonly BarFrame[]): void;
  discardLeading(count: number, firstRetainedTsOpen?: number): void;
  updateSettings(
    id: string,
    nextSettings: unknown,
    bars: readonly BarFrame[],
  ): void;
  getOutput(
    id: string,
  ): Readonly<Record<string, readonly (number | null)[]>> | null;
  getLineColors(
    id: string,
  ): Readonly<Record<string, readonly (string | undefined)[]>> | null;
  getFillPoints(
    id: string,
    key?: string,
  ): {
    points: readonly (FillPoint | null)[];
    options: FillOptions | undefined;
  } | null;
  /** The bands `id` has filled, in the order it first filled them. */
  getFillKeys(id: string): readonly string[] | null;
  getMarkers(id: string): readonly MarkerCall[] | null;
  getHoverData(id: string): unknown;
  getDrawOwnerId(id: string): string | null;
  getPrimitive(id: string): unknown;
}

let nextRuntimeInstanceId = 1;

function emptyOutputs(
  def: RuntimeIndicatorDef<unknown, unknown>,
): Record<string, (number | null)[]> {
  const outputs: Record<string, (number | null)[]> = {};
  for (const line of def.lines) outputs[line.key] = [];
  return outputs;
}

function emptyColors(
  def: RuntimeIndicatorDef<unknown, unknown>,
): Record<string, (string | undefined)[]> {
  const colors: Record<string, (string | undefined)[]> = {};
  for (const line of def.lines) if (line.color) colors[line.key] = [];
  return colors;
}

function makeCtx(
  record: ActivationRecord,
  bar: BarFrame,
  replace: boolean,
  replaying: boolean,
  drawNow: boolean,
  barIndex: number,
  barCount: number,
  trades: readonly TradeFrame[] = EMPTY_TRADES,
  tradeAvailability: TradeAvailability = "HISTORICAL_UNAVAILABLE",
): IndicatorBarCtx<unknown, unknown> {
  record.pendingFillPoints.clear();
  record.pendingMarkerCalls = [];

  return {
    bar,
    trades,
    tradeAvailability,
    liquidity: (record.liquidity?.atTime
      ? record.liquidity.atTime(bar.ts_open + bar.interval_ms)
      : record.liquidity) ?? undefined,
    l2: record.l2?.atTime?.(bar.ts_open + bar.interval_ms) ?? record.l2 ?? undefined,
    bandHistory: record.bandHistory ?? undefined,
    ticks: record.ticks ?? undefined,
    state: record.state,
    settings: record.settings,
    replace,
    replaying,
    drawNow,
    barIndex,
    barCount,
    ta: EMPTY_NAMESPACE,
    draw: {
      fill(valueA, valueB, options, key = DEFAULT_FILL_KEY) {
        record.fills = true;
        record.pendingFillPoints.set(
          key,
          valueA !== null && valueB !== null
            ? { time: bar.ts_open, valueA, valueB }
            : null,
        );
        if (options) record.fillOptionsByKey.set(key, options);
      },
    },
    markers: {
      plotshape(options) {
        record.pendingMarkerCalls.push(plotShapeCall(bar.ts_open, options));
      },
      plotchar(options) {
        record.pendingMarkerCalls.push(plotCharCall(bar.ts_open, options));
      },
    },
    pane: { paneIndex: 0 },
  };
}

/**
 * Commits this bar's draw.fill/markers.plotshape/plotchar/table.cell calls,
 * once per bar-transition (never once per call inside onBar) -- the same
 * discipline pushOutput/overwriteLastOutput already give the numeric line
 * channel, extended to the per-bar declarative draw channels.
 */
function commitDrawFlush(
  record: ActivationRecord,
  bar: BarFrame,
  replace: boolean,
): void {
  for (const [key, points] of record.fillPointsByKey) {
    const point = record.pendingFillPoints.get(key) ?? null;
    if (replace) overwriteLastFillPoint(points, point);
    else pushFillPoint(points, point);
  }
  // A band first filled on this bar has no history: backfill it with the bars
  // it did not exist for, so every band's points stay one per bar.
  for (const key of record.pendingFillPoints.keys()) {
    if (record.fillPointsByKey.has(key)) continue;
    // On a re-delivery of the newest bar that bar is already counted, so it takes the band's first point.
    const points: (FillPoint | null)[] = new Array(replace ? Math.max(0, record.fillBars - 1) : record.fillBars).fill(null);
    points.push(record.pendingFillPoints.get(key) ?? null);
    record.fillPointsByKey.set(key, points);
  }
  if (!replace) record.fillBars += 1;
  if (replace) {
    overwriteBarMarkerCalls(
      record.markerCalls,
      bar.ts_open,
      record.pendingMarkerCalls,
    );
  } else {
    pushMarkerCalls(record.markerCalls, record.pendingMarkerCalls);
  }
  flushTableCells(record.drawOwnerId);
}

function fault(record: ActivationRecord, reason: string, error: unknown): void {
  record.faulted = true;
  console.error(
    `indicator "${record.def.id}" ${reason} and has been disabled until it is re-activated`,
    error,
  );
}

function runOnBar(
  record: ActivationRecord,
  ctx: IndicatorBarCtx<unknown, unknown>,
): boolean {
  try {
    record.def.onBar(ctx);
    return true;
  } catch (error) {
    fault(record, "threw inside onBar", error);
    return false;
  }
}

function readOutputSafely(
  record: ActivationRecord,
): Record<string, number | null> | null {
  try {
    const output = record.def.readOutput(record.state);
    if (
      output === null ||
      typeof output !== "object" ||
      Array.isArray(output)
    ) {
      fault(record, "returned an invalid output record", output);
      return null;
    }
    return output;
  } catch (error) {
    fault(record, "threw inside readOutput", error);
    return null;
  }
}

function colorSafely(
  record: ActivationRecord,
  key: string,
): string | undefined {
  const line = record.def.lines.find((candidate) => candidate.key === key);
  if (!line?.color) return undefined;
  try {
    const color = line.color(record.state, record.settings);
    if (typeof color !== "string" || color.trim() === "") {
      fault(record, `returned an invalid color for line "${key}"`, color);
      return undefined;
    }
    return color;
  } catch (error) {
    fault(record, `threw inside color for line "${key}"`, error);
    return undefined;
  }
}

function recolorAll(
  record: ActivationRecord,
): "RECOLORED" | "REPLAY_REQUIRED" | "FAULTED" {
  for (const key of Object.keys(record.colors)) {
    const line = record.def.lines.find((candidate) => candidate.key === key);
    if (!line?.recolor) return "REPLAY_REQUIRED";
    const colors = record.colors[key];
    for (let index = 0; index < colors.length; index += 1) {
      try {
        const color = line.recolor(colors[index], record.settings);
        if (typeof color !== "string" || color.trim() === "") {
          fault(
            record,
            `returned an invalid recolor value for line "${key}"`,
            color,
          );
          return "FAULTED";
        }
        colors[index] = color;
      } catch (error) {
        fault(record, `threw inside recolor for line "${key}"`, error);
        return "FAULTED";
      }
    }
  }
  return "RECOLORED";
}

function normalizedOutputValues(
  record: ActivationRecord,
): Record<string, number | null> | null {
  const values = readOutputSafely(record);
  if (!values) return null;
  const normalized: Record<string, number | null> = {};
  for (const key of Object.keys(record.outputs)) {
    const value = values[key];
    if (value === undefined || value === null) {
      normalized[key] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fault(
        record,
        `returned an invalid numeric value for line "${key}"`,
        value,
      );
      return null;
    }
    normalized[key] = value;
  }
  return normalized;
}

function pushOutput(record: ActivationRecord): void {
  const values = normalizedOutputValues(record);
  if (!values) return;
  for (const key of Object.keys(record.outputs)) {
    record.outputs[key].push(values[key] ?? null);
  }
  for (const key of Object.keys(record.colors)) {
    const color = colorSafely(record, key);
    if (record.faulted) return;
    record.colors[key].push(color);
  }
}

function overwriteLastOutput(record: ActivationRecord): void {
  const values = normalizedOutputValues(record);
  if (!values) return;
  for (const key of Object.keys(record.outputs)) {
    const line = record.outputs[key];
    if (line.length === 0) {
      line.push(values[key] ?? null);
      continue;
    }
    line[line.length - 1] = values[key] ?? null;
  }
  for (const key of Object.keys(record.colors)) {
    const color = colorSafely(record, key);
    if (record.faulted) return;
    const line = record.colors[key];
    if (line.length === 0) {
      line.push(color);
      continue;
    }
    line[line.length - 1] = color;
  }
}

function fullReplay(record: ActivationRecord, bars: readonly BarFrame[]): void {
  if (record.faulted) return;
  withNotificationsDeferred(() => replayInto(record, bars));
}

function replayInto(record: ActivationRecord, bars: readonly BarFrame[]): void {
  try {
    record.state = withDrawOwnerScope(record.drawOwnerId, () =>
      record.def.createState(record.settings),
    );
  } catch (error) {
    fault(record, "threw inside createState", error);
    return;
  }
  record.outputs = emptyOutputs(record.def);
  record.colors = emptyColors(record.def);
  record.fillPointsByKey.clear();
  record.fillOptionsByKey.clear();
  record.fillBars = 0;
  record.fills = false;
  resetMarkerCalls(record.markerCalls);
  record.lastTailTsOpen = null;
  const replayBars =
    record.def.maxReplayBars === undefined
      ? bars
      : bars.slice(-record.def.maxReplayBars);
  const lastClosed = replayBars.findLastIndex((bar) => bar.closed);
  for (let index = 0; index < replayBars.length; index += 1) {
    const bar = replayBars[index];
    if (!runOnBar(record, makeCtx(record, bar, false, true, index >= lastClosed, index, replayBars.length))) return;
    pushOutput(record);
    if (record.faulted) return;
    commitDrawFlush(record, bar, false);
    record.lastTailTsOpen = bar.ts_open;
  }
}

function fieldKeyChanged<T>(
  field: SettingsFieldSchema<T>,
  oldSettings: T,
  newSettings: T,
): boolean {
  if (field.kind === "staticHint") return false;
  if (field.kind === "custom") {
    if (field.key === undefined) return false;
    return oldSettings[field.key] !== newSettings[field.key];
  }
  return oldSettings[field.key] !== newSettings[field.key];
}

/**
 * A custom field with no declared `key` can write anywhere in T, so its
 * own change can't be scoped to one property -- the only safe signal is
 * "something, somewhere, changed." A custom field that DOES declare a
 * `key` is handled by the normal per-field sweep below instead, so an
 * unrelated sibling field's change no longer forces its unnecessary
 * whole-object fallback too (found during TA.05's audit: this used to
 * poison every settings change, including purely cosmetic ones, into a
 * full replay whenever any custom recompute field existed at all).
 */
function hasUnkeyedCustomRecomputeField<T>(
  schema: readonly SettingsFieldSchema<T>[],
): boolean {
  return schema.some(
    (field) =>
      field.kind === "custom" &&
      field.affects === "recompute" &&
      field.key === undefined,
  );
}

function settingsRequireRecompute(
  def: RuntimeIndicatorDef<unknown, unknown>,
  oldSettings: unknown,
  newSettings: unknown,
): boolean {
  const schema = def.settingsSchema;
  if (!schema) return true;
  if (
    hasUnkeyedCustomRecomputeField(schema) &&
    JSON.stringify(oldSettings) !== JSON.stringify(newSettings)
  )
    return true;
  return schema.some(
    (field) =>
      field.kind !== "staticHint" &&
      field.affects === "recompute" &&
      fieldKeyChanged(field, oldSettings, newSettings),
  );
}

function assertRuntimeDefinitions(
  defs: readonly RuntimeIndicatorDef<unknown, unknown>[],
): void {
  const ids = new Set<string>();
  for (const def of defs) {
    if (ids.has(def.id))
      throw new Error(`indicator runtime: duplicate indicator id "${def.id}"`);
    ids.add(def.id);
    if (def.crossAttachments && def.crossAttachments.length > 0) {
      throw new Error(
        `indicator runtime: indicator "${def.id}" declares crossAttachments, but this mechanism is not implemented ` +
          `(getPrimitive() never resolves an attachment; see the doc comment on CrossAttachmentSpec in indicatorTypes.ts). ` +
          `Hand-wire the attach/detach lifecycle directly in ChartPanel.tsx instead -- see deltaDivergenceIndicator.tsx's ` +
          `real attachment to Order Flow's CVD line for the pattern to copy.`,
      );
    }
    const lineKeys = new Set<string>();
    for (const line of def.lines) {
      if (line.key.trim() === "")
        throw new Error(
          `indicator runtime: indicator "${def.id}" has an empty line key`,
        );
      if (lineKeys.has(line.key))
        throw new Error(
          `indicator runtime: indicator "${def.id}" has duplicate line key "${line.key}"`,
        );
      lineKeys.add(line.key);
    }
  }
}

export function createIndicatorRuntime(
  defs: readonly RuntimeIndicatorDef<unknown, unknown>[],
): IndicatorRuntime {
  assertRuntimeDefinitions(defs);
  const runtimeInstanceId = nextRuntimeInstanceId;
  nextRuntimeInstanceId += 1;
  const defsById = new Map(defs.map((def) => [def.id, def]));
  const records = new Map<string, ActivationRecord>();
  let liquidity: IndicatorLiquidity | null = null;
  let l2: IndicatorL2 | null = null;
  let bandHistory: IndicatorBandHistory | null = null;
  let bandHistoryVersion: number | null = null;
  let ticks: IndicatorTicks | null = null;

  // The L2 book and the liquidity store feed the same indicators (category
  // "l2"): a new source replays them over every bar, and a source that moved
  // on recomputes the tail bar they last drew.
  function replayL2Indicators(bars: readonly BarFrame[]): void {
    if (bars.length === 0) return;
    for (const record of records.values()) {
      if (!record.faulted && record.def.category === "l2") fullReplay(record, bars);
    }
  }

  function refreshL2Tail(bars: readonly BarFrame[]): void {
    const bar = bars[bars.length - 1];
    if (bar === undefined) return;
    for (const record of records.values()) {
      if (record.faulted || record.def.category !== "l2" || record.lastTailTsOpen !== bar.ts_open) continue;
      if (!runOnBar(record, makeCtx(record, bar, true, false, true, bars.length - 1, bars.length))) continue;
      overwriteLastOutput(record);
      if (record.faulted) continue;
      commitDrawFlush(record, bar, true);
    }
  }

  function setL2(next: IndicatorL2 | null, bars: readonly BarFrame[] = []): void {
    if (next === l2) return;
    l2 = next;
    for (const record of records.values()) record.l2 = next;
    replayL2Indicators(bars);
  }

  function setLiquidity(
    next: IndicatorLiquidity | null,
    bars: readonly BarFrame[] = [],
  ): void {
    if (next === liquidity) return;
    liquidity = next;
    for (const record of records.values()) record.liquidity = next;
    replayL2Indicators(bars);
  }

  function setBandHistory(next: IndicatorBandHistory | null, bars: readonly BarFrame[] = []): void {
    const version = next?.version ?? null;
    if (next === bandHistory && version === bandHistoryVersion) return;
    bandHistory = next;
    bandHistoryVersion = version;
    for (const record of records.values()) record.bandHistory = next;
    if (bars.length === 0) return;
    for (const record of records.values()) {
      if (!record.faulted && record.def.bandHistoryWanted !== undefined) fullReplay(record, bars);
    }
  }

  function bandHistoryWants(): BandHistoryWant[] {
    const wants: BandHistoryWant[] = [];
    for (const record of records.values()) {
      if (record.faulted || record.def.bandHistoryWanted === undefined || record.state === undefined) continue;
      wants.push(...record.def.bandHistoryWanted(record.state));
    }
    return wants;
  }

  /**
   * A print store is handed over once per pair (and nulled when the pair changes
   * or the store goes away), so a replay here is what backfills the bars that
   * were drawn before it existed. Only the indicators that declare
   * `ticksWanted` are replayed -- for everyone else this is a pointer swap.
   * Prints arriving afterwards need no hook at all: `ticks` reads the store
   * live, so the next `onBar` for a bar already sees them.
   */
  function setTicks(next: IndicatorTicks | null, bars: readonly BarFrame[] = []): void {
    if (next === ticks) return;
    ticks = next;
    for (const record of records.values()) record.ticks = next;
    refreshTicks(bars);
  }

  function refreshTicks(bars: readonly BarFrame[]): void {
    if (bars.length === 0) return;
    for (const record of records.values()) {
      if (!record.faulted && record.def.ticksWanted === true) fullReplay(record, bars);
    }
  }

  function setActive(
    ids: ReadonlySet<string>,
    settingsById: Readonly<Record<string, unknown>>,
    bars: readonly BarFrame[],
  ): void {
    for (const id of [...records.keys()]) {
      if (!ids.has(id)) {
        const record = records.get(id);
        records.delete(id);
        if (record) clearForIndicator(record.drawOwnerId);
      }
    }
    for (const id of ids) {
      if (records.has(id)) continue;
      const def = defsById.get(id);
      if (!def) continue;
      const settings = settingsById[id] ?? def.defaultSettings;
      const record: ActivationRecord = {
        def,
        drawOwnerId: `runtime:${runtimeInstanceId}:${id}`,
        settings,
        state: undefined,
        lastTailTsOpen: null,
        outputs: emptyOutputs(def),
        colors: emptyColors(def),
        faulted: false,
        fillPointsByKey: new Map(),
        fillOptionsByKey: new Map(),
        fills: false,
        markerCalls: [],
        liquidity,
        l2,
        bandHistory,
        ticks,
        pendingFillPoints: new Map(),
        fillBars: 0,
        pendingMarkerCalls: [],
      };
      records.set(id, record);
      fullReplay(record, bars);
    }
  }

  function onSnapshot(bars: readonly BarFrame[]): void {
    for (const record of records.values()) fullReplay(record, bars);
  }

  function setActiveAndReplay(
    ids: ReadonlySet<string>,
    settingsById: Readonly<Record<string, unknown>>,
    bars: readonly BarFrame[],
  ): void {
    setActive(ids, settingsById, []);
    onSnapshot(bars);
  }

  function onBar(
    bar: BarFrame,
    mutation: ChartBarMutation,
    bars: readonly BarFrame[],
    tradesForBar: readonly TradeFrame[] = EMPTY_TRADES,
    tradeAvailability: TradeAvailability = "HISTORICAL_UNAVAILABLE",
  ): void {
    if (mutation === "REJECTED_REOPEN") return;
    if (mutation === "REBUILT") {
      for (const record of records.values()) fullReplay(record, bars);
      return;
    }
    for (const record of records.values()) {
      if (record.faulted) continue;
      if (mutation === "APPENDED") {
        if (
          !runOnBar(
            record,
            makeCtx(record, bar, false, false, true, bars.length - 1, bars.length, tradesForBar, tradeAvailability),
          )
        )
          continue;
        pushOutput(record);
        if (record.faulted) continue;
        commitDrawFlush(record, bar, false);
        record.lastTailTsOpen = bar.ts_open;
        continue;
      }
      if (record.lastTailTsOpen !== bar.ts_open) {
        fullReplay(record, bars);
        continue;
      }
      if (
        !runOnBar(
          record,
          makeCtx(record, bar, true, false, true, bars.length - 1, bars.length, tradesForBar, tradeAvailability),
        )
      )
        continue;
      overwriteLastOutput(record);
      if (record.faulted) continue;
      commitDrawFlush(record, bar, true);
    }
  }

  function discardLeading(count: number, firstRetainedTsOpen?: number): void {
    if (!Number.isSafeInteger(count) || count <= 0) return;
    for (const record of records.values()) {
      if (record.faulted) continue;
      for (const values of Object.values(record.outputs))
        values.splice(0, count);
      for (const colors of Object.values(record.colors))
        colors.splice(0, count);
      for (const points of record.fillPointsByKey.values())
        points.splice(0, count);
      record.fillBars = Math.max(0, record.fillBars - count);
      // Markers are sparse, so their positional index does not correspond to
      // source-bar index. Trim by timestamp to keep retention bounded.
      if (
        typeof firstRetainedTsOpen === "number" &&
        Number.isFinite(firstRetainedTsOpen)
      ) {
        let writeIndex = 0;
        for (const marker of record.markerCalls) {
          if (marker.time >= firstRetainedTsOpen)
            record.markerCalls[writeIndex++] = marker;
        }
        record.markerCalls.length = writeIndex;
      }
    }
  }

  function updateSettings(
    id: string,
    nextSettings: unknown,
    bars: readonly BarFrame[],
  ): void {
    const record = records.get(id);
    if (!record || record.faulted) return;
    const needsRecompute = settingsRequireRecompute(
      record.def,
      record.settings,
      nextSettings,
    );
    record.settings = nextSettings;
    if (needsRecompute) fullReplay(record, bars);
    else if (recolorAll(record) === "REPLAY_REQUIRED") fullReplay(record, bars);
  }

  function getOutput(
    id: string,
  ): Readonly<Record<string, readonly (number | null)[]>> | null {
    const record = records.get(id);
    if (!record || record.faulted) return null;
    return record.outputs;
  }

  function getLineColors(
    id: string,
  ): Readonly<Record<string, readonly (string | undefined)[]>> | null {
    const record = records.get(id);
    if (!record || record.faulted || Object.keys(record.colors).length === 0)
      return null;
    return record.colors;
  }

  function getFillPoints(
    id: string,
    key: string = DEFAULT_FILL_KEY,
  ): {
    points: readonly (FillPoint | null)[];
    options: FillOptions | undefined;
  } | null {
    const record = records.get(id);
    if (!record || record.faulted || !record.fills) return null;
    const points = record.fillPointsByKey.get(key);
    if (points === undefined) return null;
    return { points, options: record.fillOptionsByKey.get(key) };
  }

  function getFillKeys(id: string): readonly string[] | null {
    const record = records.get(id);
    if (!record || record.faulted || !record.fills) return null;
    return [...record.fillPointsByKey.keys()];
  }

  function getMarkers(id: string): readonly MarkerCall[] | null {
    const record = records.get(id);
    if (!record || record.faulted) return null;
    return record.markerCalls;
  }

  function getHoverData(id: string): unknown {
    const record = records.get(id);
    if (!record || record.faulted || !record.def.getHoverData) return null;
    try {
      return record.def.getHoverData(record.state, record.settings);
    } catch (error) {
      fault(record, "threw inside getHoverData", error);
      return null;
    }
  }

  function getDrawOwnerId(id: string): string | null {
    return records.get(id)?.drawOwnerId ?? null;
  }

  function getPrimitive(_id: string): unknown {
    return undefined;
  }

  return {
    setActive,
    onSnapshot,
    setActiveAndReplay,
    onBar,
    setLiquidity,
    setBandHistory,
    bandHistoryWants,
    setTicks,
    refreshTicks,
    onLiquidityAdvanced: refreshL2Tail,
    setL2,
    onL2Advanced: refreshL2Tail,
    discardLeading,
    updateSettings,
    getOutput,
    getLineColors,
    getFillPoints,
    getFillKeys,
    getMarkers,
    getHoverData,
    getDrawOwnerId,
    getPrimitive,
  };
}
