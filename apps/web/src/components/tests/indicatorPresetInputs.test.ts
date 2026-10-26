import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INDICATOR_REGISTRY, RUNTIME_INDICATOR_DEFS } from "../../lib/chart/indicatorRegistry";
import type { SettingsFieldSchema } from "../../lib/chart/indicatorTypes";
import { AGGRESSIVE_ORDERS_SETTINGS_SCHEMA, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS } from "../../lib/indicators/aggressive-orders/aggressiveOrdersSettings";
import { ABSORPTION_SETTINGS_SCHEMA, DEFAULT_ABSORPTION_SETTINGS } from "../../lib/indicators/absorption-detector/absorptionSettings";
import { DEFAULT_LIVE_DELTA_PROFILE_SETTINGS, LIVE_DELTA_PROFILE_SETTINGS_SCHEMA } from "../../lib/indicators/live-delta-profile/liveDeltaProfileSettings";
import { DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, LIVE_ORDER_BOOK_PROFILE_SETTINGS_SCHEMA } from "../../lib/indicators/live-order-book-profile/liveOrderBookProfileSettings";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, AGGRESSIVE_PROFILE_SETTINGS_SCHEMA } from "../../lib/indicators/aggressive-orders-profile/aggressiveProfileSettings";
import { DEFAULT_LIQUIDITY_SETTINGS, liquiditySettingsSchemaFor } from "../../lib/indicators/passive-liquidity/liquiditySettings";
import { DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS, L2_SUPPORT_RESISTANCE_SETTINGS_SCHEMA } from "../../lib/indicators/l2-support-resistance/l2SupportResistancePrimitive";
import { DEFAULT_L2_BOOK_MAP_SETTINGS, L2_BOOK_MAP_SETTINGS_SCHEMA } from "../../lib/indicators/l2-book-map/l2BookMapPrimitive";
import { DEFAULT_WHALE_SETTINGS, WHALE_SETTINGS_SCHEMA } from "../../lib/indicators/whale-limit-order-heatmap/whaleSettings";
import { PIVOT_SUPPORT_RESISTANCE_PRESET_SCHEMA } from "../../lib/indicators/pivot-support-resistance/pivotSupportResistancePresets";
import { DEFAULT_PIVOT_SUPPORT_RESISTANCE_SETTINGS } from "../../lib/indicators/pivot-support-resistance/pivotSupportResistance";
import { VOLUME_DELTA_PROFILE_OHLC_PERSISTENCE_SCHEMA } from "../../lib/indicators/volume-delta-profile-ohlc/volumeDeltaProfileOhlc";
import { DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS } from "../../lib/indicators/volume-delta-profile-ohlc/volumeDeltaProfileOhlcSettings";
import { VOLUME_DELTA_PROFILE_TICK_PERSISTENCE_SCHEMA } from "../../lib/indicators/volume-delta-profile-tick/volumeDeltaProfileTick";
import { DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS } from "../../lib/indicators/volume-delta-profile-tick/volumeDeltaProfileTickSettings";
import { VPIN_CLOUD_PRESET_SCHEMA } from "../../lib/indicators/vpin-cloud/vpinCloudPresets";
import { KILLZONES_PRESET_SCHEMA } from "../../lib/indicators/killzones/killzonesPresets";
import { whaleDetectorPresetSchema } from "../../lib/indicators/whale-detector/whaleDetectorPresets";
import { LIQUIDITY_LANE_PRESET_FIELD } from "../../lib/indicators/passive-liquidity/liquidityLanes";
import { DEFAULT_ICEBERG_SETTINGS, ICEBERG_SETTINGS_SCHEMA } from "../../lib/indicators/iceberg-detector/icebergSettings";
import { DEFAULT_EXHAUSTION_SETTINGS, EXHAUSTION_SETTINGS_SCHEMA } from "../../lib/indicators/exhaustion/exhaustionSettings";
import { DEFAULT_INITIATIVE_SETTINGS, INITIATIVE_SETTINGS_SCHEMA } from "../../lib/indicators/initiative/initiativeSettings";
import { DEFAULT_LIVE_RANGE_SETTINGS, LIVE_RANGE_SETTINGS_SCHEMA } from "../../lib/indicators/live-range-control/liveRangeSettings";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "indicatorPresetInputs.json");

