import {
  DEFAULT_L2_BOOK_MAP_SETTINGS,
  normalizeL2BookMapSettings,
  type L2BookMapSettings,
} from "../indicators/l2-book-map/l2BookMapPrimitive";
import {
  DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS,
  normalizeL2SupportResistanceSettings,
  type L2SupportResistanceSettings,
} from "../indicators/l2-support-resistance/l2SupportResistancePrimitive";
import { DEFAULT_LIQUIDITY_SETTINGS, type LiquiditySettings } from "../indicators/passive-liquidity/liquiditySettings";
import { isLaneChoice, type LiquidityLaneChoice } from "../indicators/passive-liquidity/liquidityLanes";
import { DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, type AggressiveOrdersSettings } from "../indicators/aggressive-orders/aggressiveOrdersSettings";
import { DEFAULT_ABSORPTION_SETTINGS, absorptionHistoryDaysFromHours, type AbsorptionSettings } from "../indicators/absorption-detector/absorptionSettings";
import { DEFAULT_ICEBERG_SETTINGS, ICEBERG_MARK_SHAPES, ICEBERG_SETTINGS_REVISION, type IcebergSettings } from "../indicators/iceberg-detector/icebergSettings";
import { DEFAULT_EXHAUSTION_SETTINGS, type ExhaustionSettings } from "../indicators/exhaustion/exhaustionSettings";
import { DEFAULT_INITIATIVE_SETTINGS, type InitiativeSettings } from "../indicators/initiative/initiativeSettings";
import { CARD_SIZES, DEFAULT_LIVE_RANGE_SETTINGS, VERDICT_SENSITIVITIES, type LiveRangeSettings } from "../indicators/live-range-control/liveRangeSettings";
import { DEFAULT_LIVE_DELTA_PROFILE_SETTINGS, type LiveDeltaProfileSettings } from "../indicators/live-delta-profile/liveDeltaProfileSettings";
import { DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, type LiveOrderBookProfileSettings } from "../indicators/live-order-book-profile/liveOrderBookProfileSettings";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, type AggressiveProfileSettings } from "../indicators/aggressive-orders-profile/aggressiveProfileSettings";
import {
  DEFAULT_TOP_FRACTION,
  DEFAULT_WHALE_THRESHOLD_CONTRACTS,
  DEFAULT_WHALE_THRESHOLD_USD,
  type WhaleDetectionMode,
} from "../indicators/whale-detector/whaleTrades";
import type { WhaleClusterMode } from "../indicators/whale-detector/whaleMarkerClusters";
import { MAX_VPIN_SENSITIVITY, MIN_VPIN_SENSITIVITY } from "../indicators/vpin-cloud/vpinSensitivity";
import {
  DEFAULT_WHALE_SETTINGS as DEFAULT_WHALE_HEATMAP_SETTINGS,
  normalizeWhaleSettings as normalizeWhaleHeatmapSettings,
  type WhaleSettings as WhaleHeatmapSettings,
} from "../indicators/whale-limit-order-heatmap/whaleSettings";

export const LIVE_INDICATOR_EXTRAS_STORAGE_KEY = "terminal.live-indicators.extras.v1";
export const HISTORICAL_INDICATOR_EXTRAS_STORAGE_KEY = "terminal.historical-indicators.extras.v1";
export const MAX_KEYED_ENTRIES = 64;

export type WhaleSettings = Readonly<{
  thresholdUsd: number;
  thresholdContracts: number;
  mode: WhaleDetectionMode;
  topFraction: number;
  minDeltaPercent: number;
  clusterMode: WhaleClusterMode;
}>;

export type LiveIndicatorExtras = Readonly<{
  l2SupportResistance: L2SupportResistanceSettings;
  l2BookMap: L2BookMapSettings;
  whaleHeatmap: WhaleHeatmapSettings;
  liquidityByStyle: Readonly<Record<string, LiquiditySettings>>;
  liquidityLane: LiquidityLaneChoice;
  aggressiveByInstrument: Readonly<Record<string, AggressiveOrdersSettings>>;
  absorptionByInstrument: Readonly<Record<string, AbsorptionSettings>>;
  icebergByInstrument: Readonly<Record<string, IcebergSettings>>;
  exhaustionByInstrument: Readonly<Record<string, ExhaustionSettings>>;
  initiativeByInstrument: Readonly<Record<string, InitiativeSettings>>;
  liveRangeByInstrument: Readonly<Record<string, LiveRangeSettings>>;
  liveDeltaByInstrument: Readonly<Record<string, LiveDeltaProfileSettings>>;
  liveOrderBookByInstrument: Readonly<Record<string, LiveOrderBookProfileSettings>>;
  aggressiveProfileByInstrument: Readonly<Record<string, AggressiveProfileSettings>>;
  whale: WhaleSettings;
  vpinSensitivity: number | null;
}>;

