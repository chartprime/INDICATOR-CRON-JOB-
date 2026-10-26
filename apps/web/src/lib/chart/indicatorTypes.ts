import type { ReactNode } from "react";
import type { BarFrame, FrameIdentity, TradeFrame } from "../../types/frames";
import type { IndicatorLiquidity } from "./indicatorLiquidity";
import type { IndicatorL2 } from "./indicatorL2";
import type { BandHistoryWant, IndicatorBandHistory } from "./bandHistory";
import type { IndicatorTicks } from "./indicatorTicks";
import type { FillOptions } from "./draw/fill";
import type { PlotCharOptions, PlotShapeOptions } from "./draw/markers";

export type IndicatorCategory =
  | "technical"
  | "l1"
  | "l2"
  | "session"
  | "community";

export type TaNamespace = Record<string, never>;

export interface DrawNamespace {
  /**
   * Fills the region between two values, bar by bar. `key` names the band, so
   * one indicator can fill more than one region at once -- an inner band and
   * the ring around it, say -- each keeping its own colour and its own point
   * per bar. Omit it for a single fill; `DEFAULT_FILL_KEY` is used.
   */
  fill(
    valueA: number | null,
    valueB: number | null,
    options?: FillOptions,
    key?: string,
  ): void;
}

export interface MarkersNamespace {
  plotshape(options: PlotShapeOptions): void;
  plotchar(options: PlotCharOptions): void;
}

export interface PaneNamespace {
  paneIndex: number;
}

/**
 * Provenance for the print array supplied to an indicator. An empty complete
 * live range is materially different from a historical range we do not have
 * or a bounded live range that overflowed before correlation.
 */
export type TradeAvailability =
  | "LIVE_COMPLETE"
  | "LIVE_PARTIAL"
  | "HISTORICAL_UNAVAILABLE";

export interface IndicatorBarCtx<S, T> {
  bar: BarFrame;
  /**
   * The individual trades observed during this displayed chart bar. Only
   * populated for a live bar going forward from activation -- every bar
   * touched by a full replay (warm-start, REBUILT, a recompute-tagged
   * settings change) gets an empty array here, honestly, since no
   * historical trade-by-range query exists yet. Read tradeAvailability
   * before interpreting an empty array as a genuine no-print bar.
   */
  trades: readonly TradeFrame[];
  /**
   * Indicators which derive signals from individual prints must not treat
   * LIVE_PARTIAL or HISTORICAL_UNAVAILABLE as an observed zero-trade bar.
   */
  tradeAvailability?: TradeAvailability;
  liquidity?: IndicatorLiquidity;
  l2?: IndicatorL2;
  bandHistory?: IndicatorBandHistory;
  /** The terminal's L1 print store, when one exists for the selected pair. */
  ticks?: IndicatorTicks;
  state: S;
  settings: T;
  replace: boolean;
  replaying: boolean;
  drawNow?: boolean;
  /**
   * Where this bar sits in the series being fed to the indicator, 0-based, and
   * how many bars that series holds. During a replay the series is the bars the
   * replay iterates (all of them, or the `maxReplayBars` slice); for a live bar
   * it is the chart's own bars, so the last one is `barCount - 1`.
   *
   * This is what lets an anchored indicator place itself a fixed number of bars
   * back from the newest one, and it only describes the series -- it says
   * nothing about whether the store can price the bar. The runtime always sets
   * both; they are optional so a hand-written context in a test can leave them
   * out, and an indicator that reads them should treat their absence as "position
   * unknown" rather than as bar zero.
   */
  barIndex?: number;
  barCount?: number;
  ta: TaNamespace;
  draw: DrawNamespace;
  markers: MarkersNamespace;
  pane: PaneNamespace;
}

export interface LineOutputSpec<S, T = unknown> {
  key: string;
  color?: (state: S, settings: T) => string;
  recolor?: (currentColor: string | undefined, settings: T) => string;
  lineWidth?: number;
}

export type PlacementSpec =
  | { kind: "overlay" }
  | {
      kind: "ownPane";
      priceLines?: readonly number[];
      autoscaleRange?: { min: number; max: number };
    }
  | { kind: "sharedPane"; withIndicatorId: string };

/**
 * NOT IMPLEMENTED (found during TA.05's audit). Declaring this on a
 * RuntimeIndicatorDef throws at registration -- createIndicatorRuntime()
 * rejects it rather than silently ignoring it. `attachToLineKey` was meant
 * to reference another indicator's `lines[].key`, but the one real case
 * that motivated this (Delta Divergence attaching to Order Flow's CVD
 * line) can't be expressed that way: Order Flow's CVD line is hand-built
 * directly in ChartPanel.tsx (lines: [] on its own def), not produced
 * through the generic `lines` output this field assumes. Building this for
 * real needs a redesign validated against a second real use case, not
 * guessed from one that doesn't even fit the current shape.
 *
 * Need to attach a primitive onto another specific indicator's own
 * (possibly bespoke) series today? There is no self-serve path yet --
 * hand-wire the attach/detach lifecycle directly in ChartPanel.tsx, the
 * way deltaDivergenceIndicator.tsx's own real Order Flow attachment does,
 * or ask whoever owns the chart pipeline. Every other placement need
 * (own pane, overlay, or sharing a pane with an SDK indicator via
 * `PlacementSpec`'s `sharedPane`) is fully self-serve already.
 */
