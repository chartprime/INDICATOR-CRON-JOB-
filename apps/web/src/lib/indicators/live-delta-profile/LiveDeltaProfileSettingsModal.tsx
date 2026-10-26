import { useLayoutEffect, useRef, useState } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import {
  DEFAULT_LIVE_DELTA_PROFILE_SETTINGS,
  LIVE_DELTA_PROFILE_SETTINGS_SCHEMA,
  MAX_ROLLING_HOURS,
  MAX_WIDTH_SHARE,
  MIN_ROLLING_HOURS,
  MIN_WIDTH_SHARE,
  ROLLING_STEP_HOURS,
  ROW_FACTOR_CHOICES,
  AUTO_ROLLING_HOURS,
  WINDOW_MODES,
  autoRowFactorFor,
  autoWindowMode,
  rollingHoursOf,
  type LiveDeltaProfileSettings,
  type ProfileWindowMode,
} from "./liveDeltaProfileSettings";

type SettingsTab = "inputs" | "visibility";

const WINDOW_LABELS: Record<ProfileWindowMode, string> = {
  auto: "Auto",
  week: "Full week",
  day: "Full day",
  session: "Session (Asia, London, NY AM, NY PM)",
  rolling: "Last N hours",
  visible: "Visible range",
};

interface LiveDeltaProfileSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: LiveDeltaProfileSettings;
  onSettingsChange: (settings: LiveDeltaProfileSettings) => void;
  defaults?: LiveDeltaProfileSettings;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  rowWidth?: number;
  intervalMs?: number;
  presetScope?: string;
}

function rowWords(factor: number, rowWidth: number): string {
  const step = factor * rowWidth;
  return step >= 1 ? step.toLocaleString("en-US", { maximumFractionDigits: 2 }) : step.toFixed(Math.min(8, Math.ceil(-Math.log10(step))));
}

export function LiveDeltaProfileSettingsModal({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  defaults = DEFAULT_LIVE_DELTA_PROFILE_SETTINGS,
  visible,
  onVisibleChange,
  rowWidth = 1,
  intervalMs = 60_000,
  presetScope,
}: LiveDeltaProfileSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const [hoursInput, setHoursInput] = useState(String(settings.rollingHours));
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;

  useLayoutEffect(() => {
    if (isOpen) {
      setActiveTab("inputs");
      setHoursInput(String(latestSettingsRef.current.rollingHours));
    }
  }, [isOpen]);

  function update(patch: Partial<LiveDeltaProfileSettings>) {
    onSettingsChange({ ...latestSettingsRef.current, ...patch });
  }

  function handleReset() {
    onSettingsChange({ ...defaults });
    onVisibleChange(true);
    setHoursInput(String(defaults.rollingHours));
  }

  function applyPreset(params: PresetParams) {
    const next = params as unknown as LiveDeltaProfileSettings;
    onSettingsChange(next);
    setHoursInput(String(next.rollingHours));
  }

  const autoFactor = autoRowFactorFor(intervalMs);

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Live Delta Profile"
      ariaLabel="Live Delta Profile settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("liveDeltaProfile", presetScope),
        params: { ...settings },
        schema: LIVE_DELTA_PROFILE_SETTINGS_SCHEMA,
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
              <span>Window</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }} role="radiogroup" aria-label="Window">
                {WINDOW_MODES.map((mode) => (
                  <label key={mode} className="indicator-settings-radio">
                    <input type="radio" name="live-delta-window" checked={settings.windowMode === mode} onChange={() => update({ windowMode: mode })} />
                    <span>{mode === "auto" ? `Auto (${autoWindowMode(intervalMs) === "rolling" ? `last ${AUTO_ROLLING_HOURS} h` : "today"} on this chart)` : WINDOW_LABELS[mode]}</span>
                  </label>
                ))}
              </div>
              <small className="indicator-settings-hint">
                {settings.windowMode === "auto"
                  ? `Follows the chart: the last ${AUTO_ROLLING_HOURS} h on 1m and 5m, the full trading day on higher timeframes.`
                  : settings.windowMode === "week"
                  ? "Since the trading week opened: Monday 00:00 UTC on crypto, Sunday 18:00 New York on futures, Monday midnight New York on stocks. The first load of a week takes up to a minute; today shows first."
                  : settings.windowMode === "day"
                  ? "Since the trading day opened: 00:00 UTC on crypto, 18:00 New York on futures, midnight New York on stocks."
                  : settings.windowMode === "session"
                    ? "The Killzones session the clock is in; between sessions the last one stays, frozen."
                    : settings.windowMode === "visible"
                      ? "The candles on screen: it redraws when you stop scrolling or zooming, and keeps counting live prints while the newest candle is in view. No further back than the week the host keeps."
                      : `The last ${rollingHoursOf(settings)} h, moving on in half-hour steps.`}
              </small>
            </div>
            {settings.windowMode === "rolling" && (
              <label className="indicator-settings-field">
                <span>Hours</span>
                <input
                  type="number"
                  min={MIN_ROLLING_HOURS}
                  max={MAX_ROLLING_HOURS}
                  step={ROLLING_STEP_HOURS}
                  value={hoursInput}
                  onChange={(event) => {
                    const raw = event.target.value;
                    setHoursInput(raw);
                    const value = Number(raw);
                    if (raw.trim() !== "" && Number.isFinite(value) && value >= MIN_ROLLING_HOURS && value <= MAX_ROLLING_HOURS) update({ rollingHours: value });
                  }}
                />
                <small className="indicator-settings-hint">From {MIN_ROLLING_HOURS} to {MAX_ROLLING_HOURS}, in halves.</small>
              </label>
            )}
            <div className="indicator-settings-field" style={{ marginTop: 10 }}>
              <span>Row size</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }} role="radiogroup" aria-label="Row size">
                {ROW_FACTOR_CHOICES.map((factor) => (
                  <label key={factor} className="indicator-settings-radio">
                    <input
                      type="radio"
                      name="live-delta-row-size"
                      checked={settings.rowFactor === factor}
                      onChange={() => update({ rowFactor: factor })}
                    />
                    <span>{factor === 0 ? `Auto (${rowWords(autoFactor, rowWidth)} on this chart)` : rowWords(factor, rowWidth)}</span>
                  </label>
                ))}
              </div>
              <small className="indicator-settings-hint">
                Auto follows the chart: {rowWords(1, rowWidth)} rows on 1m, wider on 5m, 15m, 1h and up. Rows merge further when the chart is zoomed out, so every row stays readable.
              </small>
            </div>
            <label className="indicator-settings-field">
              <span>Longest bar reaches {Math.round(settings.widthShare * 100)}% of the chart</span>
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
              <span>Show the net on each bar</span>
            </label>
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-field">
              <span>Buyers color</span>
              <input type="color" value={settings.buyColor} onChange={(event) => update({ buyColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Sellers color</span>
              <input type="color" value={settings.sellColor} onChange={(event) => update({ sellColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Last trade marker color</span>
              <input type="color" value={settings.markerColor} onChange={(event) => update({ markerColor: event.target.value })} />
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
