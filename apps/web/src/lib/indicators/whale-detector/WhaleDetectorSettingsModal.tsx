import { useLayoutEffect, useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import type { WhaleClusterMode } from "./whaleMarkerClusters";
import { LOG_SLIDER_STEPS, logSliderToValue, valueToLogSlider } from "../../chart/logSlider";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import { whaleDetectorPresetSchema, type WhaleDetectorPresetParams } from "./whaleDetectorPresets";
import {
  DEFAULT_TOP_FRACTION,
  DEFAULT_WHALE_THRESHOLD_CONTRACTS,
  DEFAULT_WHALE_THRESHOLD_USD,
  MAX_TOP_FRACTION,
  MAX_WHALE_THRESHOLD_CONTRACTS,
  MAX_WHALE_THRESHOLD_USD,
  MIN_TOP_FRACTION,
  MIN_WHALE_THRESHOLD_CONTRACTS,
  MIN_WHALE_THRESHOLD_USD,
  type WhaleDetectionMode,
} from "./whaleTrades";

const DEFAULT_WHALE_CLUSTER_MODE: WhaleClusterMode = "delta";
const DEFAULT_MIN_DELTA_PERCENT = 0;

type SettingsTab = "inputs" | "visibility";

interface WhaleDetectorSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: WhaleDetectionMode;
  onModeChange: (mode: WhaleDetectionMode) => void;
  topFraction: number;
  onTopFractionChange: (fraction: number) => void;
  threshold: number;
  thresholdUnit: "USD" | "CONTRACTS";
  onThresholdChange: (threshold: number) => void;
  resolvedThreshold: number | null;
  truncated: boolean;
  clusterMode: WhaleClusterMode;
  onClusterModeChange: (mode: WhaleClusterMode) => void;
  minDeltaPercent: number;
  onMinDeltaPercentChange: (percent: number) => void;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  sizeOnlyNote?: string;
  presetScope?: string;
}

