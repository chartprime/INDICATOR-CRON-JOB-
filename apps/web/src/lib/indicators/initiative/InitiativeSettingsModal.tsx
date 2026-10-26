import { useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import { INITIATIVE_HISTORY_OPTIONS, INITIATIVE_SETTINGS_SCHEMA, MAX_SCORE, MIN_LEG_ATR_RANGE, SCORE_RANGE, initiativeColorOf, initiativeHistoryDaysOf, initiativeMinLegAtrOf, initiativeMinScoreOf, initiativeOpacityOf, type InitiativeSettings } from "./initiativeSettings";

type SettingsTab = "inputs" | "visibility";

interface InitiativeSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: InitiativeSettings;
  onSettingsChange: (settings: InitiativeSettings) => void;
  defaults: InitiativeSettings;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  presetScope?: string;
}

export function InitiativeSettingsModal({ isOpen, onClose, settings, onSettingsChange, defaults, visible, onVisibleChange, presetScope }: InitiativeSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;

  function update(patch: Partial<InitiativeSettings>) {
    onSettingsChange({ ...latestSettingsRef.current, ...patch });
  }

  function handleReset() {
    onSettingsChange({ ...defaults });
    onVisibleChange(true);
  }

  function applyPreset(params: PresetParams) {
    onSettingsChange(params as unknown as InitiativeSettings);
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Initiative Continuation"
      ariaLabel="Initiative Continuation settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("initiative", presetScope),
        params: { ...settings },
        schema: INITIATIVE_SETTINGS_SCHEMA,
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
            <div className="indicator-settings-field">
              <span>Score at least {initiativeMinScoreOf(settings)} of {MAX_SCORE}</span>
              <input type="range" aria-label="Minimum score" min={SCORE_RANGE[0]} max={SCORE_RANGE[1]} step={1} value={initiativeMinScoreOf(settings)} onChange={(event) => update({ minScore: Number(event.target.value) })} />
            </div>
            <div className="indicator-settings-field">
              <span>Leg at least {initiativeMinLegAtrOf(settings)} ATR</span>
              <input type="range" aria-label="Minimum leg size" min={MIN_LEG_ATR_RANGE[0]} max={MIN_LEG_ATR_RANGE[1]} step={0.5} value={initiativeMinLegAtrOf(settings)} onChange={(event) => update({ minLegAtr: Number(event.target.value) })} />
            </div>
            <div className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>History</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
                {INITIATIVE_HISTORY_OPTIONS.map(([days, label]) => (
                  <label key={days} className="indicator-settings-radio">
                    <input type="radio" name="initiative-history-days" checked={initiativeHistoryDaysOf(settings) === days} onChange={() => update({ historyDays: days })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" aria-label="Show shade" checked={settings.showShade !== false} onChange={(event) => update({ showShade: event.target.checked })} />
              <span>Show shade</span>
            </label>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" aria-label="Show chip" checked={settings.showLabels !== false} onChange={(event) => update({ showLabels: event.target.checked })} />
              <span>Show chip</span>
            </label>
            <label className="indicator-settings-field">
              <span>Buyers</span>
              <input type="color" aria-label="Buyers colour" value={initiativeColorOf(settings, "buyers")} onChange={(event) => update({ buyerColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Sellers</span>
              <input type="color" aria-label="Sellers colour" value={initiativeColorOf(settings, "sellers")} onChange={(event) => update({ sellerColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Opacity {Math.round(initiativeOpacityOf(settings) * 100)}%</span>
              <input type="range" aria-label="Opacity" min={0.15} max={1} step={0.05} value={initiativeOpacityOf(settings)} onChange={(event) => update({ opacity: Number(event.target.value) })} />
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
