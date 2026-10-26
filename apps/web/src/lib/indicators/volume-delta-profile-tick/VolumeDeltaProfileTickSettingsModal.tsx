import { useLayoutEffect, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import type { PresetParams } from "../../chart/indicatorPresets";
import { VOLUME_DELTA_PROFILE_TICK_PERSISTENCE_SCHEMA } from "./volumeDeltaProfileTick";
import {
  DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
  type PocLineStyle,
  type VolumeDeltaProfileTickSettings,
} from "./volumeDeltaProfileTickSettings";

type SettingsTab = "inputs" | "visibility";

interface VolumeDeltaProfileTickSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: VolumeDeltaProfileTickSettings;
  onSettingsChange: (settings: VolumeDeltaProfileTickSettings) => void;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
}

export function VolumeDeltaProfileTickSettingsModal({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  visible,
  onVisibleChange,
}: VolumeDeltaProfileTickSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");

  useLayoutEffect(() => {
    if (isOpen) setActiveTab("inputs");
  }, [isOpen]);

  function handleReset() {
    onSettingsChange(DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS);
    onVisibleChange(true);
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Volume Profile (Ticks)"
      ariaLabel="Volume Profile (Ticks) settings"
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
        presetKey: "volumeDeltaProfileTick",
        params: { ...settings },
        schema: VOLUME_DELTA_PROFILE_TICK_PERSISTENCE_SCHEMA,
        defaults: { ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS },
        onApply: (params: PresetParams) => onSettingsChange(params as unknown as VolumeDeltaProfileTickSettings),
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
              <span>Min Opacity {settings.minOpacity.toFixed(2)}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.minOpacity}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    minOpacity: Math.min(
                      Number(e.target.value),
                      settings.maxOpacity,
                    ),
                  })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>Max Opacity {settings.maxOpacity.toFixed(2)}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.maxOpacity}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    maxOpacity: Math.max(
                      Number(e.target.value),
                      settings.minOpacity,
                    ),
                  })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>Profile Width {settings.profileWidth}px</span>
              <input
                type="range"
                min={50}
                max={1000}
                step={10}
                value={settings.profileWidth}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    profileWidth: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>Rows {settings.binCount}</span>
              <input
                type="range"
                min={20}
                max={1500}
                step={10}
                value={settings.binCount}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    binCount: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="indicator-settings-checkbox">
              <input
                type="checkbox"
                checked={settings.fixedRowCount}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    fixedRowCount: e.target.checked,
                  })
                }
              />
              <span>Fixed amount of rows</span>
            </label>
            <label className="indicator-settings-field">
              <span>VAH / VAL {settings.vahValPercent}%</span>
              <input
                type="range"
                min={10}
                max={99}
                step={1}
                value={settings.vahValPercent}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    vahValPercent: Number(e.target.value),
                  })
                }
              />
            </label>
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-field">
              <span>Bin Border</span>
              <div
                style={{ display: "flex", gap: "8px", alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={settings.binBorderVisible}
                  onChange={(e) =>
                    onSettingsChange({
                      ...settings,
                      binBorderVisible: e.target.checked,
                    })
                  }
                />
                {settings.binBorderVisible && (
                  <>
                    <input
                      type="color"
                      value={settings.binBorderColor}
                      onChange={(e) =>
                        onSettingsChange({
                          ...settings,
                          binBorderColor: e.target.value,
                        })
                      }
                      style={{ width: "40px", height: "24px" }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.binBorderOpacity}
                      onChange={(e) =>
                        onSettingsChange({
                          ...settings,
                          binBorderOpacity: Number(e.target.value),
                        })
                      }
                    />
                    <span>{settings.binBorderOpacity.toFixed(2)}</span>
                  </>
                )}
              </div>
            </label>
            <label className="indicator-settings-checkbox">
              <input
                type="checkbox"
                checked={settings.binVolumeVisible}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    binVolumeVisible: e.target.checked,
                  })
                }
              />
              <span>Bin Volume Text</span>
            </label>
            <label className="indicator-settings-field">
              <span>Buy Color</span>
              <input
                type="color"
                value={settings.buyColor}
                onChange={(e) =>
                  onSettingsChange({ ...settings, buyColor: e.target.value })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>Sell Color</span>
              <input
                type="color"
                value={settings.sellColor}
                onChange={(e) =>
                  onSettingsChange({ ...settings, sellColor: e.target.value })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>POC Line</span>
              <div
                style={{ display: "flex", gap: "8px", alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={settings.pocVisible}
                  onChange={(e) =>
                    onSettingsChange({
                      ...settings,
                      pocVisible: e.target.checked,
                    })
                  }
                />
                {settings.pocVisible && (
                  <>
                    <input
                      type="color"
                      value={settings.pocColor}
                      onChange={(e) =>
                        onSettingsChange({
                          ...settings,
                          pocColor: e.target.value,
                        })
                      }
                      style={{ width: "40px", height: "24px" }}
                    />
                    <select
                      value={settings.pocLineStyle}
                      onChange={(e) =>
                        onSettingsChange({
                          ...settings,
                          pocLineStyle: e.target.value as PocLineStyle,
                        })
                      }
                      style={{ padding: "2px 4px" }}
                    >
                      <option value="dotted">Dotted</option>
                      <option value="solid">Solid</option>
                      <option value="dashed">Dashed</option>
                    </select>
                  </>
                )}
              </div>
            </label>
            {settings.pocVisible && (
              <label className="indicator-settings-field">
                <span>POC Thickness {settings.pocLineWidth}px</span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={settings.pocLineWidth}
                  onChange={(e) =>
                    onSettingsChange({
                      ...settings,
                      pocLineWidth: Number(e.target.value),
                    })
                  }
                />
              </label>
            )}
            <label className="indicator-settings-field">
              <span>VAH / VAL Levels</span>
              <div
                style={{ display: "flex", gap: "8px", alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={settings.vahValVisible}
                  onChange={(e) =>
                    onSettingsChange({
                      ...settings,
                      vahValVisible: e.target.checked,
                    })
                  }
                />
                {settings.vahValVisible && (
                  <>
                    <input
                      type="color"
                      value={settings.vahColor}
                      onChange={(e) =>
                        onSettingsChange({
                          ...settings,
                          vahColor: e.target.value,
                        })
                      }
                      style={{ width: "40px", height: "24px" }}
                      title="VAH Color"
                    />
                    <select
                      value={settings.vahLineStyle}
                      onChange={(e) =>
                        onSettingsChange({
                          ...settings,
                          vahLineStyle: e.target.value as PocLineStyle,
                        })
                      }
                      style={{ padding: "2px 4px", fontSize: "12px" }}
                      title="VAH Style"
                    >
                      <option value="dotted">Dotted</option>
                      <option value="solid">Solid</option>
                      <option value="dashed">Dashed</option>
                    </select>
                    <input
                      type="color"
                      value={settings.valColor}
                      onChange={(e) =>
                        onSettingsChange({
                          ...settings,
                          valColor: e.target.value,
                        })
                      }
                      style={{ width: "40px", height: "24px" }}
                      title="VAL Color"
                    />
                    <select
                      value={settings.valLineStyle}
                      onChange={(e) =>
                        onSettingsChange({
                          ...settings,
                          valLineStyle: e.target.value as PocLineStyle,
                        })
                      }
                      style={{ padding: "2px 4px", fontSize: "12px" }}
                      title="VAL Style"
                    >
                      <option value="dotted">Dotted</option>
                      <option value="solid">Solid</option>
                      <option value="dashed">Dashed</option>
                    </select>
                  </>
                )}
              </div>
            </label>
            {settings.vahValVisible && (
              <label className="indicator-settings-field">
                <span>VAH / VAL Thickness {settings.vahValLineWidth}px</span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={settings.vahValLineWidth}
                  onChange={(e) =>
                    onSettingsChange({
                      ...settings,
                      vahValLineWidth: Number(e.target.value),
                    })
                  }
                />
              </label>
            )}
            <label className="indicator-settings-checkbox">
              <input
                type="checkbox"
                checked={visible}
                onChange={(e) => onVisibleChange(e.target.checked)}
              />
              <span>Show on chart</span>
            </label>
          </>
        )}
      </div>
    </IndicatorSettingsModal>
  );
}
