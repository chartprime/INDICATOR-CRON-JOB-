import { useLayoutEffect, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import type { PresetParams } from "../../chart/indicatorPresets";
import { VOLUME_DELTA_PROFILE_OHLC_PERSISTENCE_SCHEMA } from "./volumeDeltaProfileOhlc";
import {
  MAX_PROFILE_WIDTH_PX,
  MIN_PROFILE_WIDTH_PX,
  PROFILE_WIDTH_STEP_PX,
  DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS,
  type PocLineStyle,
  type VolumeDeltaProfileOhlcSettings,
} from "./volumeDeltaProfileOhlcSettings";

type SettingsTab = "inputs" | "visibility";

interface VolumeProfileOhlcSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: VolumeDeltaProfileOhlcSettings;
  onSettingsChange: (settings: VolumeDeltaProfileOhlcSettings) => void;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
}

export function VolumeProfileOhlcSettingsModal({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  visible,
  onVisibleChange,
}: VolumeProfileOhlcSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");

  useLayoutEffect(() => {
    if (isOpen) setActiveTab("inputs");
  }, [isOpen]);

  function handleReset() {
    onSettingsChange(DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS);
    onVisibleChange(true);
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Volume Profile OHLC"
      ariaLabel="Volume Profile OHLC settings"
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
        presetKey: "volumeDeltaProfileOhlc",
        params: { ...settings },
        schema: VOLUME_DELTA_PROFILE_OHLC_PERSISTENCE_SCHEMA,
        defaults: { ...DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS },
        onApply: (params: PresetParams) => onSettingsChange(params as unknown as VolumeDeltaProfileOhlcSettings),
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
                min={MIN_PROFILE_WIDTH_PX}
                max={MAX_PROFILE_WIDTH_PX}
                step={PROFILE_WIDTH_STEP_PX}
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
                max={500}
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
