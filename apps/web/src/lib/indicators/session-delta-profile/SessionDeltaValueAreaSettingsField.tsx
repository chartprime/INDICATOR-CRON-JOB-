import type { SessionDeltaProfileSettings } from "./sessionDeltaProfileSettings";

interface SessionDeltaValueAreaSettingsFieldProps {
  settings: SessionDeltaProfileSettings;
  onChange: (next: SessionDeltaProfileSettings) => void;
}

export function SessionDeltaValueAreaSettingsField({
  settings,
  onChange,
}: SessionDeltaValueAreaSettingsFieldProps) {
  return (
    <div className="session-delta-value-area-settings-row">
      <label className="indicator-settings-checkbox">
        <input
          type="checkbox"
          checked={settings.showValueAreaLines}
          onChange={(event) =>
            onChange({
              ...settings,
              showValueAreaLines: event.target.checked,
            })
          }
        />
        <span>VAH / VAL levels</span>
      </label>
      {settings.showValueAreaLines && (
        <input
          aria-label="VAH / VAL color"
          type="color"
          value={settings.vahValColor}
          onChange={(event) =>
            onChange({ ...settings, vahValColor: event.target.value })
          }
        />
      )}
    </div>
  );
}
