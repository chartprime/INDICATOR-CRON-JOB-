import { useLayoutEffect, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import type { PresetParams } from "../../chart/indicatorPresets";
import type { PivotSupportResistanceSettings } from "./pivotSupportResistance";
import { PIVOT_SUPPORT_RESISTANCE_PRESET_SCHEMA } from "./pivotSupportResistancePresets";


interface PivotSupportResistanceSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: PivotSupportResistanceSettings;
  defaultSettings: PivotSupportResistanceSettings;
  onSettingsChange: (settings: PivotSupportResistanceSettings) => void;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
}

type SettingsTab = "inputs" | "visibility";

export function PivotSupportResistanceSettingsModal({
  isOpen,
  onClose,
  settings,
  defaultSettings,
  onSettingsChange,
  visible,
  onVisibleChange,
}: PivotSupportResistanceSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");

  useLayoutEffect(() => {
    if (isOpen) setActiveTab("inputs");
  }, [isOpen]);

  function update(patch: Partial<PivotSupportResistanceSettings>) {
    onSettingsChange({ ...settings, ...patch });
  }

  function handleReset() {
    onSettingsChange(defaultSettings);
    onVisibleChange(true);
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Pivot Support / Resistance"
      ariaLabel="Pivot Support / Resistance settings"
      footerStart={
        <button
          type="button"
          className="indicator-settings-reset"
          onClick={handleReset}
        >
          Reset to default
        </button>
      }
      presets={{
        presetKey: "pivotSupportResistance",
        params: { ...settings },
        schema: PIVOT_SUPPORT_RESISTANCE_PRESET_SCHEMA,
        defaults: { ...defaultSettings },
        onApply: (params: PresetParams) => onSettingsChange(params as unknown as PivotSupportResistanceSettings),
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
            <label className="indicator-settings-field">
              <span>Left bars</span>
              <input
                type="number"
                min={1}
                max={20}
                step={1}
                value={settings.leftBars}
                onChange={(event) =>
                  update({ leftBars: Number(event.target.value) })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>Right bars</span>
              <input
                type="number"
                min={1}
                max={20}
                step={1}
                value={settings.rightBars}
                onChange={(event) =>
                  update({ rightBars: Number(event.target.value) })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>Max levels displayed</span>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={settings.maxLevels}
                onChange={(event) =>
                  update({ maxLevels: Number(event.target.value) })
                }
              />
            </label>
          </>
        )}
        {activeTab === "visibility" && (
          <>
            {" "}
            <label className="indicator-settings-field">
              <span>Line style</span>
              <select
                value={settings.lineStyle}
                onChange={(event) =>
                  update({
                    lineStyle: event.target
                      .value as PivotSupportResistanceSettings["lineStyle"],
                  })
                }
              >
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
                <option value="dotted">Dotted</option>
              </select>
            </label>
            <label className="indicator-settings-field">
              <span>Support color</span>
              <input
                type="color"
                value={settings.supportColor}
                onChange={(event) =>
                  update({ supportColor: event.target.value })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>Resistance color</span>
              <input
                type="color"
                value={settings.resistanceColor}
                onChange={(event) =>
                  update({ resistanceColor: event.target.value })
                }
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
