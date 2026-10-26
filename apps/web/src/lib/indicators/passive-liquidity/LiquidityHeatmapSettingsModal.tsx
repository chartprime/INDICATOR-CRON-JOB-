import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import {
  DEFAULT_LIQUIDITY_SETTINGS,
  LIQUIDITY_HISTORY_OPTIONS,
  MAX_LADDER_REACH,
  MAX_LEVEL_WIDTH,
  MAX_WIDENING_STEP,
  MIN_LADDER_REACH,
  MIN_WIDENING_STEP,
  bandFactorFor,
  clusterRowsFor,
  historyDaysOf,
  liquiditySettingsSchemaFor,
  nearestStop,
  quietZoneMaxFor,
  sensitivitySizes,
  sensitivityStops,
  sliderAnchorFor,
  sliderSizes,
  timeframeWideningOf,
  widenedBandFactorFor,
  wideningOfStep,
  wideningStepOf,
  type LiquiditySettings,
} from "./liquiditySettings";
import { LIQUIDITY_LANE_PRESET_FIELD, isLaneChoice, type LiquidityLaneChoice } from "./liquidityLanes";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import type { LiquidityMarket } from "./liquidityStyle";

type SettingsTab = "inputs" | "visibility";

/** The charts that widen their levels, with their names. */
const HIGHER_TIMEFRAMES: readonly (readonly [number, string])[] = [[900_000, "15m"], [3_600_000, "1h"], [14_400_000, "4h"], [86_400_000, "1D"]];

function timeframeName(intervalMs: number): string {
  if (intervalMs >= 86_400_000) return `${Math.round(intervalMs / 86_400_000)}D`;
  if (intervalMs >= 3_600_000) return `${Math.round(intervalMs / 3_600_000)}h`;
  return `${Math.round(intervalMs / 60_000)}m`;
}

function factorWords(factor: number): string {
  return `x${Number(factor.toFixed(2))}`;
}

/** How long a dragged slider must rest before its setting is handed over: every setting change scans the heatmap's columns again. */
export const SLIDER_COMMIT_MS = 150;