const BESPOKE: Record<string, readonly SettingsFieldSchema<any>[]> = {
  aggressiveOrders: AGGRESSIVE_ORDERS_SETTINGS_SCHEMA,
  absorptionDetector: ABSORPTION_SETTINGS_SCHEMA,
  icebergDetector: ICEBERG_SETTINGS_SCHEMA,
  exhaustion: EXHAUSTION_SETTINGS_SCHEMA,
  initiative: INITIATIVE_SETTINGS_SCHEMA,
  liveRangeControl: LIVE_RANGE_SETTINGS_SCHEMA,
  liveDeltaProfile: LIVE_DELTA_PROFILE_SETTINGS_SCHEMA,
  liveOrderBookProfile: LIVE_ORDER_BOOK_PROFILE_SETTINGS_SCHEMA,
  aggressiveOrdersProfile: AGGRESSIVE_PROFILE_SETTINGS_SCHEMA,
  passiveLiquidity: [...liquiditySettingsSchemaFor(DEFAULT_LIQUIDITY_SETTINGS), LIQUIDITY_LANE_PRESET_FIELD],
  l2SupportResistance: L2_SUPPORT_RESISTANCE_SETTINGS_SCHEMA,
  l2BookMap: L2_BOOK_MAP_SETTINGS_SCHEMA,
  whaleLimitOrderHeatmap: WHALE_SETTINGS_SCHEMA,
  pivotSupportResistance: PIVOT_SUPPORT_RESISTANCE_PRESET_SCHEMA,
  volumeDeltaProfileOhlc: VOLUME_DELTA_PROFILE_OHLC_PERSISTENCE_SCHEMA,
  volumeDeltaProfileTick: VOLUME_DELTA_PROFILE_TICK_PERSISTENCE_SCHEMA,
  vpinCloud: VPIN_CLOUD_PRESET_SCHEMA,
  killzones: KILLZONES_PRESET_SCHEMA,
  "largeTradeDetector@USD": whaleDetectorPresetSchema("USD"),
  "largeTradeDetector@CONTRACTS": whaleDetectorPresetSchema("CONTRACTS"),
  "largeTradeDetector@historical:USD": whaleDetectorPresetSchema("USD", true),
  "largeTradeDetector@historical:CONTRACTS": whaleDetectorPresetSchema("CONTRACTS", true),
};

const SETTINGS_OF: Record<string, object> = {
  aggressiveOrders: DEFAULT_AGGRESSIVE_ORDERS_SETTINGS,
  absorptionDetector: DEFAULT_ABSORPTION_SETTINGS,
  icebergDetector: DEFAULT_ICEBERG_SETTINGS,
  exhaustion: DEFAULT_EXHAUSTION_SETTINGS,
  initiative: DEFAULT_INITIATIVE_SETTINGS,
  liveRangeControl: DEFAULT_LIVE_RANGE_SETTINGS,
  liveDeltaProfile: DEFAULT_LIVE_DELTA_PROFILE_SETTINGS,
  liveOrderBookProfile: DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS,
  aggressiveOrdersProfile: DEFAULT_AGGRESSIVE_PROFILE_SETTINGS,
  passiveLiquidity: DEFAULT_LIQUIDITY_SETTINGS,
  l2SupportResistance: DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS,
  l2BookMap: DEFAULT_L2_BOOK_MAP_SETTINGS,
  whaleLimitOrderHeatmap: DEFAULT_WHALE_SETTINGS,
  pivotSupportResistance: DEFAULT_PIVOT_SUPPORT_RESISTANCE_SETTINGS,
  volumeDeltaProfileOhlc: DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS,
  volumeDeltaProfileTick: DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
};

const NOT_IN_PRESETS: Record<string, readonly string[]> = {
  icebergDetector: ["revision"],
  volumeDeltaProfileOhlc: ["borderColor"],
};

const NOT_IN_SDK_PRESETS: Record<string, readonly string[]> = {
  institutionalOrderBlocks: ["wallSize", "hitSize"],
  liquidityVoids: ["source"],
  pivotSupportResistance: ["supportColor", "resistanceColor", "lineStyle"],
  volumeDeltaProfileOhlc: ["borderColor"],
};

const NO_SETTINGS_DIALOG: Record<string, string> = {
  rsi: "no settings dialog: its legend row has no settings button",
  ema: "no settings dialog: its legend row has no settings button",
  bollinger: "no settings dialog: its legend row has no settings button",
  l2FeedStatus: "no settings dialog: its legend row has no settings button",
};

const HAND_BUILT = new Set(["pivotSupportResistance", "volumeDeltaProfileOhlc", "volumeDeltaProfileTick"]);

function describeField(field: SettingsFieldSchema<any>): Record<string, unknown> | null {
  if (field.kind === "staticHint" || field.key === undefined) return null;
  const entry: Record<string, unknown> = { key: field.key, kind: field.kind };
  if (field.kind === "numeric" || field.kind === "slider") {
    entry.min = field.min;
    entry.max = field.max;
    entry.step = field.step;
    if (field.clampOnRestore === true) entry.clamp = true;
  }
  if (field.kind === "select" || field.kind === "radioGroup" || field.kind === "checkboxList") entry.options = field.options.map((option) => option.value);
  if (field.kind === "custom" && field.byInstrument === true) entry.byInstrument = true;
  return entry;
}

function inputsOf(schema: readonly SettingsFieldSchema<any>[]): Record<string, unknown>[] {
  return schema.map(describeField).filter((entry): entry is Record<string, unknown> => entry !== null);
}

