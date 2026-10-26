import { useLayoutEffect, useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import type { FrameIdentity } from "../../../types/frames";
import { AGGRESSIVE_PROFILE_SETTINGS_SCHEMA, DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, MAX_OUTLIER_FROM, OUTLIER_STEP, PROFILE_VIEWS, floorAt, floorNumberText, floorPosition, floorScaleFor, floorStops, outlierText, type AggressiveProfileSettings, type ProfileView } from "./aggressiveProfileSettings";

type SettingsTab = "inputs" | "visibility";

interface AggressiveProfileSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AggressiveProfileSettings;
  onSettingsChange: (settings: AggressiveProfileSettings) => void;
  defaults?: AggressiveProfileSettings;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  typicalFloor?: number;
  instrument?: { symbol: string } & FrameIdentity;
  sizeUnit?: string;
  presetScope?: string;
}

export function AggressiveProfileSettingsModal({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  defaults = DEFAULT_AGGRESSIVE_PROFILE_SETTINGS,
  visible,
  onVisibleChange,
  typicalFloor = 0,
  instrument,
  sizeUnit = "",
  presetScope,
}: AggressiveProfileSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;

  useLayoutEffect(() => {
    if (isOpen) setActiveTab("inputs");
  }, [isOpen]);

  function update(patch: Partial<AggressiveProfileSettings>) {
    onSettingsChange({ ...latestSettingsRef.current, ...patch });
  }

  function handleReset() {
    onSettingsChange({ ...defaults });
    onVisibleChange(true);
  }

  function applyPreset(params: PresetParams) {
    onSettingsChange(params as unknown as AggressiveProfileSettings);
  }

  const stops = floorStops(floorScaleFor(instrument ?? null, typicalFloor), typicalFloor);
  const handFloor = settings.floor > typicalFloor ? settings.floor : 0;
  const unit = sizeUnit === "" ? "" : ` ${sizeUnit}`;

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Aggressive Orders Profile"
      ariaLabel="Aggressive Orders Profile settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("aggressiveOrdersProfile", presetScope),
        params: { ...settings },
        schema: AGGRESSIVE_PROFILE_SETTINGS_SCHEMA,
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
            <label className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>{handFloor > 0 ? `Big print floor ${floorNumberText(handFloor)}${unit}` : `Big print floor auto (the heatmap's, ${floorNumberText(typicalFloor)}${unit} now)`}</span>
              <input
                type="range"
                aria-label="Big print floor"
                data-free-range="true"
                min={0}
                max={stops.length}
                step={1}
                value={floorPosition(stops, handFloor)}
                onChange={(event) => update({ floor: floorAt(stops, Number(event.target.value)) })}
              />
              <small className="indicator-settings-hint">{typicalFloor > 0 ? `Starts at the heatmap's floor, ${floorNumberText(typicalFloor)}${unit}.` : "Starts at the heatmap's floor."}</small>
              <small className="indicator-settings-hint">Aggressive Orders draws its bubbles from another threshold; set the same floor to make each bar the sum of its candle's bubbles over the last 4 hours (older minutes keep only its 4 biggest prints a side).</small>
            </label>
            <label className="indicator-settings-field">
              <span>Show as</span>
              <select aria-label="Show as" value={settings.profileView} onChange={(event) => update({ profileView: event.target.value as ProfileView })}>
                {PROFILE_VIEWS.map((view) => (
                  <option key={view.value} value={view.value}>
                    {view.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="indicator-settings-field">
              <span>{outlierText(settings.outlierFrom)}</span>
              <input
                type="range"
                aria-label="Highlight bars"
                min={0}
                max={MAX_OUTLIER_FROM}
                step={OUTLIER_STEP}
                value={settings.outlierFrom}
                onChange={(event) => update({ outlierFrom: Number(event.target.value) })}
              />
            </label>
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-field">
              <span>Buys color</span>
              <input type="color" aria-label="Buys color" value={settings.buyColor} onChange={(event) => update({ buyColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Sells color</span>
              <input type="color" aria-label="Sells color" value={settings.sellColor} onChange={(event) => update({ sellColor: event.target.value })} />
            </label>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" aria-label="Show on chart" checked={visible} onChange={(event) => onVisibleChange(event.target.checked)} />
              <span>Show on chart</span>
            </label>
          </>
        )}
      </div>
    </IndicatorSettingsModal>
  );
}
