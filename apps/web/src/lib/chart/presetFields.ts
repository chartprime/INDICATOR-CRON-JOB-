import type { Preset, PresetParams } from "./indicatorPresets";
import type { SettingsFieldSchema } from "./indicatorTypes";
import { persistableFields, restoreFields } from "./historicalIndicatorPreferences";

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

export function presetKeysOf(schema: readonly SettingsFieldSchema<any>[]): string[] {
  const keys: string[] = [];
  for (const field of schema) {
    if (field.kind === "staticHint" || field.key === undefined) continue;
    keys.push(field.key as string);
  }
  return keys;
}

function inOptionOrder(schema: readonly SettingsFieldSchema<any>[], values: PresetParams): PresetParams {
  for (const field of schema) {
    if (field.kind !== "checkboxList") continue;
    const chosen = values[field.key as string];
    if (!Array.isArray(chosen)) continue;
    values[field.key as string] = field.options.map((option) => option.value).filter((value) => chosen.some((item) => Object.is(item, value)));
  }
  return values;
}

export function byInstrumentKeysOf(schema: readonly SettingsFieldSchema<any>[]): string[] {
  const keys: string[] = [];
  for (const field of schema) {
    if (field.kind === "custom" && field.byInstrument === true && field.key !== undefined) keys.push(field.key as string);
  }
  return keys;
}

function entries(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function instrumentEntryOf(value: unknown, instrumentKey: string): Record<string, unknown> {
  const map = entries(value);
  return Object.hasOwn(map, instrumentKey) ? { [instrumentKey]: map[instrumentKey] } : {};
}

export function withInstrumentEntry(current: unknown, fromPreset: unknown, instrumentKey: string): Record<string, unknown> {
  const next = { ...entries(current) };
  delete next[instrumentKey];
  return { ...next, ...instrumentEntryOf(fromPreset, instrumentKey) };
}

export function presetParamsOf(schema: readonly SettingsFieldSchema<any>[], params: PresetParams, defaults: PresetParams): PresetParams {
  return inOptionOrder(schema, persistableFields(schema, params, defaults));
}

export function appliedPreset(
  schema: readonly SettingsFieldSchema<any>[],
  preset: Preset,
  current: PresetParams,
  defaults: PresetParams,
): PresetParams {
  const restored = restoreFields(schema, preset.params, defaults);
  const applied: PresetParams = { ...current };
  for (const key of presetKeysOf(schema)) applied[key] = restored[key];
  return applied;
}

export function activePreset(
  presets: readonly Preset[],
  schema: readonly SettingsFieldSchema<any>[],
  params: PresetParams,
  defaults: PresetParams,
): Preset | undefined {
  const normalized = (candidate: PresetParams) => presetParamsOf(schema, restoreFields(schema, candidate, defaults), defaults);
  const current = normalized(presetParamsOf(schema, params, defaults));
  return presets.find((preset) => sameValue(normalized(preset.params), current));
}
