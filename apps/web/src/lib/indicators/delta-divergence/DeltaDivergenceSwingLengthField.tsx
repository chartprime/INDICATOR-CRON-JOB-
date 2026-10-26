import { useLayoutEffect, useState } from "react";
import { cvdAlignmentToleranceBars, DEFAULT_SWING_LENGTH, MAX_SWING_LENGTH, MIN_SWING_LENGTH } from "./deltaDivergence";
import type { DeltaDivergenceIndicatorSettings } from "./deltaDivergenceIndicator";

/**
 * The generic "numeric" field kind has no hint-text slot at all, and this
 * field's own explanatory paragraph embeds a value (toleranceBars) derived
 * live from the current swingLength -- a small, standalone component (the
 * schema's existing "custom" escape hatch) rather than adding a hint field
 * nothing else needs, reproducing the original bespoke modal's exact
 * string-buffer/dynamic-hint behavior.
 */
export function DeltaDivergenceSwingLengthField({
  settings,
  onChange,
}: {
  settings: DeltaDivergenceIndicatorSettings;
  onChange: (next: DeltaDivergenceIndicatorSettings) => void;
}) {
  const [buffer, setBuffer] = useState(String(settings.swingLength));

  // A reset or an externally applied settings change must replace a stale
  // edit buffer, but doing that transition during render risks an extra pass
  // under Strict Mode. Synchronize in layout phase instead.
  useLayoutEffect(() => {
    setBuffer(String(settings.swingLength));
  }, [settings.swingLength]);

  const toleranceBars = cvdAlignmentToleranceBars(settings.swingLength);

  return (
    <>
      <label className="indicator-settings-field">
        <span>Swing length (closed bars)</span>
        <input
          type="number"
          min={MIN_SWING_LENGTH}
          max={MAX_SWING_LENGTH}
          step={1}
          value={buffer}
          onChange={(event) => {
            const raw = event.target.value;
            setBuffer(raw);
            const value = Number(raw);
            const isValid = raw.trim() !== "" && Number.isInteger(value) && value >= MIN_SWING_LENGTH && value <= MAX_SWING_LENGTH;
            if (isValid) onChange({ ...settings, swingLength: value });
          }}
        />
        <span className="indicator-settings-hint">
          Controls how much completed price structure is needed on each side of a pivot. Lower reacts faster;
          higher finds fewer, broader swings. {DEFAULT_SWING_LENGTH} is the balanced default.
        </span>
      </label>
      <p className="indicator-settings-hint">
        Price uses confirmed candle closes, never wick extremes. CVD is checked within ±{toleranceBars} bar{toleranceBars === 1 ? "" : "s"}
        of each price pivot to allow normal flow timing differences. This alignment is derived from Swing length,
        so there is no separate sensitivity setting to manage.
      </p>
    </>
  );
}
