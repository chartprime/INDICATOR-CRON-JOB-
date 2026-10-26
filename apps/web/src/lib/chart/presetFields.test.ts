import { describe, expect, it } from "vitest";
import { activePreset, appliedPreset, byInstrumentKeysOf, instrumentEntryOf, presetParamsOf, withInstrumentEntry } from "./presetFields";
import type { SettingsFieldSchema } from "./indicatorTypes";

type Settings = { length: number; opacity: number; size: number; mode: string; sessions: ReadonlySet<string>; color: string; floors?: Record<string, number> };

const DEFAULTS = { length: 14, opacity: 0.5, size: 0, mode: "auto", sessions: new Set(["asia"]), color: "#fff" };

const SCHEMA: readonly SettingsFieldSchema<Settings>[] = [
  { kind: "numeric", key: "length", label: "Length", min: 1, max: 20, step: 1, affects: "recompute" },
  { kind: "slider", key: "opacity", label: "Opacity", min: 0.2, max: 1, step: 0, clampOnRestore: true, affects: "cosmetic" },
  { kind: "numeric", key: "size", label: "Size", min: 0, max: Number.MAX_SAFE_INTEGER, step: 0, affects: "recompute" },
  { kind: "select", key: "mode", label: "Mode", options: [{ value: "auto", label: "Auto" }, { value: "fixed", label: "Fixed" }], affects: "recompute" },
  { kind: "checkboxList", key: "sessions", label: "Sessions", options: [{ value: "asia", label: "Asia" }, { value: "london", label: "London" }], affects: "recompute" },
  { kind: "color", key: "color", label: "Colour", affects: "cosmetic" },
  { kind: "custom", key: "floors", render: () => null, isValidPersistedValue: (value) => typeof value === "object" && value !== null, affects: "recompute" },
];

const preset = (params: Record<string, unknown>) => ({ name: "p", params });

describe("applying a preset through the indicator's own inputs", () => {
  it("fills an input the preset lacks with its default and drops a key the indicator no longer has", () => {
    const applied = appliedPreset(SCHEMA, preset({ length: 9, retired: true }), DEFAULTS, DEFAULTS);
    expect(applied.length).toBe(9);
    expect(applied.opacity).toBe(0.5);
    expect(applied.mode).toBe("auto");
    expect(Object.hasOwn(applied, "retired")).toBe(false);
  });

  it("a number box that became a slider: a value outside the range falls back to the default, or to the nearest end when the field clamps", () => {
    expect(appliedPreset(SCHEMA, preset({ length: 120 }), DEFAULTS, DEFAULTS).length).toBe(14);
    expect(appliedPreset(SCHEMA, preset({ opacity: 9 }), DEFAULTS, DEFAULTS).opacity).toBe(1);
    expect(appliedPreset(SCHEMA, preset({ opacity: 0.01 }), DEFAULTS, DEFAULTS).opacity).toBe(0.2);
  });

  it("a slider with a grid keeps only values on the grid; step 0 takes any value within the range", () => {
    expect(appliedPreset(SCHEMA, preset({ length: 9.5 }), DEFAULTS, DEFAULTS).length).toBe(14);
    expect(appliedPreset(SCHEMA, preset({ opacity: 0.333 }), DEFAULTS, DEFAULTS).opacity).toBe(0.333);
    expect(appliedPreset(SCHEMA, preset({ size: 123.456 }), DEFAULTS, DEFAULTS).size).toBe(123.456);
    expect(appliedPreset(SCHEMA, preset({ size: -1 }), DEFAULTS, DEFAULTS).size).toBe(0);
  });

  it("a value of the wrong type, a choice the list no longer offers, or a custom value its validator refuses, becomes the default", () => {
    const applied = appliedPreset(SCHEMA, preset({ length: "9", mode: "random", sessions: "asia", color: 7, floors: "x" }), DEFAULTS, DEFAULTS);
    expect(applied.length).toBe(14);
    expect(applied.mode).toBe("auto");
    expect(applied.sessions).toEqual(new Set(["asia"]));
    expect(applied.color).toBe("#fff");
    expect(applied.floors).toBeUndefined();
  });

  it("a saved list comes back as a set, and goes back to storage as a list", () => {
    const applied = appliedPreset(SCHEMA, preset({ sessions: ["london", "unknown"] }), DEFAULTS, DEFAULTS);
    expect(applied.sessions).toEqual(new Set(["asia"]));
    const stored = presetParamsOf(SCHEMA, { ...DEFAULTS, sessions: new Set(["london"]) }, DEFAULTS);
    expect(stored.sessions).toEqual(["london"]);
    expect(stored.floors).toBeUndefined();
  });
});

