import { useLayoutEffect, useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import type { FrameIdentity } from "../../../types/frames";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import {
  AGGRESSIVE_ORDERS_SETTINGS_SCHEMA,
  BASE_INTERVAL_MS,
  GROUPINGS,
  describeGrouping,
  groupingOf,
  groupingStepFor,
  groupingWidthsFor,
  scaledClusterRules,
  type AggressiveOrdersSettings,
  type Grouping,
} from "./aggressiveOrdersSettings";

type SettingsTab = "inputs" | "visibility";

const GROUPING_LABELS: Record<Grouping, string> = { off: "Off", tight: "Tight", normal: "Normal", wide: "Wide" };

interface AggressiveOrdersSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AggressiveOrdersSettings;
  onSettingsChange: (settings: AggressiveOrdersSettings) => void;
  defaults: AggressiveOrdersSettings;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  identity: { symbol: string } & FrameIdentity;
  intervalMs?: number;
  unit?: string;
  suggestion?: number;
  presetScope?: string;
}

export function AggressiveOrdersSettingsModal({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  defaults,
  visible,
  onVisibleChange,
  identity,
  intervalMs = BASE_INTERVAL_MS,
  unit = "",
  suggestion = 0,
  presetScope,
}: AggressiveOrdersSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const [minVolumeInput, setMinVolumeInput] = useState(String(settings.minVolume));
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;

  useLayoutEffect(() => {
    if (isOpen) {
      setActiveTab("inputs");
      setMinVolumeInput(String(latestSettingsRef.current.minVolume));
    }
  }, [isOpen]);

  function update(patch: Partial<AggressiveOrdersSettings>) {
    onSettingsChange({ ...latestSettingsRef.current, ...patch });
  }

  function handleReset() {
    onSettingsChange({ ...defaults });
    onVisibleChange(true);
    setMinVolumeInput(String(defaults.minVolume));
  }

  function applyPreset(params: PresetParams) {
    const next = params as unknown as AggressiveOrdersSettings;
    onSettingsChange(next);
    setMinVolumeInput(String(next.minVolume));
  }

  const widths = groupingWidthsFor(identity);
  const grouping = groupingOf(settings.clusterWidth, identity);
  const groupingAvailable = widths.normal > 0;
  const effective = scaledClusterRules(settings, { intervalMs, step: groupingStepFor(identity)?.size ?? 0 });
  const scaled = intervalMs > BASE_INTERVAL_MS && settings.clusterWidth > 0;
  const unitSuffix = unit ? ` (${unit})` : "";

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Aggressive Orders"
      ariaLabel="Aggressive Orders settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("aggressiveOrders", presetScope),
        params: { ...settings },
        schema: AGGRESSIVE_ORDERS_SETTINGS_SCHEMA,
        defaults: { ...defaults },
        onApply: applyPreset,
        onReset: handleReset,
      }}
    >
      <div className="indicator-settings-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === "inputs"} className="indicator-settings-tab" onClick={() => setActiveTab("inputs")}>
          Inputs
        </button>
        <button type="button" role="tab" aria-selected={activeTab === "visibility"} className="indicator-settings-tab" onClick={() => setActiveTab("visibility")}>
          Visibility
        </button>
      </div>
      <div className="indicator-settings-body">
        {activeTab === "inputs" && (
          <>
            <label className="indicator-settings-field">
              <span>Show orders larger than{unitSuffix}</span>
              <input
                type="number"
                min={0}
                step="any"
                value={minVolumeInput}
                onChange={(event) => {
                  const raw = event.target.value;
                  setMinVolumeInput(raw);
                  const value = Number(raw);
                  if (raw.trim() !== "" && Number.isFinite(value) && value >= 0) update({ minVolume: value });
                }}
              />
              <small className="indicator-settings-hint">
                Only market orders at least this big are drawn, the moment they print. 0 = automatic: the biggest two percent of this book's orders.
                {suggestion > 0 ? ` A big single order here is about ${suggestion}${unit ? ` ${unit}` : ""}.` : ""}
              </small>
            </label>
            <div className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>Grouping</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }} role="radiogroup" aria-label="Grouping">
                {GROUPINGS.map((option) => (
                  <label key={option} className="indicator-settings-radio">
                    <input
                      type="radio"
                      name="aggressive-orders-grouping"
                      checked={grouping === option}
                      disabled={option !== "off" && !groupingAvailable}
                      onChange={() => update({ clusterWidth: widths[option] })}
                    />
                    <span>{GROUPING_LABELS[option]}</span>
                  </label>
                ))}
              </div>
              <small className="indicator-settings-hint">
                {describeGrouping(grouping, effective.width, identity, { clusterGapMs: effective.gapMs, clusterMaxMs: effective.maxMs }, effective.bucketMs)}
                {scaled && effective.bucketMs <= 0 ? " Widened for this timeframe, so a bubble covers the same slice of a candle as on the 1m chart." : ""}
                {grouping === "custom" ? " (a width set by hand; pick a choice above to return to a preset)" : ""}
              </small>
            </div>
            <label className="indicator-settings-field">
              <span>Bubble size ×{settings.bubbleScale.toFixed(1)}</span>
              <input
                type="range"
                min={0.5}
                max={2.5}
                step={0.1}
                value={settings.bubbleScale}
                onChange={(event) => update({ bubbleScale: Number(event.target.value) })}
              />
            </label>
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" checked={settings.showBuyers} onChange={(event) => update({ showBuyers: event.target.checked })} />
              <span>Aggressive buyers (bullish candle colour)</span>
            </label>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" checked={settings.showSellers} onChange={(event) => update({ showSellers: event.target.checked })} />
              <span>Aggressive sellers (bearish candle colour)</span>
            </label>
            <label className="indicator-settings-field">
              <span>Opacity {Math.round(settings.opacity * 100)}%</span>
              <input
                type="range"
                min={0.2}
                max={1}
                step={0.05}
                value={settings.opacity}
                onChange={(event) => update({ opacity: Number(event.target.value) })}
              />
            </label>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" checked={visible} onChange={(event) => onVisibleChange(event.target.checked)} />
              <span>Show on chart</span>
            </label>
          </>
        )}
      </div>
    </IndicatorSettingsModal>
  );
}
