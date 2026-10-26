import { useLayoutEffect, useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import {
  DEFAULT_L2_BOOK_MAP_SETTINGS,
  L2_BOOK_MAP_SETTINGS_SCHEMA,
  MAX_L2_BOOK_MAP_WINDOW_BUCKETS,
  normalizeL2BookMapSettings,
  type L2BookMapSettings,
} from "./l2BookMapPrimitive";

type SettingsTab = "inputs" | "visibility";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  settings: L2BookMapSettings;
  onSettingsChange: (settings: L2BookMapSettings) => void;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  intervalMs?: number;
  presetScope?: string;
}

export function L2BookMapSettingsModal({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  visible,
  onVisibleChange,
  intervalMs,
  presetScope,
}: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  const intervalSeconds =
    typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs > 0
      ? Math.round(intervalMs / 1_000)
      : null;
  const [windowBucketsInput, setWindowBucketsInput] = useState(
    String(settings.windowBuckets),
  );
  useLayoutEffect(() => {
    if (!isOpen) return;
    setActiveTab("inputs");
    setWindowBucketsInput(String(latestSettingsRef.current.windowBuckets));
  }, [isOpen]);

  function update(patch: Partial<L2BookMapSettings>) {
    onSettingsChange(
      normalizeL2BookMapSettings({
        ...latestSettingsRef.current,
        ...patch,
      }),
    );
  }

  function applySettings(next: L2BookMapSettings) {
    onSettingsChange(next);
    setWindowBucketsInput(String(next.windowBuckets));
  }

  function handleReset() {
    applySettings({ ...DEFAULT_L2_BOOK_MAP_SETTINGS });
  }

  function applyPreset(params: PresetParams) {
    applySettings(normalizeL2BookMapSettings(params as unknown as L2BookMapSettings));
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="L2 Liquidity Book Map"
      ariaLabel="L2 liquidity book map settings"
      presets={{
        presetKey: presetKeyFor("l2BookMap", presetScope),
        params: { ...settings },
        schema: L2_BOOK_MAP_SETTINGS_SCHEMA,
        defaults: { ...DEFAULT_L2_BOOK_MAP_SETTINGS },
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
            <p className="indicator-settings-hint">
              Coarse history uses peak depth per interval. This is a depth-time proxy, not traded volume or measured time-at-size.
            </p>
            <label className="indicator-settings-field">
              <span>Price Bin Rows: {settings.priceBinRows === 0 ? "native (1 row)" : settings.priceBinRows}</span>
              <input
                type="range"
                min={0}
                max={50}
                step={1}
                value={settings.priceBinRows}
                onChange={(event) =>
                  update({ priceBinRows: Number(event.target.value) })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>Vertical Range: {settings.verticalRangeRows} rows (0 =
                unlimited)</span>
              <input
                type="range"
                min={0}
                max={5000}
                step={1}
                value={settings.verticalRangeRows}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 0 && value <= 5000) {
                    update({ verticalRangeRows: value });
                  }
                }}
              />
            </label>
            <p className="indicator-settings-hint">
              Time bucket: one per candle — automatic for the timeframe
              {intervalSeconds === null ? "" : ` (${intervalSeconds}s)`}.
            </p>
            <label className="indicator-settings-field">
              <span>Window (time buckets / bars)</span>
              <input
                type="number"
                min={1}
                max={MAX_L2_BOOK_MAP_WINDOW_BUCKETS}
                step={1}
                value={windowBucketsInput}
                onChange={(event) => {
                  const raw = event.target.value;
                  setWindowBucketsInput(raw);
                  const value = Number(raw);
                  if (
                    raw.trim() !== "" &&
                    Number.isInteger(value) &&
                    value >= 1 &&
                    value <= MAX_L2_BOOK_MAP_WINDOW_BUCKETS
                  )
                    update({ windowBuckets: value });
                }}
              />
            </label>
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-checkbox">
              <input
                type="checkbox"
                checked={visible}
                onChange={(event) => onVisibleChange(event.target.checked)}
              />
              <span>Show on chart</span>
            </label>
            <label className="indicator-settings-checkbox">
              <input
                type="checkbox"
                checked={settings.showProfile}
                onChange={(event) =>
                  update({ showProfile: event.target.checked })
                }
              />
              <span>Show depth-time proxy profile</span>
            </label>
            <label className="indicator-settings-checkbox">
              <input
                type="checkbox"
                checked={settings.showBidPoc}
                onChange={(event) =>
                  update({ showBidPoc: event.target.checked })
                }
              />
              <span>Show bid POC guide</span>
            </label>
            <label className="indicator-settings-checkbox">
              <input
                type="checkbox"
                checked={settings.showAskPoc}
                onChange={(event) =>
                  update({ showAskPoc: event.target.checked })
                }
              />
              <span>Show ask POC guide</span>
            </label>
            <label className="indicator-settings-field">
              <span>Profile Bid Color</span>
              <input
                type="color"
                value={settings.profileBidColor}
                onChange={(event) =>
                  update({ profileBidColor: event.target.value })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>Profile Ask Color</span>
              <input
                type="color"
                value={settings.profileAskColor}
                onChange={(event) =>
                  update({ profileAskColor: event.target.value })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>Low Exposure Color</span>
              <input
                type="color"
                value={settings.lowVolumeColor}
                onChange={(event) =>
                  update({ lowVolumeColor: event.target.value })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>Mid Exposure Color</span>
              <input
                type="color"
                value={settings.midVolumeColor}
                onChange={(event) =>
                  update({ midVolumeColor: event.target.value })
                }
              />
            </label>
            <label className="indicator-settings-field">
              <span>High Exposure Color</span>
              <input
                type="color"
                value={settings.highVolumeColor}
                onChange={(event) =>
                  update({ highVolumeColor: event.target.value })
                }
              />
            </label>
          </>
        )}
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