export interface CrossAttachmentSpec {
  attachToIndicatorId: string;
  attachToLineKey: string;
  createPrimitive: () => unknown;
}

interface SettingsFieldBase<T> {
  visibleIf?: (settings: T) => boolean;
  /**
   * Where the generic dialog puts the field. `inputs` (the default) and
   * `visibility` are the two tabs. `advanced` is an input too, but rendered
   * under a collapsed "Advanced" group at the end of the Inputs tab: the
   * trader sees at most the few primary controls first and opens the rest
   * on purpose. Presets, reset and persistence treat it like any input.
   */
  tab?: "inputs" | "visibility" | "advanced";
}

export type SettingsFieldSchema<T> =
  | (SettingsFieldBase<T> & {
      kind: "boolean";
      key: keyof T;
      label: string;
      affects: "recompute" | "cosmetic" | "liveOnly";
    })
  | (SettingsFieldBase<T> & {
      kind: "checkboxList";
      key: keyof T;
      label: string;
      options: readonly { value: unknown; label: string }[];
      affects: "recompute" | "cosmetic" | "liveOnly";
    })
  | (SettingsFieldBase<T> & {
      kind: "radioGroup";
      key: keyof T;
      label: string;
      options: readonly { value: unknown; label: string; hint?: string }[];
      affects: "recompute" | "cosmetic" | "liveOnly";
    })
  | (SettingsFieldBase<T> & {
      kind: "select";
      key: keyof T;
      label: string;
      options: readonly { value: unknown; label: string }[];
      affects: "recompute" | "cosmetic" | "liveOnly";
    })
  | (SettingsFieldBase<T> & {
      kind: "numeric";
      key: keyof T;
      label: string;
      min: number;
      max: number;
      step: number;
      /**
       * A saved value outside [min, max] is brought to the nearest bound instead
       * of falling back to the default -- for fields whose bounds have tightened,
       * so a trader's setting keeps its side of the range.
       */
      clampOnRestore?: boolean;
      affects: "recompute" | "cosmetic" | "liveOnly";
    })
  | (SettingsFieldBase<T> & {
      kind: "color";
      key: keyof T;
      label: string;
      affects: "recompute" | "cosmetic" | "liveOnly";
    })
  | (SettingsFieldBase<T> & {
      kind: "slider";
      key: keyof T;
      label: string;
      min: number;
      max: number;
      step: number;
      /**
       * A saved value outside [min, max] is brought to the nearest bound instead
       * of falling back to the default -- for fields whose bounds have tightened,
       * so a trader's setting keeps its side of the range.
       */
      clampOnRestore?: boolean;
      affects: "recompute" | "cosmetic" | "liveOnly";
    })
  | (SettingsFieldBase<T> & {
      kind: "staticHint";
      text: string;
    })
  | (SettingsFieldBase<T> & {
      kind: "custom";
      /**
       * Optional: when a custom field only ever writes one settings key,
       * naming it here lets the runtime scope its recompute-change
       * detection to that key instead of the whole settings object --
       * otherwise an unrelated sibling field's change (e.g. a cosmetic
       * toggle) is indistinguishable from this field's own and forces an
       * unwanted full replay too. Omit only if the field genuinely writes
       * more than one key.
       */
      key?: keyof T;
      render: (settings: T, onChange: (next: T) => void) => ReactNode;
      isValidPersistedValue?: (value: unknown) => boolean;
      byInstrument?: boolean;
      affects: "recompute" | "cosmetic" | "liveOnly";
    });

interface IndicatorMeta {
  id: string;
  label: string;
  category: IndicatorCategory;
}

export interface RuntimeIndicatorDef<S, T> extends IndicatorMeta {
  kind: "runtime";
  createState(settings: T): S;
  onBar(ctx: IndicatorBarCtx<S, T>): void;
  readOutput(state: S): Record<string, number | null>;
  getHoverData?: (state: S, settings: T) => unknown;
  lines: readonly LineOutputSpec<S, T>[];
  defaultSettings: T;
  settingsSchema?: readonly SettingsFieldSchema<T>[];
  persistenceSchema?: readonly SettingsFieldSchema<T>[];
  settingsFieldsFor?: (identity: { symbol: string } & FrameIdentity) => Partial<Record<keyof T, SettingsFieldSchema<T>>>;
  placement: PlacementSpec;
  /** Limit historical bars processed when this indicator is activated or recomputed. */
  maxReplayBars?: number;
  crossAttachments?: readonly CrossAttachmentSpec[];
  timeframeGate?: (intervalMs: number) => boolean;
  bandHistoryWanted?: (state: S) => readonly BandHistoryWant[];
  /**
   * Set when the indicator reads `ctx.ticks`. The runtime replays only the
   * indicators that declare it when the print store is handed over, since a
   * print store arrives once per pair and a replay is what backfills the bars
   * drawn before it did.
   */
  ticksWanted?: boolean;
}

export interface LegacyIndicatorDef extends IndicatorMeta {
  kind: "legacy";
}

export type IndicatorDef = RuntimeIndicatorDef<any, any> | LegacyIndicatorDef;
