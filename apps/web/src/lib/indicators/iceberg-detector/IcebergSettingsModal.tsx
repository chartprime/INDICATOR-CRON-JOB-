import { useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import type { FrameIdentity } from "../../../types/frames";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import { ICEBERG_HISTORY_OPTIONS, ICEBERG_SETTINGS_SCHEMA, ICEBERG_MARK_SHAPES, ICEBERG_PLACEMENTS, icebergColorOf, icebergHistoryDaysOf, icebergMarkScaleOf, icebergPlacementOf, icebergShapeOf, icebergSizeTopPercentOf, type IcebergSettings, ICEBERG_MAX_TRANCHES, ICEBERG_MIN_TRANCHES, icebergMinTranchesOf } from "./icebergSettings";

type SettingsTab = "inputs" | "visibility";

interface IcebergSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: IcebergSettings;
  onSettingsChange: (settings: IcebergSettings) => void;
  defaults: IcebergSettings;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  identity: { symbol: string } & FrameIdentity;
  presetScope?: string;
}

export function IcebergSettingsModal({ isOpen, onClose, settings, onSettingsChange, defaults, visible, onVisibleChange, identity, presetScope }: IcebergSettingsModalProps) {
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const crypto = identity.provider === "BINANCE";

  function update(patch: Partial<IcebergSettings>) {
    onSettingsChange({ ...latestSettingsRef.current, ...patch });
  }

  function handleReset() {
    onSettingsChange({ ...defaults });
    onVisibleChange(true);
  }

  function applyPreset(params: PresetParams) {
    onSettingsChange(params as IcebergSettings);
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Iceberg Detector"
      ariaLabel="Iceberg Detector settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("icebergDetector", presetScope),
        params: { ...settings },
        schema: ICEBERG_SETTINGS_SCHEMA,
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
            <small className="indicator-settings-hint">
              {crypto
                ? "On Binance a mark is a probable iceberg: a price that kept taking more than it showed, judged against this pair's own book. The exchange does not mark these."
                : "On CME a mark is a native iceberg: the exchange itself refilled the order's visible part, so it is certain."}
            </small>
            <div className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>History</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
                {ICEBERG_HISTORY_OPTIONS.map(([days, label]) => (
                  <label key={days} className="indicator-settings-radio">
                    <input type="radio" name="iceberg-history-days" checked={icebergHistoryDaysOf(settings) === days} onChange={() => update({ historyDays: days })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <small className="indicator-settings-hint">How far back settled icebergs are shown; a live one always shows. Off is live like absorption: what this runtime saw inside the heatmap's live window. A span adds the stored history and what the host saw.</small>
            </div>
            <label className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>Size: biggest {icebergSizeTopPercentOf(settings)}%</span>
              <input type="range" min={1} max={100} step={1} value={icebergSizeTopPercentOf(settings)} onChange={(event) => update({ sizeTopPercent: Number(event.target.value) })} />
              <small className="indicator-settings-hint">Ranks the icebergs on this chart by total size and keeps the biggest share; 100% shows them all. A percentage, so it means the same on every instrument. The live window and the older history are ranked apart, so below the hour a history span only adds. From 1h up a candle keeps only its biggest mark, so a span can replace a smaller live one in the same candle.</small>
            </label>
            <label className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>Refills: at least ×{icebergMinTranchesOf(settings)}</span>
              <input type="range" min={ICEBERG_MIN_TRANCHES} max={ICEBERG_MAX_TRANCHES} step={1} value={icebergMinTranchesOf(settings)} onChange={(event) => update({ minTranches: Number(event.target.value) })} />
              <small className="indicator-settings-hint">Compares the ×N printed on the card, the 80 in 160 (2 × 80): how many orders of the shown size make up the total. An iceberg under it is hidden, a live one too; ×2 is the default.</small>
            </label>
            <label className="indicator-settings-checkbox" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={settings.showPulled === true} onChange={(event) => update({ showPulled: event.target.checked })} />
              <span>Show pulled icebergs</span>
            </label>
            <small className="indicator-settings-hint">An iceberg its owner cancelled before it was done, dashed; the card shows its total, the hover what had traded before the pull.</small>
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" checked={settings.labels !== false} onChange={(event) => update({ labels: event.target.checked })} />
              <span>Labels</span>
            </label>
            <small className="indicator-settings-hint">A card at the end of each line, kept clear of the candles, above a sell iceberg and below a buy: ICEBERG, an arrow in the side's colour, then the total size and how it adds up; 160 (2 × 80) is 80 orders of 2. Off leaves only the points.</small>
            <div className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>Mark placement</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
                {ICEBERG_PLACEMENTS.map(([placement, label]) => (
                  <label key={placement} className="indicator-settings-radio">
                    <input type="radio" name="iceberg-placement" checked={icebergPlacementOf(settings) === placement} onChange={() => update({ placement })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <small className="indicator-settings-hint">Where the mark sits on its candle: at the iceberg's own price, or at the candle's high for a sell and its low for a buy. The hover and the mark's size stay the iceberg's.</small>
            </div>
            <div className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>Mark shape</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
                {ICEBERG_MARK_SHAPES.map(([shape, label]) => (
                  <label key={shape} className="indicator-settings-radio">
                    <input type="radio" name="iceberg-mark-shape" checked={icebergShapeOf(settings, crypto ? "probable" : "native") === shape} onChange={() => update({ markShape: shape })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <small className="indicator-settings-hint">Dot and triangle are filled, circle is an outline; a dashed outline is a weak, pulled or interrupted iceberg. Each mark grows with its total size, the biggest on the chart drawn largest.</small>
            </div>
            <label className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>Bid icebergs</span>
              <input type="color" value={icebergColorOf(settings, "bid")} onChange={(event) => update({ bidColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Ask icebergs</span>
              <input type="color" value={icebergColorOf(settings, "ask")} onChange={(event) => update({ askColor: event.target.value })} />
              <small className="indicator-settings-hint">Point, line and the card's arrow. The heatmap's colours until you pick your own; Reset puts them back.</small>
            </label>
            <label className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>Mark size ×{icebergMarkScaleOf(settings).toFixed(1)}</span>
              <input type="range" min={0.5} max={2.5} step={0.1} value={icebergMarkScaleOf(settings)} onChange={(event) => update({ markScale: Number(event.target.value) })} />
              <small className="indicator-settings-hint">Scales every mark; within that, each one follows its total size.</small>
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