function formatMagnitude(value: number, unit: "USD" | "CONTRACTS"): string {
  if (unit === "CONTRACTS") return `${Math.round(value).toLocaleString("en-US")} ct`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function formatFraction(fraction: number): string {
  const percent = fraction * 100;
  return `${percent < 0.1 ? percent.toFixed(3) : percent.toFixed(2)}%`;
}

export function WhaleDetectorSettingsModal({
  isOpen,
  onClose,
  mode: requestedMode,
  onModeChange,
  topFraction,
  onTopFractionChange,
  threshold,
  thresholdUnit,
  onThresholdChange,
  resolvedThreshold,
  truncated,
  clusterMode,
  onClusterModeChange,
  minDeltaPercent,
  onMinDeltaPercentChange,
  visible,
  onVisibleChange,
  sizeOnlyNote,
  presetScope,
}: WhaleDetectorSettingsModalProps) {
  const sizeOnly = sizeOnlyNote !== undefined;
  const mode = sizeOnly ? "size" : requestedMode;
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const [thresholdInput, setThresholdInput] = useState(String(threshold));
  const thresholdInputRef = useRef<HTMLInputElement>(null);
  const topFractionInputRef = useRef<HTMLInputElement>(null);
  const latestThresholdRef = useRef(threshold);
  latestThresholdRef.current = threshold;

  const thresholdMin = thresholdUnit === "CONTRACTS" ? MIN_WHALE_THRESHOLD_CONTRACTS : MIN_WHALE_THRESHOLD_USD;
  const thresholdMax = thresholdUnit === "CONTRACTS" ? MAX_WHALE_THRESHOLD_CONTRACTS : MAX_WHALE_THRESHOLD_USD;
  const thresholdDefault = thresholdUnit === "CONTRACTS"
    ? DEFAULT_WHALE_THRESHOLD_CONTRACTS
    : DEFAULT_WHALE_THRESHOLD_USD;

  useLayoutEffect(() => {
    if (isOpen) setActiveTab("inputs");
  }, [isOpen]);
  useLayoutEffect(() => {
    if (isOpen) setThresholdInput(String(latestThresholdRef.current));
  }, [isOpen]);
  useLayoutEffect(() => {
    if (isOpen && activeTab === "inputs") {
      (mode === "topPercent" ? topFractionInputRef : thresholdInputRef).current?.focus();
    }
  }, [isOpen, activeTab, mode]);

  function handleReset() {
    if (!sizeOnly) onModeChange("topPercent");
    onTopFractionChange(DEFAULT_TOP_FRACTION);
    onThresholdChange(thresholdDefault);
    onClusterModeChange(DEFAULT_WHALE_CLUSTER_MODE);
    onMinDeltaPercentChange(DEFAULT_MIN_DELTA_PERCENT);
    onVisibleChange(true);
    setThresholdInput(String(thresholdDefault));
  }

  const presetDefaults: WhaleDetectorPresetParams = {
    mode: "topPercent",
    topFraction: DEFAULT_TOP_FRACTION,
    threshold: thresholdDefault,
    clusterMode: DEFAULT_WHALE_CLUSTER_MODE,
    minDeltaPercent: DEFAULT_MIN_DELTA_PERCENT,
  };

  function applyPreset(params: PresetParams) {
    const next = params as unknown as WhaleDetectorPresetParams;
    if (!sizeOnly) onModeChange(next.mode);
    onTopFractionChange(next.topFraction);
    onThresholdChange(next.threshold);
    onClusterModeChange(next.clusterMode);
    onMinDeltaPercentChange(next.minDeltaPercent);
    setThresholdInput(String(next.threshold));
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Large Trade Detector"
      ariaLabel="Large Trade Detector settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("largeTradeDetector", presetScope === undefined ? thresholdUnit : `${presetScope}:${thresholdUnit}`),
        params: { mode, topFraction, threshold, clusterMode, minDeltaPercent },
        schema: whaleDetectorPresetSchema(thresholdUnit, sizeOnly),
        defaults: { ...presetDefaults },
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
        {activeTab === "inputs" && sizeOnly && (
          <span className="indicator-settings-hint">{sizeOnlyNote}</span>
        )}
        {activeTab === "inputs" && !sizeOnly && (
          <div className="indicator-settings-field">
            <span>Detection method</span>
            <label className="indicator-settings-radio">
              <input
                type="radio"
                name="whale-detection-mode"
                checked={mode === "topPercent"}
                onChange={() => onModeChange("topPercent")}
              />
              <span>Top %</span>
            </label>
            <span className="indicator-settings-radio-hint">
              Shows the biggest share of trades on this symbol. Self-adjusting, so it works the same on /NQ and BTC.
            </span>
            <label className="indicator-settings-radio">
              <input
                type="radio"
                name="whale-detection-mode"
                checked={mode === "size"}
                onChange={() => onModeChange("size")}
              />
              <span>Size</span>
            </label>
            <span className="indicator-settings-radio-hint">
              Shows trades at or above a size you choose. A marker is then a fact about the trade, comparable across days.
            </span>
          </div>
        )}
        {activeTab === "inputs" && mode === "topPercent" && (
          <label className="indicator-settings-field">
            <span>Show top</span>
            <input
              ref={topFractionInputRef}
              type="range"
              className="indicator-settings-slider"
              aria-label="Selectivity: drag right for fewer, larger trades"
              min={0}
              max={LOG_SLIDER_STEPS}
              step={1}
              value={LOG_SLIDER_STEPS - valueToLogSlider(topFraction, MIN_TOP_FRACTION, MAX_TOP_FRACTION)}
              onChange={(event) => {
                const inverted = LOG_SLIDER_STEPS - Number(event.target.value);
                onTopFractionChange(logSliderToValue(inverted, MIN_TOP_FRACTION, MAX_TOP_FRACTION));
              }}
            />
            <span className="indicator-settings-hint">
              Drag right for fewer, bigger trades. Currently the top {formatFraction(topFraction)} of trades
              {resolvedThreshold === null ? "" : ` — currently ${formatMagnitude(resolvedThreshold, thresholdUnit)} and above`}
              {truncated ? ". Not enough history retained to fill this setting; showing everything available." : "."}
            </span>
          </label>
        )}
        {activeTab === "inputs" && mode === "size" && (
          <label className="indicator-settings-field">
            <span>{thresholdUnit === "CONTRACTS" ? "Minimum size (contracts)" : "Minimum size ($)"}</span>
            <input
              ref={thresholdInputRef}
              type="number"
              min={thresholdMin}
              max={thresholdMax}
              step={thresholdUnit === "CONTRACTS" ? 1 : 1000}
              value={thresholdInput}
              onChange={(event) => {
                const raw = event.target.value;
                setThresholdInput(raw);
                const value = Number(raw);
                const isValid =
                  raw.trim() !== "" &&
                  Number.isFinite(value) &&
                  value >= thresholdMin &&
                  value <= thresholdMax &&
                  (thresholdUnit !== "CONTRACTS" || Number.isInteger(value));
                if (isValid) onThresholdChange(value);
              }}
            />
            <input
              type="range"
              className="indicator-settings-slider"
              aria-label={thresholdUnit === "CONTRACTS" ? "Minimum size (contracts), quick adjust" : "Minimum size ($), quick adjust"}
              min={0}
              max={LOG_SLIDER_STEPS}
              step={1}
              value={valueToLogSlider(Number(thresholdInput) || thresholdMin, thresholdMin, thresholdMax)}
              onChange={(event) => {
                const raw = logSliderToValue(Number(event.target.value), thresholdMin, thresholdMax);
                const value = thresholdUnit === "CONTRACTS" ? Math.max(1, Math.round(raw)) : Math.round(raw / 1000) * 1000;
                setThresholdInput(String(value));
                onThresholdChange(value);
              }}
            />
            <span className="indicator-settings-hint">
              The slider is logarithmic, so the default {formatMagnitude(thresholdDefault, thresholdUnit)} sits at its midpoint.
            </span>
          </label>
        )}
        {activeTab === "inputs" && (
          <div className="indicator-settings-field">
            <span>Bubble mode</span>
            <label className="indicator-settings-radio">
              <input
                type="radio"
                name="whale-cluster-mode"
                checked={clusterMode === "delta"}
                onChange={() => onClusterModeChange("delta")}
              />
              <span>Delta</span>
            </label>
            <span className="indicator-settings-radio-hint">One bubble per candle, sized by buying minus selling.</span>
            <label className="indicator-settings-radio">
              <input
                type="radio"
                name="whale-cluster-mode"
                checked={clusterMode === "buySell"}
                onChange={() => onClusterModeChange("buySell")}
              />
              <span>Buy / Sell</span>
            </label>
            <span className="indicator-settings-radio-hint">Separate buy and sell bubbles, with no netting.</span>
          </div>
        )}
        {activeTab === "inputs" && clusterMode === "delta" && (
          <label className="indicator-settings-field">
            <span>Min delta (%)</span>
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              value={String(minDeltaPercent)}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (event.target.value.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= 100) {
                  onMinDeltaPercentChange(value);
                }
              }}
            />
            <span className="indicator-settings-hint">
              Hides candles where buying and selling nearly cancel out. 0 shows every bubble.
            </span>
          </label>
        )}
        {activeTab === "visibility" && (
          <label className="indicator-settings-checkbox">
            <input
              type="checkbox"
              checked={visible}
              onChange={(event) => onVisibleChange(event.target.checked)}
            />
            <span>Show on chart</span>
          </label>
        )}
      </div>
    </IndicatorSettingsModal>
  );
}