/** A titled row of radio choices: the title on its own line, the options side by side. */
function Choices<T extends string>({
  title,
  name,
  value,
  options,
  onChange,
}: {
  title: string;
  name: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="indicator-settings-field" style={{ marginTop: 10 }}>
      <span>{title}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
        {options.map(([key, label]) => (
          <label key={key} className="indicator-settings-radio">
            <input type="radio" name={name} checked={value === key} onChange={() => onChange(key)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * A slider over whole positions that follows the thumb at once and hands the
 * position over once the thumb has rested for SLIDER_COMMIT_MS, or is let
 * go, so a drag does not rescan the heatmap at every notch. `describe` words
 * the dragged position, or the saved setting while nothing is dragged.
 */
function Slider({
  name,
  min,
  max,
  position,
  describe,
  onCommit,
  hint,
}: {
  name: string;
  min: number;
  max: number;
  position: number;
  describe: (dragged: number | null) => string;
  onCommit: (position: number) => void;
  hint?: string | ((dragged: number | null) => string);
}) {
  const [dragged, setDragged] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  const flush = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const value = pending.current;
    pending.current = null;
    setDragged(null);
    if (value !== null) commit.current(value);
  };

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <label className="indicator-settings-field">
      <span>{describe(dragged)}</span>
      <input
        type="range"
        aria-label={name}
        min={min}
        max={max}
        step={1}
        value={dragged ?? Math.min(max, Math.max(min, position))}
        onChange={(event) => {
          pending.current = Number(event.target.value);
          setDragged(pending.current);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(flush, SLIDER_COMMIT_MS);
        }}
        onPointerUp={flush}
        onKeyUp={flush}
        onBlur={flush}
      />
      {hint === undefined ? null : <small className="indicator-settings-hint">{typeof hint === "string" ? hint : hint(dragged)}</small>}
    </label>
  );
}

interface LiquidityHeatmapSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The market on screen: the wording of the level width, and whole sizes only on an index. */
  market?: LiquidityMarket;
  /** What a size counts on this market ("contracts", "BTC"), for the sliders' wording. */
  unit?: string;
  /** The book's typical row size: what a market without a minimum level of its own builds its size sliders around, read when the dialog opens. */
  typicalSize?: number;
  /** The candle of the chart on screen: the higher-timeframe slider says what it gives there. */
  intervalMs?: number;
  settings: LiquiditySettings;
  /** What "Reset to default" returns to: this market's own defaults. */
  defaults?: LiquiditySettings;
  onSettingsChange: (settings: LiquiditySettings) => void;
  lane?: LiquidityLaneChoice;
  onLaneChange?: (lane: LiquidityLaneChoice) => void;
  historical?: boolean;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  presetScope?: string;
}

export function LiquidityHeatmapSettingsModal({
  isOpen,
  onClose,
  market = "crypto",
  unit = "",
  typicalSize = 0,
  intervalMs = 60_000,
  settings,
  defaults = DEFAULT_LIQUIDITY_SETTINGS,
  onSettingsChange,
  lane = "0",
  onLaneChange,
  historical = false,
  visible,
  onVisibleChange,
  presetScope,
}: LiquidityHeatmapSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  const latestTypicalRef = useRef(typicalSize);
  latestTypicalRef.current = typicalSize;
  const [typicalAtOpen, setTypicalAtOpen] = useState(typicalSize);

  useLayoutEffect(() => {
    if (!isOpen) return;
    setActiveTab("inputs");
    setTypicalAtOpen(latestTypicalRef.current);
  }, [isOpen]);

  function update(patch: Partial<LiquiditySettings>) {
    onSettingsChange({ ...latestSettingsRef.current, ...patch });
  }

  const latestDefaultsRef = useRef(defaults);
  latestDefaultsRef.current = defaults;

  function handleReset() {
    const base = latestDefaultsRef.current;
    onSettingsChange({ ...base });
    onLaneChange?.("0");
    onVisibleChange(true);
  }

  function applyPreset(params: PresetParams) {
    const { lane: nextLane, ...rest } = params;
    const next = rest as unknown as LiquiditySettings;
    onSettingsChange({ ...next, historyDays: historyDaysOf(next) });
    if (onLaneChange !== undefined && isLaneChoice(nextLane)) onLaneChange(nextLane);
  }

  const presetSchema: readonly SettingsFieldSchema<any>[] = [...liquiditySettingsSchemaFor(defaults), LIQUIDITY_LANE_PRESET_FIELD];

  const anchor = sliderAnchorFor(defaults, typicalAtOpen, unit);
  const sensitivity = sensitivityStops(sensitivitySizes(anchor, market));
  const saturation = sliderSizes(anchor, market, [defaults.scaleSize]);
  const quietMax = quietZoneMaxFor(defaults);
  const sized = (size: number) => `${size.toLocaleString("en-US")}${unit === "" ? "" : ` ${unit}`}`;
  const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const minimum = (size: number) => (size > 0 ? `hides levels under ${sized(size)}` : "no minimum");
  const widthWord = (rows: number) => (market === "index" ? counted(rows, "tick", "ticks") : counted(rows, "row", "rows"));
  const wideningAt = (at: number | null) => (at === null ? timeframeWideningOf(settings) : wideningOfStep(at));
  const describeWidening = (at: number | null) => {
    const widening = wideningAt(at);
    const step = wideningStepOf(widening);
    const name = step === 0 ? "auto" : step > 0 ? `+${step}` : String(step);
    if (!(bandFactorFor(intervalMs) > 1)) return `Higher timeframes ${name}`;
    const rows = clusterRowsFor({ clusterRows: settings.clusterRows, timeframeWidening: widening }, intervalMs);
    return `Higher timeframes ${name} · ${factorWords(widenedBandFactorFor({ timeframeWidening: widening }, intervalMs))} on this ${timeframeName(intervalMs)} chart: ${widthWord(rows)}`;
  };
  const wideningHint = (at: number | null) => {
    const widening = wideningAt(at);
    const factors = HIGHER_TIMEFRAMES.map(([ms, name]) => `${factorWords(widenedBandFactorFor({ timeframeWidening: widening }, ms))} on ${name}`).join(", ");
    return `${factors}. Left makes the levels finer, right thicker; never finer than on the 1m chart.`;
  };
  const sensitivityHint = `Further right hides less.${market === "crypto" ? " On the 1m chart; it grows with the bands on higher timeframes." : ""} The heatmap's own floor and the quiet zone still apply, and the ladder beside the axis always shows the whole book.`;

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Passive Liquidity Heatmap"
      ariaLabel="Passive Liquidity Heatmap settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("passiveLiquidity", presetScope),
        params: onLaneChange === undefined ? { ...settings } : { ...settings, lane },
        schema: presetSchema,
        defaults: { ...defaults, lane: "0" },
        onApply: applyPreset,
        onReset: handleReset,
      }}
    >
      <div className="indicator-settings-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "inputs"}
          className="indicator-settings-tab"
          onClick={() => setActiveTab("inputs")}
        >
          Inputs
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "visibility"}
          className="indicator-settings-tab"
          onClick={() => setActiveTab("visibility")}
        >
          Visibility
        </button>
      </div>
      <div className="indicator-settings-body">
        {activeTab === "inputs" && (
          <>
            <Slider
              name="Level width"
              min={1}
              max={MAX_LEVEL_WIDTH}
              position={settings.clusterRows}
              describe={(at) => `Level width ${widthWord(at ?? settings.clusterRows)}`}
              onCommit={(at) => update({ clusterRows: at })}
              hint="On the 1m chart; higher timeframes widen it as set below."
            />
            <Slider
              name="Higher timeframes"
              min={MIN_WIDENING_STEP}
              max={MAX_WIDENING_STEP}
              position={wideningStepOf(timeframeWideningOf(settings))}
              describe={describeWidening}
              onCommit={(at) => update({ timeframeWidening: wideningOfStep(at) })}
              hint={wideningHint}
            />
            <Slider
              name="Quiet zone around price"
              min={0}
              max={quietMax}
              position={settings.quietBands}
              describe={(at) => {
                const bands = at ?? settings.quietBands;
                return `Quiet zone around price ${bands === 0 ? "off" : counted(bands, "band", "bands")}`;
              }}
              onCommit={(at) => update({ quietBands: at })}
            />
            <Slider
              name="Sensitivity"
              min={0}
              max={sensitivity.length - 1}
              position={nearestStop(sensitivity, settings.minBandSize)}
              describe={(at) => `Sensitivity · ${minimum(at === null ? settings.minBandSize : sensitivity[at])}`}
              onCommit={(at) => update({ minBandSize: sensitivity[at] })}
              hint={sensitivityHint}
            />
            {historical ? <p>Top 10 levels only. History is limited to the loaded chart window; gaps are omitted.</p> : <Choices
              title="History"
              name="liquidity-history-days"
              value={String(historyDaysOf(settings))}
              options={LIQUIDITY_HISTORY_OPTIONS.map(([days, label]) => [String(days), label] as const)}
              onChange={(value) => update({ historyDays: Number(value) })}
            />}
            <Choices
              title="Show"
              name="liquidity-level-filter"
              value={settings.levelFilter}
              options={[["all", "All levels"], ["resting", "Resting only"], ["consumed", "Consumed only"]]}
              onChange={(value) => update({ levelFilter: value })}
            />
            <Choices
              title="Display pulled"
              name="liquidity-display-pulled"
              value={settings.showPulled ? "yes" : "no"}
              options={[["yes", "Yes"], ["no", "No"]]}
              onChange={(value) => update({ showPulled: value === "yes" })}
            />
            {onLaneChange !== undefined && (
              <Choices
                title="Price zoom"
                name="liquidity-lane"
                value={lane === "auto" || lane === "0" || lane === "1" || lane === "2" ? lane : "auto"}
                options={[["auto", "Auto"], ["0", "Finest rows"], ["1", "Rows x2"], ["2", "Rows x4"]]}
                onChange={(value) => onLaneChange(value)}
              />
            )}
            <Choices
              title="Colour scale"
              name="liquidity-scale-mode"
              value={settings.scaleMode}
              options={[["auto", "Auto"], ["fixed", "Fixed size"]]}
              onChange={(value) => update({ scaleMode: value })}
            />
            {settings.scaleMode === "fixed" && (
              <Slider
                name="Size that saturates"
                min={0}
                max={saturation.length - 1}
                position={nearestStop(saturation, settings.scaleSize)}
                describe={(at) => `Size that saturates ${sized(at === null ? settings.scaleSize : saturation[at])}${market === "crypto" ? " per row" : ""}`}
                onCommit={(at) => update({ scaleSize: saturation[at] })}
              />
            )}
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-field">
              <span>Resting bids color</span>
              <input type="color" value={settings.bidColor} onChange={(event) => update({ bidColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Resting asks color</span>
              <input type="color" value={settings.askColor} onChange={(event) => update({ askColor: event.target.value })} />
            </label>
            <label className="indicator-settings-checkbox">
              <input
                type="checkbox"
                checked={settings.showLadder}
                onChange={(event) => update({ showLadder: event.target.checked })}
              />
              <span>Show the size ladder beside the price axis</span>
            </label>
            <label className="indicator-settings-field">
              <span>Largest ladder bar reaches {Math.round(settings.ladderReach * 100)}% of the chart</span>
              <input
                type="range"
                min={MIN_LADDER_REACH}
                max={MAX_LADDER_REACH}
                step={0.05}
                value={settings.ladderReach}
                onChange={(event) => update({ ladderReach: Number(event.target.value) })}
              />
            </label>
            <label className="indicator-settings-checkbox">
              <input
                type="checkbox"
                checked={visible}
                onChange={(event) => onVisibleChange(event.target.checked)}
              />
              <span>Show on chart</span>
            </label>
          </>
        )}
      </div>
    </IndicatorSettingsModal>
  );
}
