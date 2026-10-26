import type { LineStyleKind } from "../../chart/draw/line";

const LINE_STYLES: readonly { value: LineStyleKind; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

interface ProfileVahValStyleFieldProps {
  style: LineStyleKind;
  onStyleChange: (style: LineStyleKind) => void;
}

/** The style of the value-area lines, shared by all three views of Session
 * Volume Profile (the volume view's VAH/VAL pair as well as the delta views'
 * derived levels). */
export function ProfileVahValStyleField({
  style,
  onStyleChange,
}: ProfileVahValStyleFieldProps) {
  return (
    <label className="indicator-settings-field">
      <span>Value area line style</span>
      <select
        aria-label="Value area line style"
        value={style}
        onChange={(event) => onStyleChange(event.target.value as LineStyleKind)}
      >
        {LINE_STYLES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
