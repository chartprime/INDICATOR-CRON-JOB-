import type { LineStyleKind } from "../../chart/draw/line";
import type { SessionDeltaProfileSettings } from "./sessionDeltaProfileSettings";

interface SessionDeltaPocSettingsFieldProps {
  settings: SessionDeltaProfileSettings;
  onChange: (next: SessionDeltaProfileSettings) => void;
}

const LINE_STYLES: readonly { value: LineStyleKind; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

export function SessionDeltaPocSettingsField({
  settings,
  onChange,
}: SessionDeltaPocSettingsFieldProps) {
  return (
    <div className="session-delta-poc-settings">
      {(["buy", "sell"] as const).map((side) => {
        const isBuy = side === "buy";
        const visibleKey = isBuy ? "showBuyPoc" : "showSellPoc";
        const colorKey = isBuy ? "buyPocColor" : "sellPocColor";
        const styleKey = isBuy ? "buyPocStyle" : "sellPocStyle";
        const label = isBuy ? "Buy POC" : "Sell POC";

        return (
          <div className="session-delta-poc-settings-row" key={side}>
            <label className="indicator-settings-checkbox">
              <input
                type="checkbox"
                checked={settings[visibleKey]}
                onChange={(event) =>
                  onChange({ ...settings, [visibleKey]: event.target.checked })
                }
              />
              <span>{label}</span>
            </label>
            {settings[visibleKey] && (
              <>
                <input
                  className="session-delta-poc-color"
                  aria-label={`${label} color`}
                  type="color"
                  value={settings[colorKey]}
                  onChange={(event) =>
                    onChange({ ...settings, [colorKey]: event.target.value })
                  }
                />
                <select
                  aria-label={`${label} style`}
                  value={settings[styleKey]}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      [styleKey]: event.target.value as LineStyleKind,
                    })
                  }
                >
                  {LINE_STYLES.map((style) => (
                    <option key={style.value} value={style.value}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
