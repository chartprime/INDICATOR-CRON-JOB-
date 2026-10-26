import { describe, expect, it } from "vitest";
import type { FrameIdentity } from "../../../types/frames";
import type { RuntimeIndicatorDef, SettingsFieldSchema } from "../indicatorTypes";
import { settingsSchemaFor } from "../settingsSchemaFor";

interface Settings {
  floor: number;
  shown: boolean;
}

const SCHEMA: readonly SettingsFieldSchema<Settings>[] = [
  { key: "floor", label: "Floor (0 = default)", kind: "numeric", min: 0, max: 100, step: 1, affects: "recompute" },
  { kind: "staticHint", text: "A hint." },
  { key: "shown", label: "Shown", kind: "boolean", affects: "cosmetic" },
];

function def(settingsFieldsFor?: RuntimeIndicatorDef<unknown, Settings>["settingsFieldsFor"]): RuntimeIndicatorDef<unknown, Settings> {
  return {
    kind: "runtime",
    id: "bound",
    label: "Bound",
    category: "technical",
    createState: () => ({}),
    onBar: () => {},
    readOutput: () => ({}),
    lines: [],
    defaultSettings: { floor: 0, shown: true },
    settingsSchema: SCHEMA,
    placement: { kind: "overlay" },
    settingsFieldsFor,
  };
}

const eth: { symbol: string } & FrameIdentity = { provider: "BINANCE", symbol: "ETH-USDT", marketKind: "PERPETUAL" };

describe("settingsSchemaFor", () => {
  it("hands back the definition's own schema, the same array, when it binds no field to the instrument", () => {
    expect(settingsSchemaFor(def(), eth)).toBe(SCHEMA);
    expect(settingsSchemaFor(def(() => ({})), eth)).toBe(SCHEMA);
  });

  it("puts the instrument-bound field in place of the static one with that key, leaving the rest and the hint as they are", () => {
    const bound: SettingsFieldSchema<Settings> = { key: "floor", label: `Floor in ${eth.symbol.split("-")[0]}`, kind: "numeric", min: 1, max: 9999, step: 1, affects: "recompute" };
    const schema = settingsSchemaFor(def(() => ({ floor: bound })), eth);
    expect(schema).not.toBe(SCHEMA);
    expect(schema).toHaveLength(3);
    expect(schema[0]).toBe(bound);
    expect(schema[1]).toBe(SCHEMA[1]);
    expect(schema[2]).toBe(SCHEMA[2]);
  });

  it("matches a custom field by its key too, and leaves one that names no key alone", () => {
    const custom: SettingsFieldSchema<Settings> = { kind: "custom", key: "floor", affects: "recompute", render: () => null };
    const unkeyed: SettingsFieldSchema<Settings> = { kind: "custom", affects: "recompute", render: () => null };
    const withCustom = { ...def(() => ({ floor: unkeyed })), settingsSchema: [custom, SCHEMA[2]] };
    const schema = settingsSchemaFor(withCustom, eth);
    expect(schema[0]).toBe(unkeyed);
    expect(schema[1]).toBe(SCHEMA[2]);
    expect(settingsSchemaFor({ ...def(() => ({ floor: custom })), settingsSchema: [unkeyed] }, eth)[0]).toBe(unkeyed);
  });

  it("gives an empty schema for a definition with none", () => {
    expect(settingsSchemaFor({ ...def(), settingsSchema: undefined }, eth)).toEqual([]);
  });
});
