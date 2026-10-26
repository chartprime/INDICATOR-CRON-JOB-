import { useLayoutEffect, useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import { VPIN_CLOUD_PRESET_SCHEMA } from "./vpinCloudPresets";
import { MAX_VPIN_SENSITIVITY, MIN_VPIN_SENSITIVITY } from "./vpinSensitivity";

type SettingsTab = "inputs" | "visibility";


interface VpinCloudSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  sensitivity: number;
  defaultSensitivity: number;
  onSensitivityChange: (sensitivity: number) => void;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  presetScope?: string;
}

export function VpinCloudSettingsModal({
  isOpen,
  onClose,
  sensitivity,
  defaultSensitivity,
  onSensitivityChange,
  visible,
  onVisibleChange,
  presetScope,
}: VpinCloudSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const [sensitivityInput, setSensitivityInput] = useState(String(sensitivity));
  const sensitivityInputRef = useRef<HTMLInputElement>(null);
  const latestSensitivityRef = useRef(sensitivity);
  latestSensitivityRef.current = sensitivity;

  useLayoutEffect(() => {
    if (isOpen) setActiveTab("inputs");
  }, [isOpen]);
  useLayoutEffect(() => {
    if (isOpen) setSensitivityInput(String(latestSensitivityRef.current));
  }, [isOpen]);
  useLayoutEffect(() => {
    if (isOpen && activeTab === "inputs") sensitivityInputRef.current?.focus();
  }, [isOpen, activeTab]);

  function handleReset() {
    onSensitivityChange(defaultSensitivity);
    onVisibleChange(true);
    setSensitivityInput(String(defaultSensitivity));
  }

  function applyPreset(params: PresetParams) {
    const next = params.sensitivity as number;
    onSensitivityChange(next);
    setSensitivityInput(String(next));
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="VPIN Cloud"
      ariaLabel="VPIN Cloud settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("vpinCloud", presetScope),
        params: { sensitivity },
        schema: VPIN_CLOUD_PRESET_SCHEMA,
        defaults: { sensitivity: defaultSensitivity },
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
          <label className="indicator-settings-field">
            <span>Sensitivity</span>
            <input
              ref={sensitivityInputRef}
              type="number"
              min={MIN_VPIN_SENSITIVITY}
              max={MAX_VPIN_SENSITIVITY}
              step={0.1}
              value={sensitivityInput}
              onChange={(event) => {
                const raw = event.target.value;
                setSensitivityInput(raw);
                const value = Number(raw);
                const isValid =
                  raw.trim() !== "" &&
                  Number.isFinite(value) &&
                  value >= MIN_VPIN_SENSITIVITY &&
                  value <= MAX_VPIN_SENSITIVITY;
                if (isValid) onSensitivityChange(value);
              }}
            />
            <span className="indicator-settings-hint">
              How unusual order-flow imbalance must be before the cloud activates. Lower activates more
              readily; higher holds out for only the most extreme imbalance. Defaults to {defaultSensitivity.toFixed(2)},
              derived from this instrument's own recent history.
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
