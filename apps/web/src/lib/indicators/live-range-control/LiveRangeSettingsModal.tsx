import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import {
  CARD_SIZES,
  CRYPTO_PRINT_SCALE,
  ZONE_OPACITY_MAX,
  ZONE_OPACITY_MIN,
  DEFAULT_LIVE_RANGE_SETTINGS,
  LIVE_RANGE_MODES,
  LIVE_RANGE_SETTINGS_SCHEMA,
  ROW_SETTINGS,
  VERDICT_SENSITIVITIES,
  bigPrintOf,
  cardSizeOf,
  rangeModeOf,
  rowShownOf,
  tipsShownOf,
  verdictSensitivityOf,
  zoneOpacityOf,
  zoneShownOf,
  type LiveRangeSettings,
  type PrintScale,
} from "./liveRangeSettings";
import { WHOLE_WINDOW, WINDOW_TICK_MS, originOf, windowCut, windowFor, windowFromMinutes, windowToMinutes, type LiveRangeWindow } from "./liveRangeWindow";
import { amountText, windowLabel } from "./liveRangeWords";

type SettingsTab = "inputs" | "visibility";

interface LiveRangeSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: LiveRangeSettings;
  onSettingsChange: (settings: LiveRangeSettings) => void;
  defaults?: LiveRangeSettings;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  window?: LiveRangeWindow;
  onWindowChange?: (window: LiveRangeWindow) => void;
  scale?: PrintScale;
  unit?: string;
  presetScope?: string;
}

