import { IndicatorSettingsModal } from "./IndicatorSettingsModal";
import { GenericIndicatorSettingsBody } from "./GenericIndicatorSettingsBody";
import type { IndicatorPresetsProps } from "./IndicatorPresetsMenu";
import type { SettingsFieldSchema } from "../lib/chart/indicatorTypes";
import { presetKeyFor, type PresetParams } from "../lib/chart/indicatorPresets";
import { byInstrumentKeysOf, instrumentEntryOf, withInstrumentEntry } from "../lib/chart/presetFields";

interface GenericIndicatorSettingsModalProps<T> {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  schema: readonly SettingsFieldSchema<T>[];
  settings: T;
  onChange: (next: T) => void;
  /** When provided, renders a "Reset to default" footer button that calls
   * onChange with this value -- matches the reset affordance every prior
   * bespoke settings modal (Volume Profile, Delta Profile, ...) already had. */
  defaultSettings?: T;
  presetKey?: string;
  instrumentKey?: string;
  /** Optional chart visibility control for indicators whose established
   * settings UI owns this toggle. It intentionally remains outside T: it is
   * presentation state, not methodology/configuration state. */
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  defaultVisible?: boolean;
  notice?: string;
}

function settingsRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function GenericIndicatorSettingsModal<T>({
  isOpen,
  onClose,
  title,
  schema,
  settings,
  onChange,
  defaultSettings,
  presetKey,
  instrumentKey,
  visible,
  onVisibleChange,
  defaultVisible,
  notice,
}: GenericIndicatorSettingsModalProps<T>) {
  const hasVisibilityControl = visible !== undefined && onVisibleChange !== undefined;

  function handleReset() {
    if (defaultSettings !== undefined) onChange(defaultSettings);
    if (defaultVisible !== undefined && onVisibleChange !== undefined) onVisibleChange(defaultVisible);
  }

  function presetsFor(key: string, defaults: T): IndicatorPresetsProps | undefined {
    const mapKeys = byInstrumentKeysOf(schema);
    const presetSchema = instrumentKey === undefined ? schema.filter((field) => field.kind !== "custom" || field.byInstrument !== true) : schema;
    if (!presetSchema.some((field) => field.kind !== "staticHint" && field.key !== undefined)) return undefined;
    const current = settingsRecord(settings);
    const params: PresetParams = { ...current };
    const presetDefaults: PresetParams = { ...settingsRecord(defaults) };
    if (instrumentKey !== undefined) {
      for (const mapKey of mapKeys) {
        params[mapKey] = instrumentEntryOf(current[mapKey], instrumentKey);
        presetDefaults[mapKey] = {};
      }
    }
    return {
      presetKey: instrumentKey !== undefined && mapKeys.length > 0 ? presetKeyFor(key, instrumentKey) : key,
      params,
      schema: presetSchema,
      defaults: presetDefaults,
      onApply: (applied: PresetParams) => {
        const next: PresetParams = { ...current, ...applied };
        if (instrumentKey !== undefined) {
          for (const mapKey of mapKeys) next[mapKey] = withInstrumentEntry(current[mapKey], applied[mapKey], instrumentKey);
        }
        onChange(next as T);
      },
      onReset: handleReset,
    };
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      ariaLabel={`${title} settings`}
      footerStart={
        defaultSettings !== undefined ? (
          <button
            type="button"
            className="indicator-settings-reset"
            onClick={handleReset}
          >
            Reset to default
          </button>
        ) : undefined
      }
      presets={presetKey !== undefined && defaultSettings !== undefined ? presetsFor(presetKey, defaultSettings) : undefined}
    >
      <GenericIndicatorSettingsBody
        schema={schema}
        settings={settings}
        onChange={onChange}
        visibility={hasVisibilityControl ? { value: visible, onChange: onVisibleChange } : undefined}
      />
      {notice && <p className="indicator-settings-hint">{notice}</p>}
    </IndicatorSettingsModal>
  );
}
