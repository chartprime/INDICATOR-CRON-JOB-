import type { FrameIdentity } from "../../types/frames";
import type { RuntimeIndicatorDef, SettingsFieldSchema } from "./indicatorTypes";

export function settingsSchemaFor<S, T>(def: RuntimeIndicatorDef<S, T>, identity: { symbol: string } & FrameIdentity): readonly SettingsFieldSchema<T>[] {
  const schema = def.settingsSchema ?? [];
  const bound = def.settingsFieldsFor?.(identity);
  if (bound === undefined || Object.keys(bound).length === 0) return schema;
  return schema.map((field) => {
    if (field.kind === "staticHint" || field.key === undefined) return field;
    return bound[field.key] ?? field;
  });
}