export const DEFAULT_WHALE_SETTINGS: WhaleSettings = Object.freeze({
  thresholdUsd: DEFAULT_WHALE_THRESHOLD_USD,
  thresholdContracts: DEFAULT_WHALE_THRESHOLD_CONTRACTS,
  mode: "topPercent",
  topFraction: DEFAULT_TOP_FRACTION,
  minDeltaPercent: 0,
  clusterMode: "delta",
});

const ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  levelFilter: ["all", "resting", "consumed"],
  scaleMode: ["auto", "fixed"],
  mode: ["size", "topPercent"],
  clusterMode: ["delta", "buySell"],
  windowMode: ["auto", "week", "day", "session", "rolling", "visible"],
  cutBasis: ["usd", "ratio"],
  sideFilter: ["both", "bid", "ask"],
  liveView: ["ladder", "rays", "both", "off"],
  profileView: ["delta", "sides"],
  shape: ["circle", "triangle", "square"],
  markShape: ["auto", ...ICEBERG_MARK_SHAPES.map(([shape]) => shape)],
  rangeMode: ["visible", "selected", "live"],
  cardSize: CARD_SIZES.map(([size]) => size),
  verdictSensitivity: VERDICT_SENSITIVITIES.map(([sensitivity]) => sensitivity),
});

const ADDED_LATER: readonly string[] = ["historyHours", "historyDays", "timeframeWidening", "shape", "absorbedPercent", "strongPercent", "absorbedMultiple", "showBroken", "sizeTopPercent", "markShape", "placement", "profileView", "outlierFrom", "rangeMode", "bigPrint", "zoneColor", "cardSize", "showZone", "zoneOpacity", "verdictSensitivity", "showVolumeRow", "showDeltaRow", "showPrintsRow", "showMinutesRow", "showImpactRow", "showTips"];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fieldIsValid(key: string, candidate: unknown, reference: unknown): boolean {
  if (typeof reference === "number") return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0;
  if (typeof reference === "boolean") return typeof candidate === "boolean";
  if (typeof reference === "string") {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 64) return false;
    return ENUMS[key] === undefined || ENUMS[key].includes(candidate);
  }
  return false;
}

function mergeFields<T extends object>(raw: unknown, defaults: T): T {
  const merged: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  if (!record(raw)) return merged as T;
  for (const [key, reference] of Object.entries(defaults)) {
    if (Object.hasOwn(raw, key) && fieldIsValid(key, raw[key], reference)) merged[key] = raw[key];
  }
  return merged as T;
}

function completeEntry<T extends object>(raw: unknown, shape: T): T | null {
  if (!record(raw)) return null;
  const entry: Record<string, unknown> = {};
  for (const [key, reference] of Object.entries(shape)) {
    if (!Object.hasOwn(raw, key) && ADDED_LATER.includes(key)) {
      entry[key] = reference;
      continue;
    }
    if (!Object.hasOwn(raw, key) || !fieldIsValid(key, raw[key], reference)) return null;
    entry[key] = raw[key];
  }
  return entry as T;
}

function keyedEntries<T extends object>(raw: unknown, shape: T): Record<string, T> {
  const restored: Record<string, T> = {};
  if (!record(raw)) return restored;
  for (const [key, value] of Object.entries(raw).slice(0, MAX_KEYED_ENTRIES)) {
    if (key.length === 0 || key.length > 128) continue;
    const entry = completeEntry(value, shape);
    if (entry !== null) restored[key] = entry;
  }
  return restored;
}

function absorptionEntries(raw: unknown): Record<string, AbsorptionSettings> {
  const restored = keyedEntries(raw, DEFAULT_ABSORPTION_SETTINGS);
  if (!record(raw)) return restored;
  for (const [key, entry] of Object.entries(restored)) {
    const saved = raw[key] as Record<string, unknown>;
    if (!Object.hasOwn(saved, "historyDays") && typeof saved.historyHours === "number" && Number.isFinite(saved.historyHours)) {
      restored[key] = { ...entry, historyDays: absorptionHistoryDaysFromHours(saved.historyHours) };
    }
  }
  return restored;
}

