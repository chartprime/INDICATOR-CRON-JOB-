import { useState } from "react";
import type { SettingsFieldSchema } from "../lib/chart/indicatorTypes";

type SettingsTab = "inputs" | "visibility";

interface GenericIndicatorSettingsBodyProps<T> {
  schema: readonly SettingsFieldSchema<T>[];
  settings: T;
  onChange: (next: T) => void;
  /** Optional indicator-level visibility, kept outside the indicator's
   * settings object because visibility is chart UI state rather than an
   * input to the indicator calculation. */
  visibility?: {
    value: boolean;
    onChange: (visible: boolean) => void;
    label?: string;
  };
}

interface NumericFieldProps<T> {
  field: Extract<SettingsFieldSchema<T>, { kind: "numeric" }>;
  value: number;
  onCommit: (value: number) => void;
}

function isValidNumeric(raw: string, min: number, max: number, step: number): boolean {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < min || value > max || !Number.isFinite(step) || step <= 0) {
    return false;
  }
  const stepsFromMin = (value - min) / step;
  return Math.abs(stepsFromMin - Math.round(stepsFromMin)) < 1e-9;
}

/** Whole-number sliders read as integers -- "21", not "21.00". */
function sliderText(value: number, step: number): string {
  return Number.isInteger(step) && Number.isInteger(value)
    ? String(value)
    : value.toFixed(2);
}

function NumericField<T>({ field, value, onCommit }: NumericFieldProps<T>) {
  const [buffer, setBuffer] = useState(String(value));
  return (
    <label className="indicator-settings-field">
      <span>{field.label}</span>
      <input
        type="number"
        min={field.min}
        max={field.max}
        step={field.step}
        value={buffer}
        onChange={(event) => {
          const raw = event.target.value;
          setBuffer(raw);
          if (isValidNumeric(raw, field.min, field.max, field.step)) onCommit(Number(raw));
        }}
      />
    </label>
  );
}

/** Advanced fields are inputs shown under a collapsed group, so they belong to the Inputs tab. */
function fieldTab<T>(field: SettingsFieldSchema<T>): SettingsTab {
  return field.tab === "visibility" ? "visibility" : "inputs";
}

function isAdvanced<T>(field: SettingsFieldSchema<T>): boolean {
  return field.tab === "advanced";
}

export function GenericIndicatorSettingsBody<T>({ schema, settings, onChange, visibility }: GenericIndicatorSettingsBodyProps<T>) {
  const usesTabs = schema.some((field) => field.tab !== undefined && !isAdvanced(field));
  const [activeTab, setActiveTab] = useState<SettingsTab>("inputs");

  const visibleFields = schema.filter((field) => (field.visibleIf ? field.visibleIf(settings) : true));
  const tabFields = usesTabs ? visibleFields.filter((field) => fieldTab(field) === activeTab) : visibleFields;
  const fieldsToRender = tabFields.filter((field) => !isAdvanced(field));
  const advancedFields = tabFields.filter(isAdvanced);

  function setKey(key: keyof T, value: unknown) {
    onChange({ ...settings, [key]: value } as T);
  }

  function renderField(field: SettingsFieldSchema<T>, index: number) {
    switch (field.kind) {
      case "boolean":
        return (
          <label key={index} className="indicator-settings-checkbox">
            <input
              type="checkbox"
              checked={Boolean(settings[field.key])}
              onChange={(event) => setKey(field.key, event.target.checked)}
            />
            <span>{field.label}</span>
          </label>
        );
      case "checkboxList": {
        const selected = settings[field.key] as ReadonlySet<unknown>;
        return (
          <fieldset key={index} className="indicator-settings-session-list">
            <legend>{field.label}</legend>
            {field.options.map((option) => (
              <label key={String(option.value)} className="indicator-settings-checkbox">
                <input
                  type="checkbox"
                  checked={selected.has(option.value)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(option.value);
                    else next.delete(option.value);
                    setKey(field.key, next);
                  }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
        );
      }
      case "radioGroup":
        return (
          <div key={index} className="indicator-settings-field">
            <span>{field.label}</span>
            {field.options.map((option) => (
              <label key={String(option.value)} className="indicator-settings-radio">
                <input
                  type="radio"
                  name={String(field.key)}
                  checked={settings[field.key] === option.value}
                  onChange={() => setKey(field.key, option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        );
      case "select":
        return (
          <label key={String(field.key)} className="indicator-settings-field">
            <span>{field.label}</span>
            <select
              value={String(settings[field.key])}
              onChange={(event) => {
                const matched = field.options.find(
                  (option) => String(option.value) === event.target.value,
                );
                setKey(field.key, matched ? matched.value : event.target.value);
              }}
            >
              {field.options.map((option) => (
                <option key={String(option.value)} value={String(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        );
      case "numeric":
        return (
          <NumericField
            key={String(field.key)}
            field={field}
            value={settings[field.key] as number}
            onCommit={(value) => setKey(field.key, value)}
          />
        );
      case "color":
        return (
          <label key={String(field.key)} className="indicator-settings-field">
            <span>{field.label}</span>
            <input
              type="color"
              value={String(settings[field.key] ?? "#000000")}
              onChange={(event) => setKey(field.key, event.target.value)}
            />
          </label>
        );
      case "slider": {
        const raw = settings[field.key];
        const sliderValue =
          typeof raw === "number" && Number.isFinite(raw) ? raw : field.min;
        return (
          <label key={String(field.key)} className="indicator-settings-field">
            <span>
              {field.label} {sliderText(sliderValue, field.step)}
            </span>
            <input
              type="range"
              min={field.min}
              max={field.max}
              step={field.step}
              value={sliderValue}
              onChange={(event) => setKey(field.key, Number(event.target.value))}
            />
          </label>
        );
      }
      case "staticHint":
        return (
          <p key={index} className="indicator-settings-hint">
            {field.text}
          </p>
        );
      case "custom":
        return <div key={index}>{field.render(settings, onChange)}</div>;
      default:
        return null;
    }
  }

  return (
    <>
      {usesTabs && (
        <div className="indicator-settings-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "inputs"}
            className="indicator-settings-tab"
            onClick={() => setActiveTab("inputs")}
          >
            Inputs
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "visibility"}
            className="indicator-settings-tab"
            onClick={() => setActiveTab("visibility")}
          >
            Visibility
          </button>
        </div>
      )}
      <div className="indicator-settings-body">
        {fieldsToRender.map((field, index) => renderField(field, index))}
        {advancedFields.length > 0 && (
          <details className="indicator-settings-advanced">
            <summary>Advanced</summary>
            {advancedFields.map((field, index) => renderField(field, fieldsToRender.length + index))}
          </details>
        )}
        {(!usesTabs || activeTab === "visibility") && visibility && (
          <label className="indicator-settings-checkbox">
            <input
              type="checkbox"
              checked={visibility.value}
              onChange={(event) => visibility.onChange(event.target.checked)}
            />
            <span>{visibility.label ?? "Show on chart"}</span>
          </label>
        )}
      </div>
    </>
  );
}
