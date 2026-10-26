import type {
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import {
  calculateValueAreaLevels,
  type VolumeDeltaProfileBin,
} from "../volume-delta-profile-ohlc/volumeDeltaProfileOhlc";
import type { TickFlowLevel } from "./volumeDeltaProfileTickSource";
import {
  type VolumeDeltaProfileTickSettings,
  DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
} from "./volumeDeltaProfileTickSettings";

export interface TickProfileBinResult {
  bins: VolumeDeltaProfileBin[];
  bucketHeight: number;
}

/**
 * Bin tick flow levels into price buckets spanning [minPrice, maxPrice].
 *
 * The range is divided into `bucketCount` buckets, each `range / bucketCount`
 * tall, until that would be thinner than one of the source's own rows. The flow
 * only knows volume per row, so from there on each bucket is one whole row, on
 * the grid the source counts its rows from: a narrower price range answers with
 * fewer, real rows rather than one row spread flat over thinner buckets, so the
 * count follows the zoom instead of staying at the setting. `fixedRowCount` asks
 * for `bucketCount` buckets and nothing else, whole source rows or not, which is
 * what a trader comparing rows across zooms wants instead.
 *
 * A source row covers the price band [row * rowWidth, (row + 1) * rowWidth). Its
 * flow is deposited into every bucket that band overlaps, in proportion to the
 * overlap, so a bucket thinner than a row takes its share instead of falling
 * between rows and coming up empty. A row wider than a bucket therefore spreads
 * across its neighbours and the profile stays continuous, with the total volume
 * unchanged; a row straddling an edge contributes only the share that falls
 * inside the domain.
 *
 * Buckets are shaped like the OHLC profile's (`price` is the band centre) so the
 * two profiles line up row for row.
 */
export function calculateTickDeltaProfileBins(
  levels: readonly TickFlowLevel[],
  rowWidth: number,
  minPrice: number,
  maxPrice: number,
  bucketCount: number,
  fixedRowCount = false,
): TickProfileBinResult {
  const range = maxPrice - minPrice;
  if (
    levels.length === 0 ||
    !Number.isFinite(range) ||
    range <= 0 ||
    !Number.isFinite(rowWidth) ||
    rowWidth <= 0 ||
    !Number.isFinite(bucketCount) ||
    bucketCount <= 0
  ) {
    return { bins: [], bucketHeight: 0 };
  }

  const requested = Math.max(1, Math.floor(bucketCount));
  const thinnerThanARow = !fixedRowCount && range / requested < rowWidth;
  // Whole-row buckets sit on the source's own grid: the domain starts at the row
  // the lowest visible price falls in, so every bucket is one whole row.
  const domainLow = thinnerThanARow
    ? Math.floor(minPrice / rowWidth + 1e-9) * rowWidth
    : minPrice;
  const bucketHeight = thinnerThanARow ? rowWidth : range / requested;
  const rows = thinnerThanARow
    ? Math.max(1, Math.ceil((maxPrice - domainLow) / rowWidth - 1e-9))
    : requested;
  const domainHigh = domainLow + rows * bucketHeight;
  const bins: VolumeDeltaProfileBin[] = Array.from(
    { length: rows },
    (_, index) => ({
      price: domainLow + (index + 0.5) * bucketHeight,
      buyVolume: 0,
      sellVolume: 0,
      delta: 0,
      totalVolume: 0,
      knownVolume: 0,
    }),
  );

  for (const level of levels) {
    const rowLow = level.row * rowWidth;
    // The row's band, clipped to the price domain: a row wholly outside it
    // contributes nothing, one straddling an edge contributes its inner share.
    const bandLow = Math.max(rowLow, domainLow);
    const bandHigh = Math.min(rowLow + rowWidth, domainHigh);
    const band = bandHigh - bandLow;
    if (!(band > 0)) continue;

    const first = Math.max(
      0,
      Math.min(rows - 1, Math.floor((bandLow - domainLow) / bucketHeight)),
    );
    const last = Math.max(
      0,
      Math.min(rows - 1, Math.ceil((bandHigh - domainLow) / bucketHeight) - 1),
    );

    for (let index = first; index <= last; index += 1) {
      const bucketLow = domainLow + index * bucketHeight;
      const overlap =
        Math.min(bandHigh, bucketLow + bucketHeight) -
        Math.max(bandLow, bucketLow);
      if (!(overlap > 0)) continue;

      const share = overlap / band;
      const bin = bins[index];
      const buy = level.buy * share;
      const sell = level.sell * share;
      bin.buyVolume += buy;
      bin.sellVolume += sell;
      bin.delta = bin.buyVolume - bin.sellVolume;
      bin.totalVolume += buy + sell;
      // Every print behind a row's flow carries a side, so the split is always known.
      bin.knownVolume += buy + sell;
    }
  }

  return { bins, bucketHeight };
}

const SMOOTH_CENTER_WEIGHT = 0.5;
const SMOOTH_NEIGHBOR_WEIGHT = (1 - SMOOTH_CENTER_WEIGHT) / 2;

/**
 * Blend each bucket with its neighbours using the same 0.25 / 0.5 / 0.25 kernel
 * the runtime's volume-profile engine applies, so the tick profile reads as
 * smoothly as the server-built ones instead of one sharp step per source row.
 * The weights are renormalised at the ends, so the profile's total volume -- and
 * therefore POC and the value area -- stay on the same volume as before.
 */
export function smoothTickProfileBins(
  bins: readonly VolumeDeltaProfileBin[],
): void {
  const original = bins.map((bin) => ({
    total: bin.totalVolume,
    buy: bin.buyVolume,
    sell: bin.sellVolume,
  }));
  const last = bins.length - 1;

  for (let i = 0; i <= last; i += 1) {
    const neighborCount = (i > 0 ? 1 : 0) + (i < last ? 1 : 0);
    const centerWeight =
      SMOOTH_CENTER_WEIGHT + (2 - neighborCount) * SMOOTH_NEIGHBOR_WEIGHT;
    let total = original[i].total * centerWeight;
    let buy = original[i].buy * centerWeight;
    let sell = original[i].sell * centerWeight;

    if (i > 0) {
      total += original[i - 1].total * SMOOTH_NEIGHBOR_WEIGHT;
      buy += original[i - 1].buy * SMOOTH_NEIGHBOR_WEIGHT;
      sell += original[i - 1].sell * SMOOTH_NEIGHBOR_WEIGHT;
    }
    if (i < last) {
      total += original[i + 1].total * SMOOTH_NEIGHBOR_WEIGHT;
      buy += original[i + 1].buy * SMOOTH_NEIGHBOR_WEIGHT;
      sell += original[i + 1].sell * SMOOTH_NEIGHBOR_WEIGHT;
    }

    const bin = bins[i];
    bin.totalVolume = total;
    bin.buyVolume = buy;
    bin.sellVolume = sell;
    bin.delta = buy - sell;
    bin.knownVolume = total;
  }
}

// Re-export settings for public API
export {
  type VolumeDeltaProfileTickSettings,
  DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
  normalizeVolumeDeltaProfileTickSettings,
  type PocLineStyle,
} from "./volumeDeltaProfileTickSettings";

export { calculateValueAreaLevels };

const LINE_STYLE_OPTIONS = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
] as const;