function currentInputs(): Record<string, Record<string, unknown>[]> {
  const table: Record<string, Record<string, unknown>[]> = {};
  for (const def of RUNTIME_INDICATOR_DEFS) {
    if (HAND_BUILT.has(def.id) || def.settingsSchema === undefined || def.settingsSchema.length === 0) continue;
    table[def.id] = inputsOf(def.settingsSchema);
  }
  for (const [key, schema] of Object.entries(BESPOKE)) table[key] = inputsOf(schema);
  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
}

describe("the inputs every indicator's presets are read through", () => {
  it("are pinned: a renamed key, a new range or a changed type must be a deliberate change (UPDATE_PRESET_INPUTS=1 rewrites the fixture)", () => {
    const current = currentInputs();
    if (process.env.UPDATE_PRESET_INPUTS === "1") writeFileSync(FIXTURE, `${JSON.stringify(current, null, 2)}\n`);
    const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, Record<string, unknown>[]>;
    expect(current).toEqual(pinned);
  });

  it("every numeric input has a finite range, and every list input at least one choice", () => {
    for (const [indicator, inputs] of Object.entries(currentInputs())) {
      for (const input of inputs) {
        if (input.kind === "numeric" || input.kind === "slider") {
          expect(Number.isFinite(input.min), `${indicator}.${String(input.key)} min`).toBe(true);
          expect(Number.isFinite(input.max), `${indicator}.${String(input.key)} max`).toBe(true);
          expect((input.min as number) <= (input.max as number), `${indicator}.${String(input.key)} range`).toBe(true);
          expect((input.step as number) >= 0, `${indicator}.${String(input.key)} step`).toBe(true);
        }
        if (Array.isArray(input.options)) expect(input.options.length, `${indicator}.${String(input.key)} options`).toBeGreaterThan(0);
      }
    }
  });

  it("cover every setting a hand-built window keeps, apart from the named exceptions, so a preset holds the whole window", () => {
    for (const [indicator, settings] of Object.entries(SETTINGS_OF)) {
      const inputs = new Set(BESPOKE[indicator].map((field) => (field.kind === "staticHint" ? undefined : field.key)).filter((key) => key !== undefined));
      const excluded = NOT_IN_PRESETS[indicator] ?? [];
      const missing = Object.keys(settings).filter((key) => !inputs.has(key) && !excluded.includes(key));
      expect(missing, `${indicator} keeps settings its presets do not hold`).toEqual([]);
      for (const key of excluded) expect(inputs.has(key), `${indicator}.${key} is excluded and an input at once`).toBe(false);
    }
  });

  it("reach every indicator in the registry: its own SDK schema, or a hand-built dialog's schema listed here, unless it has no settings dialog at all, so a new dialog without presets fails here", () => {
    const handBuilt = new Set(Object.keys(BESPOKE).map((key) => key.split("@")[0]));
    const withPresets = (def: (typeof INDICATOR_REGISTRY)[number]) => {
      const schema = def.kind === "runtime" ? def.settingsSchema : undefined;
      return handBuilt.has(def.id) || (!HAND_BUILT.has(def.id) && schema !== undefined && schema.length > 0);
    };
    const without = INDICATOR_REGISTRY.filter((def) => !withPresets(def) && !(def.id in NO_SETTINGS_DIALOG)).map((def) => def.id);
    expect(without, "indicators whose settings have no presets").toEqual([]);
    for (const id of Object.keys(NO_SETTINGS_DIALOG)) {
      const def = INDICATOR_REGISTRY.find((candidate) => candidate.id === id);
      expect(def, `${id} is listed as having no settings dialog but is not in the registry`).toBeDefined();
      expect(withPresets(def!), `${id} is listed as having no settings dialog but has presets`).toBe(false);
    }
    for (const key of handBuilt) expect(INDICATOR_REGISTRY.some((def) => def.id === key), `${key} is listed as hand-built but is not in the registry`).toBe(true);
  });

  it("cover every setting an SDK indicator keeps, apart from the named exceptions, so a preset holds the whole dialog", () => {
    for (const def of RUNTIME_INDICATOR_DEFS) {
      const schema = def.persistenceSchema ?? def.settingsSchema;
      if (schema === undefined || schema.length === 0 || def.defaultSettings === null || typeof def.defaultSettings !== "object") continue;
      const inputs = new Set<unknown>(schema.map((field) => (field.kind === "staticHint" ? undefined : field.key)).filter((key) => key !== undefined));
      const excluded = NOT_IN_SDK_PRESETS[def.id] ?? [];
      const missing = Object.keys(def.defaultSettings as object).filter((key) => !inputs.has(key) && !excluded.includes(key));
      expect(missing, `${def.id} keeps settings its presets do not hold`).toEqual([]);
      for (const key of excluded) expect(inputs.has(key), `${def.id}.${key} is excluded and an input at once`).toBe(false);
    }
  });
});
