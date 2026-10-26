import { useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import { EXHAUSTION_HISTORY_OPTIONS, EXHAUSTION_SETTINGS_SCHEMA, LEG_ATR_RANGE, LEG_EFFICIENCY_RANGE, LEG_REVERSE_RANGE, SCORE_RANGE, ZONE_SCALE_RANGE, exhaustionColorOf, exhaustionHistoryDaysOf, exhaustionMinScoreOf, exhaustionOpacityOf, exhaustionZoneScaleOf, legSettingsOf, type ExhaustionSettings } from "./exhaustionSettings";

type SettingsTab = "inputs" | "visibility";

interface ExhaustionSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: ExhaustionSettings;
  onSettingsChange: (settings: ExhaustionSettings) => void;
  defaults: ExhaustionSettings;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  presetScope?: string;
}

export function ExhaustionSettingsModal({ isOpen, onClose, settings, onSettingsChange, defaults, visible, onVisibleChange, presetScope }: ExhaustionSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  const legs = legSettingsOf(settings);

  function update(patch: Partial<ExhaustionSettings>) {
    onSettingsChange({ ...latestSettingsRef.current, ...patch });
  }

  function handleReset() {
    onSettingsChange({ ...defaults });
    onVisibleChange(true);
  }

  function applyPreset(params: PresetParams) {
    onSettingsChange(params as unknown as ExhaustionSettings);
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Exhaustion"
      ariaLabel="Exhaustion settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("exhaustion", presetScope),
        params: { ...settings },
        schema: EXHAUSTION_SETTINGS_SCHEMA,
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
              <span>Legs · {legs.atrMultiple} ATR at the least</span>
              <input type="range" aria-label="Leg size in ATR" min={LEG_ATR_RANGE[0]} max={LEG_ATR_RANGE[1]} step={1} value={legs.atrMultiple} onChange={(event) => update({ legAtr: Number(event.target.value) })} />
            </div>
            <div className="indicator-settings-field">
              <span>Leg ends on a pullback of {legs.reverseAtr} ATR</span>
              <input type="range" aria-label="Leg reversal in ATR" min={LEG_REVERSE_RANGE[0]} max={LEG_REVERSE_RANGE[1]} step={0.5} value={legs.reverseAtr} onChange={(event) => update({ legReverseAtr: Number(event.target.value) })} />
            </div>
            <div className="indicator-settings-field">
              <span>Straightness {Math.round(legs.minEfficiency * 100)}%</span>
              <input type="range" aria-label="Leg straightness" min={LEG_EFFICIENCY_RANGE[0]} max={LEG_EFFICIENCY_RANGE[1]} step={0.05} value={legs.minEfficiency} onChange={(event) => update({ legEfficiency: Number(event.target.value) })} />
            </div>
            <div className="indicator-settings-field">
              <span>Confidence at least {exhaustionMinScoreOf(settings)} of 6</span>
              <input type="range" aria-label="Confidence score" min={SCORE_RANGE[0]} max={SCORE_RANGE[1]} step={1} value={exhaustionMinScoreOf(settings)} onChange={(event) => update({ minScore: Number(event.target.value) })} />
            </div>
            <div className="indicator-settings-field">
              <span>Exhaustion area ×{exhaustionZoneScaleOf(settings)}</span>
              <input type="range" aria-label="Exhaustion area size" min={ZONE_SCALE_RANGE[0]} max={ZONE_SCALE_RANGE[1]} step={0.5} value={exhaustionZoneScaleOf(settings)} onChange={(event) => update({ zoneScale: Number(event.target.value) })} />
            </div>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" aria-label="Show exhaustion areas only" checked={settings.zonesOnly === true} onChange={(event) => update({ zonesOnly: event.target.checked })} />
              <span>Show exhaustion areas only</span>
            </label>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" aria-label="Show legs" checked={settings.showLegs === true} onChange={(event) => update({ showLegs: event.target.checked })} />
              <span>Show legs</span>
            </label>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" aria-label="Hide nested legs" checked={settings.hideNestedLegs === true} onChange={(event) => update({ hideNestedLegs: event.target.checked })} />
              <span>Hide nested legs</span>
            </label>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" aria-label="Show broken" checked={settings.showBroken !== false} onChange={(event) => update({ showBroken: event.target.checked })} />
              <span>Show broken</span>
            </label>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" aria-label="Show monitor" checked={settings.showMonitor !== false} onChange={(event) => update({ showMonitor: event.target.checked })} />
              <span>Show monitor</span>
            </label>
            <div className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>History</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
                {EXHAUSTION_HISTORY_OPTIONS.map(([days, label]) => (
                  <label key={days} className="indicator-settings-radio">
                    <input type="radio" name="exhaustion-history-days" checked={exhaustionHistoryDaysOf(settings) === days} onChange={() => update({ historyDays: days })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-field">
              <span>Buyers exhausted</span>
              <input type="color" aria-label="Buyers exhausted colour" value={exhaustionColorOf(settings, "buyers")} onChange={(event) => update({ buyerColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Sellers exhausted</span>
              <input type="color" aria-label="Sellers exhausted colour" value={exhaustionColorOf(settings, "sellers")} onChange={(event) => update({ sellerColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Opacity {Math.round(exhaustionOpacityOf(settings) * 100)}%</span>
              <input type="range" aria-label="Opacity" min={0.15} max={1} step={0.05} value={exhaustionOpacityOf(settings)} onChange={(event) => update({ opacity: Number(event.target.value) })} />
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
