import { useLayoutEffect, useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import {
  DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS,
  L2_SUPPORT_RESISTANCE_SETTINGS_SCHEMA,
  normalizeL2SupportResistanceSettings,
  type L2SupportResistanceSettings,
} from "./l2SupportResistancePrimitive";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  settings: L2SupportResistanceSettings;
  onSettingsChange: (settings: L2SupportResistanceSettings) => void;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  unit?: string;
  presetScope?: string;
}

export function L2SupportResistanceSettingsModal({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  visible,
  onVisibleChange,
  unit = "",
  presetScope,
}: Props) {
  const unitSuffix = unit ? ` (${unit})` : "";
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  const [maxLevelsInput, setMaxLevelsInput] = useState(String(settings.maxLevels));
  const [minimumDistanceRowsInput, setMinimumDistanceRowsInput] = useState(
    String(settings.minimumDistanceRows),
  );
  const [lookbackMinutesInput, setLookbackMinutesInput] = useState(
    String(settings.lookbackMinutes),
  );
  const [minimumLiquiditySizeInput, setMinimumLiquiditySizeInput] = useState(
    String(settings.minimumLiquiditySize),
  );

  useLayoutEffect(() => {
    if (!isOpen) return;
    setMaxLevelsInput(String(latestSettingsRef.current.maxLevels));
    setMinimumDistanceRowsInput(
      String(latestSettingsRef.current.minimumDistanceRows),
    );
    setLookbackMinutesInput(String(latestSettingsRef.current.lookbackMinutes));
    setMinimumLiquiditySizeInput(
      String(latestSettingsRef.current.minimumLiquiditySize),
    );
  }, [isOpen]);

  function update(patch: Partial<L2SupportResistanceSettings>) {
    onSettingsChange(
      normalizeL2SupportResistanceSettings({
        ...latestSettingsRef.current,
        ...patch,
      }),
    );
  }

  function applySettings(next: L2SupportResistanceSettings) {
    onSettingsChange(next);
    setMaxLevelsInput(String(next.maxLevels));
    setMinimumDistanceRowsInput(String(next.minimumDistanceRows));
    setLookbackMinutesInput(String(next.lookbackMinutes));
    setMinimumLiquiditySizeInput(String(next.minimumLiquiditySize));
  }

  function handleReset() {
    applySettings({ ...DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS });
  }

  function applyPreset(params: PresetParams) {
    applySettings(normalizeL2SupportResistanceSettings(params as unknown as L2SupportResistanceSettings));
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="L2 Support & Resistance"
      ariaLabel="L2 support and resistance settings"
      presets={{
        presetKey: presetKeyFor("l2SupportResistance", presetScope),
        params: { ...settings },
        schema: L2_SUPPORT_RESISTANCE_SETTINGS_SCHEMA,
        defaults: { ...DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS },
        onApply: applyPreset,
        onReset: handleReset,
      }}
    >
      <div className="indicator-settings-body">
        <label className="indicator-settings-checkbox">
          <input
            type="checkbox"
            checked={visible}
            onChange={(event) => onVisibleChange(event.target.checked)}
          />
          <span>Show on chart</span>
        </label>
        <label className="indicator-settings-field">
          <span>Max Levels</span>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={maxLevelsInput}
            onChange={(event) => {
              const raw = event.target.value;
              setMaxLevelsInput(raw);
              const value = Number(raw);
              if (raw.trim() !== "" && Number.isInteger(value) && value >= 1 && value <= 20)
                update({ maxLevels: value });
            }}
          />
        </label>
        <label className="indicator-settings-field">
          <span>Minimum Distance (Rows)</span>
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={minimumDistanceRowsInput}
            onChange={(event) => {
              const raw = event.target.value;
              setMinimumDistanceRowsInput(raw);
              const value = Number(raw);
              if (raw.trim() !== "" && Number.isInteger(value) && value >= 1 && value <= 100)
                update({ minimumDistanceRows: value });
            }}
          />
        </label>
        <label className="indicator-settings-field">
          <span>Lookback Minutes (since the level formed)</span>
          <input
            type="number"
            min={1}
            max={120}
            step={1}
            value={lookbackMinutesInput}
            onChange={(event) => {
              const raw = event.target.value;
              setLookbackMinutesInput(raw);
              const value = Number(raw);
              if (raw.trim() !== "" && Number.isInteger(value) && value >= 1 && value <= 120)
                update({ lookbackMinutes: value });
            }}
          />
        </label>
        <label className="indicator-settings-field">
          <span>Minimum Liquidity Size{unitSuffix}</span>
          <input
            type="number"
            min={0}
            step="any"
            value={minimumLiquiditySizeInput}
            onChange={(event) => {
              const raw = event.target.value;
              setMinimumLiquiditySizeInput(raw);
              const value = Number(raw);
              if (raw.trim() !== "" && Number.isFinite(value) && value >= 0)
                update({ minimumLiquiditySize: value });
            }}
          />
        </label>
        <label className="indicator-settings-field">
          <span>Bid Support Color</span>
          <input
            type="color"
            value={settings.bidColor}
            onChange={(event) => update({ bidColor: event.target.value })}
          />
        </label>
        <label className="indicator-settings-field">
          <span>Ask Resistance Color</span>
          <input
            type="color"
            value={settings.askColor}
            onChange={(event) => update({ askColor: event.target.value })}
          />
        </label>
        <button
          type="button"
          className="indicator-settings-reset"
          onClick={handleReset}
        >
          Reset
        </button>
      </div>
    </IndicatorSettingsModal>
  );
}