describe("what applying a preset touches", () => {
  it("only the inputs the preset can hold: a setting outside them keeps its current value", () => {
    const current = { ...DEFAULTS, length: 7, runtimeOnly: "kept", borderColor: "#123456" };
    const applied = appliedPreset(SCHEMA, preset({ length: 9, runtimeOnly: "from preset", borderColor: "#000000" }), current, DEFAULTS);
    expect(applied.length).toBe(9);
    expect(applied.runtimeOnly).toBe("kept");
    expect(applied.borderColor).toBe("#123456");
  });

  it("an input the preset lacks goes to its default, not to the current value", () => {
    const current = { ...DEFAULTS, opacity: 0.9, length: 7 };
    const applied = appliedPreset(SCHEMA, preset({ length: 9 }), current, DEFAULTS);
    expect(applied.opacity).toBe(0.5);
  });
});

describe("the preset in use", () => {
  it("is the one whose inputs equal the current settings, extra keys and missing optional keys aside", () => {
    const presets = [
      { name: "Nine", params: { length: 9, opacity: 0.5, size: 0, mode: "auto", sessions: ["asia"], color: "#fff" } },
      { name: "London", params: { length: 9, opacity: 0.5, size: 0, mode: "auto", sessions: ["london"], color: "#fff" } },
      { name: "Old", params: { length: 12, retired: true } },
    ];
    expect(activePreset(presets, SCHEMA, { ...DEFAULTS, length: 9, runtimeOnly: 1 }, DEFAULTS)?.name).toBe("Nine");
    expect(activePreset(presets, SCHEMA, { ...DEFAULTS, length: 12 }, DEFAULTS)?.name).toBe("Old");
    expect(activePreset(presets, SCHEMA, { ...DEFAULTS, length: 13 }, DEFAULTS)).toBeUndefined();
    expect(activePreset(presets, SCHEMA, { ...DEFAULTS, length: 9, sessions: new Set(["london"]) }, DEFAULTS)?.name).toBe("London");
  });
});

describe("checkbox lists", () => {
  it("are saved in the list's own order, whatever order the boxes were ticked in", () => {
    expect(presetParamsOf(SCHEMA, { ...DEFAULTS, sessions: new Set(["london", "asia"]) }, DEFAULTS).sessions).toEqual(["asia", "london"]);
  });

  it("match a preset after a box is unticked and ticked again", () => {
    const presets = [{ name: "Both", params: { ...DEFAULTS, sessions: ["asia", "london"] } }];
    expect(activePreset(presets, SCHEMA, { ...DEFAULTS, sessions: new Set(["london", "asia"]) }, DEFAULTS)?.name).toBe("Both");
  });
});

describe("settings kept per instrument inside one settings object", () => {
  const MAPPED: readonly SettingsFieldSchema<{ minSize: Record<string, number> }>[] = [
    { kind: "custom", key: "minSize", render: () => null, isValidPersistedValue: (value) => typeof value === "object" && value !== null, byInstrument: true, affects: "recompute" },
    { kind: "custom", key: "minSize", render: () => null, affects: "recompute" },
  ];

  it("are the custom fields that say so", () => {
    expect(byInstrumentKeysOf(MAPPED)).toEqual(["minSize"]);
    expect(byInstrumentKeysOf(SCHEMA)).toEqual([]);
  });

  it("are read for the instrument on screen only", () => {
    expect(instrumentEntryOf({ NQ: 50, BTC: 200 }, "NQ")).toEqual({ NQ: 50 });
    expect(instrumentEntryOf({ BTC: 200 }, "NQ")).toEqual({});
    expect(instrumentEntryOf(undefined, "NQ")).toEqual({});
    expect(instrumentEntryOf([50], "0")).toEqual({});
  });

  it("are written for the instrument on screen only: another instrument keeps its value, and a preset without one clears this instrument's", () => {
    expect(withInstrumentEntry({ NQ: 70, BTC: 300 }, { NQ: 50, BTC: 1 }, "NQ")).toEqual({ NQ: 50, BTC: 300 });
    expect(withInstrumentEntry({ NQ: 70, BTC: 300 }, {}, "NQ")).toEqual({ BTC: 300 });
    expect(withInstrumentEntry(undefined, { NQ: 50 }, "NQ")).toEqual({ NQ: 50 });
  });
});