/**
 * What survives a reload, field by field, with the bounds the bespoke modal's own
 * controls use: a preference is restored only if it is a value those controls
 * could have produced, and anything else falls back to the default. That is why
 * the bounds here have to match the modal's sliders rather than merely be wide
 * enough to hold them.
 *
 * Every key of `VolumeDeltaProfileTickSettings` belongs here. A key left out is
 * not persisted at all, and a key whose bounds are wider than its slider would
 * let a hand-edited store in through a door the UI never opens.
 */
export const VOLUME_DELTA_PROFILE_TICK_PERSISTENCE_SCHEMA: readonly SettingsFieldSchema<VolumeDeltaProfileTickSettings>[] =
  [
    { kind: "color", key: "buyColor", label: "Buy colour", affects: "cosmetic" },
    { kind: "color", key: "sellColor", label: "Sell colour", affects: "cosmetic" },
    { kind: "boolean", key: "binBorderVisible", label: "Bin border", affects: "cosmetic" },
    { kind: "color", key: "binBorderColor", label: "Bin border colour", affects: "cosmetic" },
    { kind: "slider", key: "binBorderOpacity", label: "Bin border opacity", min: 0, max: 1, step: 0.05, affects: "cosmetic" },
    { kind: "boolean", key: "binVolumeVisible", label: "Bin volume text", affects: "cosmetic" },
    { kind: "slider", key: "minOpacity", label: "Min opacity", min: 0, max: 1, step: 0.05, affects: "cosmetic" },
    { kind: "slider", key: "maxOpacity", label: "Max opacity", min: 0, max: 1, step: 0.05, affects: "cosmetic" },
    { kind: "slider", key: "profileWidth", label: "Profile width", min: 50, max: 1_000, step: 10, affects: "cosmetic" },
    { kind: "slider", key: "binCount", label: "Rows", min: 20, max: 1_500, step: 10, affects: "cosmetic" },
    { kind: "boolean", key: "fixedRowCount", label: "Fixed amount of rows", affects: "cosmetic" },
    { kind: "boolean", key: "pocVisible", label: "POC line", affects: "cosmetic" },
    { kind: "color", key: "pocColor", label: "POC colour", affects: "cosmetic" },
    { kind: "select", key: "pocLineStyle", label: "POC style", options: LINE_STYLE_OPTIONS, affects: "cosmetic" },
    { kind: "slider", key: "pocLineWidth", label: "POC thickness", min: 1, max: 10, step: 1, affects: "cosmetic" },
    { kind: "boolean", key: "vahValVisible", label: "VAH / VAL levels", affects: "cosmetic" },
    { kind: "slider", key: "vahValPercent", label: "Value area percent", min: 10, max: 99, step: 1, affects: "cosmetic" },
    { kind: "color", key: "vahColor", label: "VAH colour", affects: "cosmetic" },
    { kind: "color", key: "valColor", label: "VAL colour", affects: "cosmetic" },
    { kind: "select", key: "vahLineStyle", label: "VAH style", options: LINE_STYLE_OPTIONS, affects: "cosmetic" },
    { kind: "select", key: "valLineStyle", label: "VAL style", options: LINE_STYLE_OPTIONS, affects: "cosmetic" },
    { kind: "slider", key: "vahValLineWidth", label: "VAH / VAL thickness", min: 1, max: 10, step: 1, affects: "cosmetic" },
  ];

/**
 * Volume Profile (Ticks) indicator.
 *
 * Renders the visible range's attention profile from real traded volume: the
 * same executed buys and sells the Live Delta Profile reads, per price row,
 * binned into price levels at the right edge of the chart, with a sell portion
 * nested inside each total-volume bar.
 */
export const volumeDeltaProfileTickIndicator: RuntimeIndicatorDef<
  Record<string, never>,
  VolumeDeltaProfileTickSettings
> = {
  kind: "runtime",
  id: "volumeDeltaProfileTick",
  label: "Volume Profile (Ticks)",
  category: "l1",
  defaultSettings: DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
  // Empty on purpose rather than absent: this indicator's form is the bespoke
  // `VolumeDeltaProfileTickSettingsModal`, and the panel reads a present-but-empty
  // schema as "has its own modal" -- which is also what keeps the legend's
  // settings button. Preferences, though, skip a definition whose schema is empty,
  // so every field has to be named again in a persistence schema to be saved.
  settingsSchema: [],
  persistenceSchema: VOLUME_DELTA_PROFILE_TICK_PERSISTENCE_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  createState: () => ({}),
  onBar: () => {},
  readOutput: () => ({}),
};
