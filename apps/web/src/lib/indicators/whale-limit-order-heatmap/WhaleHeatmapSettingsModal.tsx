import { useLayoutEffect, useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import { WHALE_OUTCOMES } from "./wallStore";
import {
  DEFAULT_WHALE_SETTINGS,
  MAX_WHALE_THICKNESS,
  MIN_WHALE_THICKNESS,
  WHALE_CUT_PRESETS,
  WHALE_HOURS_CHOICES,
  WHALE_SETTINGS_SCHEMA,
  normalizeWhaleSettings,
  type WhaleSettings,
} from "./whaleSettings";

type SettingsTab = "inputs" | "visibility";

const OUTCOME_NAMES = ["Filled", "Partial", "Touched", "Pulled", "Moved"] as const;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  settings: WhaleSettings;
  onSettingsChange: (settings: WhaleSettings) => void;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  presetScope?: string;
}

export function WhaleHeatmapSettingsModal({ isOpen, onClose, settings, onSettingsChange, visible, onVisibleChange, presetScope }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  useLayoutEffect(() => {
    if (isOpen) setActiveTab("inputs");
  }, [isOpen]);

  function update(patch: Partial<WhaleSettings>) {
    onSettingsChange(normalizeWhaleSettings({ ...latestSettingsRef.current, ...patch }));
  }

  function toggleOutcome(index: number, on: boolean) {
    const bit = 1 << index;
    update({ outcomeMask: on ? latestSettingsRef.current.outcomeMask | bit : latestSettingsRef.current.outcomeMask & ~bit });
  }

  function handleReset() {
    onSettingsChange({ ...DEFAULT_WHALE_SETTINGS });
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Whale Limit Order Heatmap"
      ariaLabel="Whale limit order heatmap settings"
      presets={{
        presetKey: presetKeyFor("whaleLimitOrderHeatmap", presetScope),
        params: { ...settings },
        schema: WHALE_SETTINGS_SCHEMA,
        defaults: { ...DEFAULT_WHALE_SETTINGS },
        onApply: (params: PresetParams) => onSettingsChange(normalizeWhaleSettings(params as unknown as WhaleSettings)),
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
              <span>History</span>
              <select value={settings.hours} onChange={(event) => update({ hours: Number(event.target.value) })}>
                {WHALE_HOURS_CHOICES.map((hours) => (
                  <option key={hours} value={hours}>
                    {hours === 168 ? "7 days" : `${hours} hours`}
                  </option>
                ))}
              </select>
            </label>
            <label className="indicator-settings-field">
              <span>Cut walls by</span>
              <select value={settings.cutBasis} onChange={(event) => update({ cutBasis: event.target.value === "ratio" ? "ratio" : "usd" })}>
                <option value="usd">Dollar size</option>
                <option value="ratio">Importance</option>
              </select>
            </label>
            {settings.cutBasis === "usd" && (
              <label className="indicator-settings-field">
                <span>Show walls in the {WHALE_CUT_PRESETS[settings.cutPreset].label} by size</span>
                <input type="range" min={0} max={WHALE_CUT_PRESETS.length - 1} step={1} value={settings.cutPreset} onChange={(event) => update({ cutPreset: Number(event.target.value) })} />
              </label>
            )}
            {settings.cutBasis === "ratio" && (
              <label className="indicator-settings-field">
                <span>Importance at least {settings.ratioMin}x the usual wall</span>
                <input type="range" min={1} max={50} step={1} value={Math.min(50, settings.ratioMin)} onChange={(event) => update({ ratioMin: Number(event.target.value) })} />
              </label>
            )}
            <label className="indicator-settings-checkbox">
              <input type="checkbox" checked={settings.fills} onChange={(event) => update({ fills: event.target.checked })} />
              <span>Always show filled and partial walls</span>
            </label>
            <label className="indicator-settings-field">
              <span>Side</span>
              <select value={settings.sideFilter} onChange={(event) => update({ sideFilter: event.target.value === "bid" ? "bid" : event.target.value === "ask" ? "ask" : "both" })}>
                <option value="both">Bids and asks</option>
                <option value="bid">Bids only</option>
                <option value="ask">Asks only</option>
              </select>
            </label>
            <label className="indicator-settings-field">
              <span>Thickness: {settings.thickness} px</span>
              <input type="range" min={MIN_WHALE_THICKNESS} max={MAX_WHALE_THICKNESS} step={1} value={settings.thickness} onChange={(event) => update({ thickness: Number(event.target.value) })} />
            </label>
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" checked={visible} onChange={(event) => onVisibleChange(event.target.checked)} />
              <span>Show on chart</span>
            </label>
            {WHALE_OUTCOMES.map((_, index) => (
              <label key={OUTCOME_NAMES[index]} className="indicator-settings-checkbox">
                <input type="checkbox" checked={(settings.outcomeMask & (1 << index)) !== 0} onChange={(event) => toggleOutcome(index, event.target.checked)} />
                <span>Show {OUTCOME_NAMES[index].toLowerCase()} walls</span>
              </label>
            ))}
            <label className="indicator-settings-field">
              <span>Live book</span>
              <select value={settings.liveView} onChange={(event) => update({ liveView: normalizeWhaleSettings({ liveView: event.target.value }).liveView })}>
                <option value="ladder">Ladder strip</option>
                <option value="rays">Rays</option>
                <option value="both">Ladder and rays</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" checked={settings.labels} onChange={(event) => update({ labels: event.target.checked })} />
              <span>Label live walls with size and age</span>
            </label>
          </>
        )}
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset
        </button>
      </div>
    </IndicatorSettingsModal>
  );
}
