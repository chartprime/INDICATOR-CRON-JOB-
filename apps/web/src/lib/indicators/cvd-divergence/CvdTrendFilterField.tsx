import { MAX_CVD_SMA_LENGTH, MIN_CVD_SMA_LENGTH } from "./cvdDivergence";

/**
 * One trend filter's toggle, its average length and its Inverse switch, on ONE
 * row.
 *
 * The schema's plain `boolean` and `slider` kinds each render as their own
 * full-width labelled row, which would put the switch and the length it
 * governs two rows apart, and the Inverse switch a third row away from both.
 * They are one decision -- "filter by trend, using this average, read this
 * way" -- so they belong side by side, which the schema's `custom` escape
 * hatch is for (the same reason Delta Divergence's swing length is custom: it
 * needs a layout the generic kinds cannot express).
 *
 * The length is a slider, matching the indicator's other integer inputs, and
 * carries its own readout because the row has no room for the schema slider's
 * separate label. It is disabled, not hidden, while the toggle is off: hiding
 * it would reflow the row and make the setting look like it had disappeared
 * rather than switched off, and the disabled track still shows where the
 * length sits. The Inverse switch stays live at all times -- it is only READ
 * while the filter is enabled, but disabling it would make the
 * setting unreachable exactly when someone wants to prepare it.
 *
 * Deliberately prop-driven rather than taking a whole settings object, so the
 * SAME component serves the oscillator's filter and the cumulative series' --
 * each with its own toggle, its own average length and its own direction.
 */
export function CvdTrendFilterField({
  label,
  enabled,
  smaLength,
  inverted,
  onEnabledChange,
  onSmaLengthChange,
  onInvertedChange,
}: {
  label: string;
  enabled: boolean;
  smaLength: number;
  inverted: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onSmaLengthChange: (length: number) => void;
  onInvertedChange: (inverted: boolean) => void;
}) {
  return (
    <div className="indicator-settings-inline-row">
      <label className="indicator-settings-checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      <label className="indicator-settings-inline-slider">
        <input
          type="range"
          aria-label={`${label} SMA length`}
          min={MIN_CVD_SMA_LENGTH}
          max={MAX_CVD_SMA_LENGTH}
          step={1}
          disabled={!enabled}
          value={smaLength}
          onChange={(event) => onSmaLengthChange(Number(event.target.value))}
        />
        <span className="indicator-settings-inline-slider-value">
          {smaLength}
        </span>
      </label>
      <label className="indicator-settings-checkbox indicator-settings-inverse">
        <input
          type="checkbox"
          aria-label={`${label} inverse`}
          checked={inverted}
          onChange={(event) => onInvertedChange(event.target.checked)}
        />
        <span>Inverse</span>
      </label>
    </div>
  );
}