function icebergEntries(raw: unknown): Record<string, IcebergSettings> {
  const restored = keyedEntries(raw, DEFAULT_ICEBERG_SETTINGS);
  for (const [key, entry] of Object.entries(restored)) {
    if (entry.revision !== ICEBERG_SETTINGS_REVISION) delete restored[key];
  }
  return restored;
}

function restoreVpinSensitivity(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= MIN_VPIN_SENSITIVITY && raw <= MAX_VPIN_SENSITIVITY ? raw : null;
}

export function defaultLiveIndicatorExtras(): LiveIndicatorExtras {
  return Object.freeze({
    l2SupportResistance: DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS,
    l2BookMap: DEFAULT_L2_BOOK_MAP_SETTINGS,
    whaleHeatmap: DEFAULT_WHALE_HEATMAP_SETTINGS,
    liquidityByStyle: {},
    liquidityLane: "0",
    aggressiveByInstrument: {},
    absorptionByInstrument: {},
    icebergByInstrument: {},
    exhaustionByInstrument: {},
    initiativeByInstrument: {},
    liveRangeByInstrument: {},
    liveDeltaByInstrument: {},
    liveOrderBookByInstrument: {},
    aggressiveProfileByInstrument: {},
    whale: DEFAULT_WHALE_SETTINGS,
    vpinSensitivity: null,
  });
}

export function restoreLiveIndicatorExtras(raw: unknown): LiveIndicatorExtras {
  if (!record(raw)) return defaultLiveIndicatorExtras();
  return Object.freeze({
    l2SupportResistance: normalizeL2SupportResistanceSettings(mergeFields(raw.l2SupportResistance, DEFAULT_L2_SUPPORT_RESISTANCE_SETTINGS)),
    l2BookMap: normalizeL2BookMapSettings(mergeFields(raw.l2BookMap, DEFAULT_L2_BOOK_MAP_SETTINGS)),
    whaleHeatmap: normalizeWhaleHeatmapSettings(mergeFields(raw.whaleHeatmap, DEFAULT_WHALE_HEATMAP_SETTINGS)),
    liquidityByStyle: keyedEntries(raw.liquidityByStyle, DEFAULT_LIQUIDITY_SETTINGS),
    liquidityLane: isLaneChoice(raw.liquidityLane) ? raw.liquidityLane : "0",
    aggressiveByInstrument: keyedEntries(raw.aggressiveByInstrument, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS),
    absorptionByInstrument: absorptionEntries(raw.absorptionByInstrument),
    icebergByInstrument: icebergEntries(raw.icebergByInstrument),
    exhaustionByInstrument: keyedEntries(raw.exhaustionByInstrument, DEFAULT_EXHAUSTION_SETTINGS),
    initiativeByInstrument: keyedEntries(raw.initiativeByInstrument, DEFAULT_INITIATIVE_SETTINGS),
    liveRangeByInstrument: keyedEntries(raw.liveRangeByInstrument, DEFAULT_LIVE_RANGE_SETTINGS),
    liveDeltaByInstrument: keyedEntries(raw.liveDeltaByInstrument, DEFAULT_LIVE_DELTA_PROFILE_SETTINGS),
    liveOrderBookByInstrument: keyedEntries(raw.liveOrderBookByInstrument, DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS),
    aggressiveProfileByInstrument: keyedEntries(raw.aggressiveProfileByInstrument, DEFAULT_AGGRESSIVE_PROFILE_SETTINGS),
    whale: Object.freeze(mergeFields(raw.whale, DEFAULT_WHALE_SETTINGS)),
    vpinSensitivity: restoreVpinSensitivity(raw.vpinSensitivity),
  });
}

export function loadLiveIndicatorExtras(storageKey = LIVE_INDICATOR_EXTRAS_STORAGE_KEY): LiveIndicatorExtras {
  try {
    const encoded = localStorage.getItem(storageKey);
    return encoded === null ? defaultLiveIndicatorExtras() : restoreLiveIndicatorExtras(JSON.parse(encoded));
  } catch {
    return defaultLiveIndicatorExtras();
  }
}

export function saveLiveIndicatorExtras(extras: LiveIndicatorExtras, storageKey = LIVE_INDICATOR_EXTRAS_STORAGE_KEY): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(restoreLiveIndicatorExtras(extras)));
  } catch {
    return;
  }
}
