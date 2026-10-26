import { instrumentKey } from "../../chart/drawingStore";
import { sizeUnitFor } from "../institutional-order-blocks-v2/institutionalV2Rules";
import { maxTradedFor, maxTradedSliderRange, type Identity, type LiquidityVoidsSettings } from "./liquidityVoidsRules";

export function MaxTradedSlider({ identity, settings, onChange }: { identity: Identity; settings: LiquidityVoidsSettings; onChange: (next: LiquidityVoidsSettings) => void }) {
  const key = instrumentKey(identity);
  const fallback = maxTradedFor(identity);
  const value = settings.maxTradedByInstrument[key] ?? fallback;
  const range = maxTradedSliderRange(fallback);
  return (
    <label className="indicator-settings-field">
      <span>
        Maximum Traded ({sizeUnitFor(identity)}) {value}
      </span>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={Math.min(range.max, Math.max(range.min, value))}
        onChange={(event) => onChange({ ...settings, maxTradedByInstrument: { ...settings.maxTradedByInstrument, [key]: Number(event.target.value) } })}
      />
    </label>
  );
}
