import { useLayoutEffect, useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import { MAX_WIDTH_SHARE, MIN_WIDTH_SHARE } from "../live-delta-profile/liveDeltaProfileSettings";
import { clusterRowsFor, type LiquiditySettings } from "../passive-liquidity/liquiditySettings";
import {
  DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS,
  LIVE_ORDER_BOOK_PROFILE_SETTINGS_SCHEMA,
  MAX_RESTING_SHARE,
  MAX_RESTING_STAND_S,
  MIN_RESTING_SHARE,
  MIN_RESTING_STAND_S,
  ROW_FACTOR_CHOICES,
  autoMinSize,
  restingSizeRange,
  type LiveOrderBookProfileSettings,
} from "./liveOrderBookProfileSettings";

type SettingsTab = "inputs" | "visibility";

interface LiveOrderBookProfileSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: LiveOrderBookProfileSettings;
  onSettingsChange: (settings: LiveOrderBookProfileSettings) => void;
  defaults?: LiveOrderBookProfileSettings;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  heatmapSettings: Pick<LiquiditySettings, "clusterRows">;
  rowWidth?: number;
  intervalMs?: number;
  typicalSize?: number;
  sizeUnit?: string;
  presetScope?: string;
}

function rowWords(rows: number, rowWidth: number): string {
  const step = rows * rowWidth;
  return step >= 1 ? step.toLocaleString("en-US", { maximumFractionDigits: 2 }) : step.toFixed(Math.min(8, Math.ceil(-Math.log10(step))));
}

export function LiveOrderBookProfileSettingsModal({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  defaults = DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS,
  visible,
  onVisibleChange,
  heatmapSettings,
  rowWidth = 1,
  intervalMs = 60_000,
  typicalSize = 0,
  sizeUnit = "",
  presetScope,
}: LiveOrderBookProfileSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;

  useLayoutEffect(() => {
    if (isOpen) setActiveTab("inputs");
  }, [isOpen]);

  function update(patch: Partial<LiveOrderBookProfileSettings>) {
    onSettingsChange({ ...latestSettingsRef.current, ...patch });
  }

  function handleReset() {
    onSettingsChange({ ...defaults });
    onVisibleChange(true);
  }

  function applyPreset(params: PresetParams) {
    onSettingsChange(params as unknown as LiveOrderBookProfileSettings);
  }

  const heatmapRows = clusterRowsFor(heatmapSettings, intervalMs);
  const sizeRange = restingSizeRange(typicalSize);
  const unit = sizeUnit === "" ? "" : ` ${sizeUnit}`;

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Live Order Book Profile"
      ariaLabel="Live Order Book Profile settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("liveOrderBookProfile", presetScope),
        params: { ...settings },
        schema: LIVE_ORDER_BOOK_PROFILE_SETTINGS_SCHEMA,
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
            <div className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>Row size</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }} role="radiogroup" aria-label="Row size">
                {ROW_FACTOR_CHOICES.map((rows) => (
                  <label key={rows} className="indicator-settings-radio">
                    <input
                      type="radio"
                      name="live-order-book-row-size"
                      checked={settings.rowFactor === rows}
                      onChange={() => update({ rowFactor: rows })}
                    />
                    <span>{rows === 0 ? `Same as the heatmap (${rowWords(heatmapRows, rowWidth)} on this chart)` : rowWords(rows, rowWidth)}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="indicator-settings-field">
              <span>Profile width {Math.round(settings.widthShare * 100)}%</span>
              <input
                type="range"
                min={MIN_WIDTH_SHARE}
                max={MAX_WIDTH_SHARE}
                step={0.01}
                value={settings.widthShare}
                onChange={(event) => update({ widthShare: Number(event.target.value) })}
              />
            </label>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" checked={settings.showNumbers} onChange={(event) => update({ showNumbers: event.target.checked })} />
              <span>Show sizes</span>
            </label>
            <div className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>Bigger order S/R zones</span>
              <div style={{ display: "flex", gap: "6px 18px" }} role="radiogroup" aria-label="Bigger order S/R zones">
                {[true, false].map((on) => (
                  <label key={String(on)} className="indicator-settings-radio">
                    <input type="radio" name="live-order-book-zones" checked={settings.showResting === on} onChange={() => update({ showResting: on })} />
                    <span>{on ? "On" : "Off"}</span>
                  </label>
                ))}
              </div>
            </div>
            {settings.showResting && (
              <>
                <label className="indicator-settings-field">
                  <span>{settings.restingMinSize > 0 ? `Min size ${settings.restingMinSize}${unit}` : `Min size auto (${autoMinSize(typicalSize)}${unit} now)`}</span>
                  <input
                    type="range"
                    aria-label="Min size"
                    min={0}
                    max={sizeRange.max}
                    step={sizeRange.step}
                    value={settings.restingMinSize}
                    onChange={(event) => update({ restingMinSize: Number(event.target.value) })}
                  />
                </label>
                <label className="indicator-settings-field">
                  <span>Show after {settings.restingStandS} s</span>
                  <input
                    type="range"
                    aria-label="Big order wait"
                    min={MIN_RESTING_STAND_S}
                    max={MAX_RESTING_STAND_S}
                    step={1}
                    value={settings.restingStandS}
                    onChange={(event) => update({ restingStandS: Number(event.target.value) })}
                  />
                </label>
                <label className="indicator-settings-field">
                  <span>Bar length {Math.round(settings.restingShare * 100)}%</span>
                  <input
                    type="range"
                    aria-label="Big order reach"
                    min={MIN_RESTING_SHARE}
                    max={MAX_RESTING_SHARE}
                    step={0.01}
                    value={settings.restingShare}
                    onChange={(event) => update({ restingShare: Number(event.target.value) })}
                  />
                </label>
              </>
            )}
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-field">
              <span>Bids color</span>
              <input type="color" value={settings.bidColor} onChange={(event) => update({ bidColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Asks color</span>
              <input type="color" value={settings.askColor} onChange={(event) => update({ askColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Spread marker color</span>
              <input type="color" value={settings.spreadColor} onChange={(event) => update({ spreadColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Bar opacity {Math.round(settings.opacity * 100)}%</span>
              <input type="range" min={0.2} max={1} step={0.05} value={settings.opacity} onChange={(event) => update({ opacity: Number(event.target.value) })} />
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