export function LiveRangeSettingsModal({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  defaults = DEFAULT_LIVE_RANGE_SETTINGS,
  visible,
  onVisibleChange,
  window = WHOLE_WINDOW,
  onWindowChange,
  scale = CRYPTO_PRINT_SCALE,
  unit = "",
  presetScope,
}: LiveRangeSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");
  const [tick, setTick] = useState(0);
  const [cut, setCut] = useState<number | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  const mode = rangeModeOf(settings);
  const size = cardSizeOf(settings);
  const opacity = zoneOpacityOf(settings);
  const sensitivity = verdictSensitivityOf(settings);

  useLayoutEffect(() => {
    if (isOpen) setActiveTab("inputs");
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || mode === "visible") return undefined;
    const timer = setInterval(() => setTick((tick) => tick + 1), WINDOW_TICK_MS);
    return () => clearInterval(timer);
  }, [isOpen, mode]);

  function update(patch: Partial<LiveRangeSettings>) {
    onSettingsChange({ ...latestSettingsRef.current, ...patch });
  }

  function handleReset() {
    onSettingsChange({ ...defaults });
    onVisibleChange(true);
  }

  function applyPreset(params: PresetParams) {
    onSettingsChange(params as unknown as LiveRangeSettings);
  }

  const bigPrint = bigPrintOf(settings, scale);
  const now = Date.now();
  const origin = originOf(now);
  const shown = windowFor(mode, window);
  const minutes = windowToMinutes(origin, shown, now);
  const fromShare = minutes.from / minutes.max;
  const toShare = minutes.to / minutes.max;
  const windowStyle = { "--from": String(fromShare), "--to": String(toShare), ...(cut === null ? {} : { "--cut": `${cut}px` }) } as CSSProperties;

  useLayoutEffect(() => {
    const box = windowRef.current;
    const next = box === null ? null : windowCut(box.getBoundingClientRect(), fromShare, toShare, globalThis.devicePixelRatio);
    setCut((current) => (current === next ? current : next));
  }, [isOpen, activeTab, mode, fromShare, toShare, tick]);

  function moveWindow(from: number, to: number) {
    onWindowChange?.(windowFromMinutes(origin, from, to, minutes.max));
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Live Range Control"
      ariaLabel="Live Range Control settings"
      footerStart={
        <button type="button" className="indicator-settings-reset" onClick={handleReset}>
          Reset to default
        </button>
      }
      presets={{
        presetKey: presetKeyFor("liveRangeControl", presetScope),
        params: { ...settings },
        schema: LIVE_RANGE_SETTINGS_SCHEMA,
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
              <span>Mode</span>
              <div className="live-range-modes">
                {LIVE_RANGE_MODES.map(([value, label]) => (
                  <label key={value} className="indicator-settings-radio">
                    <input type="radio" name="live-range-mode" aria-label={`Mode ${label}`} checked={mode === value} onChange={() => update({ rangeMode: value })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="indicator-settings-field">
              <span>{`Big print from ${amountText(bigPrint)}${unit === "" ? "" : ` ${unit}`}`}</span>
              <input
                type="range"
                aria-label="Big print from"
                min={scale.min}
                max={scale.max}
                step={scale.step}
                value={bigPrint}
                onChange={(event) => update({ bigPrint: bigPrintOf({ bigPrint: Number(event.target.value) }, scale) })}
              />
            </label>
            <div className="indicator-settings-field">
              <span>Verdict sensitivity</span>
              <div className="live-range-modes">
                {VERDICT_SENSITIVITIES.map(([value, label]) => (
                  <label key={value} className="indicator-settings-radio">
                    <input type="radio" name="live-range-verdict" aria-label={`Verdict sensitivity ${label}`} checked={sensitivity === value} onChange={() => update({ verdictSensitivity: value })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
            {mode !== "visible" && (
              <div className="indicator-settings-field live-range-window-field">
                <span>{`Window ${windowLabel(origin, shown, now)}`}</span>
                <div className="live-range-window" data-testid="live-range-window" ref={windowRef} style={windowStyle}>
                  <input
                    type="range"
                    className="live-range-window-start"
                    aria-label="Window start"
                    min={0}
                    max={minutes.max}
                    step={1}
                    value={minutes.max - minutes.from}
                    onChange={(event) => moveWindow(minutes.max - Number(event.target.value), minutes.to)}
                  />
                  {mode === "selected" && (
                    <input
                      type="range"
                      className="live-range-window-end"
                      aria-label="Window end"
                      min={0}
                      max={minutes.max}
                      step={1}
                      value={minutes.to}
                      onChange={(event) => moveWindow(minutes.from, Number(event.target.value))}
                    />
                  )}
                </div>
              </div>
            )}
          </>
        )}
        {activeTab === "visibility" && (
          <>
            <label className="indicator-settings-field">
              <span>Zone colour</span>
              <input type="color" aria-label="Zone colour" value={settings.zoneColor} onChange={(event) => update({ zoneColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>{`Zone opacity ${opacity} %`}</span>
              <input
                type="range"
                aria-label="Zone opacity"
                min={ZONE_OPACITY_MIN}
                max={ZONE_OPACITY_MAX}
                step={1}
                value={opacity}
                onChange={(event) => update({ zoneOpacity: zoneOpacityOf({ zoneOpacity: Number(event.target.value) }) })}
              />
            </label>
            <label className="indicator-settings-field">
              <span>Bid colour</span>
              <input type="color" aria-label="Bid colour" value={settings.bidColor} onChange={(event) => update({ bidColor: event.target.value })} />
            </label>
            <label className="indicator-settings-field">
              <span>Ask colour</span>
              <input type="color" aria-label="Ask colour" value={settings.askColor} onChange={(event) => update({ askColor: event.target.value })} />
            </label>
            <div className="indicator-settings-field">
              <span>Monitor size</span>
              <div className="live-range-modes">
                {CARD_SIZES.map(([value, label]) => (
                  <label key={value} className="indicator-settings-radio">
                    <input type="radio" name="live-range-size" aria-label={`Monitor size ${label}`} checked={size === value} onChange={() => update({ cardSize: value })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="indicator-settings-field">
              <span>Rows</span>
              <div className="live-range-modes">
                {ROW_SETTINGS.map(([row, key, label]) => (
                  <label key={row} className="indicator-settings-checkbox">
                    <input type="checkbox" aria-label={`Show ${label}`} checked={rowShownOf(settings, row)} onChange={(event) => update({ [key]: event.target.checked })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" aria-label="Show zone" checked={zoneShownOf(settings)} onChange={(event) => update({ showZone: event.target.checked })} />
              <span>Show zone</span>
            </label>
            <label className="indicator-settings-checkbox">
              <input type="checkbox" aria-label="Show hover tips" checked={tipsShownOf(settings)} onChange={(event) => update({ showTips: event.target.checked })} />
              <span>Show hover tips</span>
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
