import { useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import { ABSORBED_MULTIPLE_SLIDER, ABSORBED_PERCENT_SLIDER, ABSORPTION_HISTORY_OPTIONS, ABSORPTION_SETTINGS_SCHEMA, ABSORPTION_SHAPE_OPTIONS, STRONG_PERCENT_SLIDER, absorbedMultipleOf, absorbedPercentOf, absorptionBubbleScaleOf, absorptionColorOf, absorptionHistoryDaysOf, absorptionShapeOf, strongPercentOf, type AbsorptionSettings } from "./absorptionSettings";

type SettingsTab = "inputs" | "visibility";

interface AbsorptionSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AbsorptionSettings;
  onSettingsChange: (settings: AbsorptionSettings) => void;
  defaults: AbsorptionSettings;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  presetScope?: string;
}

export function AbsorptionSettingsModal({ isOpen, onClose, settings, onSettingsChange, defaults, visible, onVisibleChange, presetScope }: AbsorptionSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  const absorbedPercent = absorbedPercentOf(settings);
  const strongPercent = strongPercentOf(settings);
  const absorbedMultiple = absorbedMultipleOf(settings);

  function update(patch: Partial<AbsorptionSettings>) {
    onSettingsChange({ ...latestSettingsRef.current, ...patch });
  }

  function handleReset() {
    onSettingsChange({ ...defaults });
    onVisibleChange(true);
  }

  function applyPreset(params: PresetParams) {
    const next = params as unknown as AbsorptionSettings;
    onSettingsChange({ ...next, shape: absorptionShapeOf(next), historyDays: absorptionHistoryDaysOf(next) });
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Prime Absorption"
      ariaLabel="Prime Absorption settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("absorptionDetector", presetScope),
        params: { ...settings },
        schema: ABSORPTION_SETTINGS_SCHEMA,
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
            <label className="indicator-settings-field">
              <span>Absorbed · {absorbedPercent}% of the wall</span>
              <input type="range" aria-label="Absorbed share" min={ABSORBED_PERCENT_SLIDER.min} max={ABSORBED_PERCENT_SLIDER.max} step={ABSORBED_PERCENT_SLIDER.step} value={absorbedPercent} onChange={(event) => update({ absorbedPercent: Number(event.target.value) })} />
              <small className="indicator-settings-hint">A sphere once this share of the wall has traded into it, with the wall still standing and price not through it. The walls are the heatmap's: its band, its paint floor; a wall showing less than the heatmap paints as a whole wall is read as that size.</small>
            </label>
            <label className="indicator-settings-field">
              <span>Strong · {strongPercent}%</span>
              <input type="range" aria-label="Strong share" min={STRONG_PERCENT_SLIDER.min} max={STRONG_PERCENT_SLIDER.max} step={STRONG_PERCENT_SLIDER.step} value={strongPercent} onChange={(event) => update({ strongPercent: Number(event.target.value) })} />
              <small className="indicator-settings-hint">The share at which the sphere becomes the darker ring, with the same ratio more than the minimum absorbed; never under the absorbed share.</small>
            </label>
            <label className="indicator-settings-field">
              <span>Minimum absorbed · {absorbedMultiple}× the book's typical level</span>
              <input type="range" aria-label="Minimum absorbed" min={ABSORBED_MULTIPLE_SLIDER.min} max={ABSORBED_MULTIPLE_SLIDER.max} step={ABSORBED_MULTIPLE_SLIDER.step} value={absorbedMultiple} onChange={(event) => update({ absorbedMultiple: Number(event.target.value) })} />
              <small className="indicator-settings-hint">What has to trade into the wall at the least, as a multiple of the heatmap's yardstick for the book when the attack began, so a small refilling wall prints only on real flow. The sphere needs the higher of the two floors.</small>
            </label>
            <label className="indicator-settings-checkbox" style={{ marginTop: 10 }}>
              <input type="checkbox" aria-label="Show broken levels" checked={settings.showBroken !== false} onChange={(event) => update({ showBroken: event.target.checked })} />
              <span>Show broken levels</span>
            </label>
            <small className="indicator-settings-hint">A sphere whose wall was closed through or pulled within three bars is drawn hollow; untick to hide those and keep the walls that held.</small>
            <div className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>History</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
                {ABSORPTION_HISTORY_OPTIONS.map(([days, label]) => (
                  <label key={days} className="indicator-settings-radio">
                    <input type="radio" name="absorption-history-days" checked={absorptionHistoryDaysOf(settings) === days} onChange={() => update({ historyDays: days })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <small className="indicator-settings-hint">How far behind the live book the spheres are read from the host's heatmap, oldest day first, and shown once the whole reach is in; Off keeps to the live book.</small>
            </div>
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-field">
              <span>Bid wall spheres</span>
              <input type="color" aria-label="Bid wall colour" value={absorptionColorOf(settings, "bid")} onChange={(event) => update({ bidColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Ask wall spheres</span>
              <input type="color" aria-label="Ask wall colour" value={absorptionColorOf(settings, "ask")} onChange={(event) => update({ askColor: event.target.value })} />
              <small className="indicator-settings-hint">The heatmap's colours until you pick your own; Reset puts them back.</small>
            </label>
            <label className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>Bubble size ×{absorptionBubbleScaleOf(settings).toFixed(1)}</span>
              <input type="range" aria-label="Bubble size" min={0.5} max={2.5} step={0.1} value={absorptionBubbleScaleOf(settings)} onChange={(event) => update({ bubbleScale: Number(event.target.value) })} />
              <small className="indicator-settings-hint">The spheres' own size.</small>
            </label>
            <div className="indicator-settings-field">
              <span>Shape</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
                {ABSORPTION_SHAPE_OPTIONS.map(([shape, label]) => (
                  <label key={shape} className="indicator-settings-radio">
                    <input type="radio" name="absorption-shape" checked={absorptionShapeOf(settings) === shape} onChange={() => update({ shape })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <small className="indicator-settings-hint">How each absorption is drawn; a triangle points up on a bid wall and down on an ask wall. A sphere whose wall broke later is drawn hollow.</small>
            </div>
            <label className="indicator-settings-field">
              <span>Opacity {Math.round(settings.opacity * 100)}%</span>
              <input type="range" aria-label="Opacity" min={0.15} max={1} step={0.05} value={settings.opacity} onChange={(event) => update({ opacity: Number(event.target.value) })} />
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
