import type { BarFrame } from "../../../types/frames";
import {
  type VolumeDeltaProfileOhlcSettings,
  DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS,
  MAX_PROFILE_WIDTH_PX,
  MIN_PROFILE_WIDTH_PX,
  PROFILE_WIDTH_STEP_PX,
} from "./volumeDeltaProfileOhlcSettings";
import type {
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import { barSides } from "../barSides";

export interface OhlcDeltaBucket {
  open: number;
  high: number;
  low: number;
  close: number;
  buyVolume: number;
  sellVolume: number;
  delta: number; // buyVolume - sellVolume; 0 when deltaKnown is false
  totalVolume: number;
  deltaKnown: boolean; // false when the bar carried no buy_volume, so no side split is known
}

/**
 * Calculate OHLC delta buckets from bars.
 * Delta = buyVolume - sellVolume, only when the bar reports buy_volume.
 */
export function calculateOhlcDeltaProfile(
  bars: readonly BarFrame[],
): OhlcDeltaBucket[] {
  return bars.map((bar) => {
    const sides = barSides(bar);
    const deltaKnown = sides.known;
    const buyVolume = sides.buy;
    const sellVolume = sides.sell;
    const delta = sides.delta;

    return {
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      buyVolume,
      sellVolume,
      delta,
      totalVolume: bar.volume,
      deltaKnown,
    };
  });
}

// Re-export settings for public API
export {
  type VolumeDeltaProfileOhlcSettings,
  DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS,
  type PocLineStyle,
} from "./volumeDeltaProfileOhlcSettings";

/**
 * Volume Profile OHLC indicator.
 *
 * Renders OHLC candles with delta calculation:
 * delta = 2 * buy_volume - total_volume
 *
 * Renders at the right edge of the chart, with split buy/sell volume bars
 * binned across price levels from the visible bar range.
 */
const OHLC_LINE_STYLE_OPTIONS = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
] as const;

export const VOLUME_DELTA_PROFILE_OHLC_PERSISTENCE_SCHEMA: readonly SettingsFieldSchema<VolumeDeltaProfileOhlcSettings>[] =
  [
    { kind: "color", key: "buyColor", label: "Buy colour", affects: "cosmetic" },
    { kind: "color", key: "sellColor", label: "Sell colour", affects: "cosmetic" },
    { kind: "slider", key: "minOpacity", label: "Min opacity", min: 0, max: 1, step: 0.05, affects: "cosmetic" },
    { kind: "slider", key: "maxOpacity", label: "Max opacity", min: 0, max: 1, step: 0.05, affects: "cosmetic" },
    { kind: "slider", key: "profileWidth", label: "Profile width", min: MIN_PROFILE_WIDTH_PX, max: MAX_PROFILE_WIDTH_PX, step: PROFILE_WIDTH_STEP_PX, affects: "cosmetic" },
    { kind: "slider", key: "binCount", label: "Rows", min: 20, max: 500, step: 10, affects: "cosmetic" },
    { kind: "boolean", key: "pocVisible", label: "POC line", affects: "cosmetic" },
    { kind: "color", key: "pocColor", label: "POC colour", affects: "cosmetic" },
    { kind: "select", key: "pocLineStyle", label: "POC style", options: OHLC_LINE_STYLE_OPTIONS, affects: "cosmetic" },
    { kind: "boolean", key: "vahValVisible", label: "VAH / VAL levels", affects: "cosmetic" },
    { kind: "slider", key: "vahValPercent", label: "Value area percent", min: 10, max: 99, step: 1, affects: "cosmetic" },
    { kind: "color", key: "vahColor", label: "VAH colour", affects: "cosmetic" },
    { kind: "color", key: "valColor", label: "VAL colour", affects: "cosmetic" },
    { kind: "select", key: "vahLineStyle", label: "VAH style", options: OHLC_LINE_STYLE_OPTIONS, affects: "cosmetic" },
    { kind: "select", key: "valLineStyle", label: "VAL style", options: OHLC_LINE_STYLE_OPTIONS, affects: "cosmetic" },
    { kind: "slider", key: "vahValLineWidth", label: "VAH / VAL thickness", min: 1, max: 10, step: 1, affects: "cosmetic" },
  ];

export const volumeDeltaProfileOhlcIndicator: RuntimeIndicatorDef<
  Record<string, never>,
  VolumeDeltaProfileOhlcSettings
> = {
  kind: "runtime",
  id: "volumeDeltaProfileOhlc",
  label: "Volume Profile OHLC",
  category: "l1",
  defaultSettings: DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS,
  settingsSchema: [],
  persistenceSchema: VOLUME_DELTA_PROFILE_OHLC_PERSISTENCE_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  createState: () => ({}),
  onBar: () => {},
  readOutput: () => ({}),
};
/**
 * Calculate and prepare OHLC delta data for rendering.
 * This is used by the primitive to get the bins to display.
 */
export function prepareVolumeDeltaOhlcData(bars: readonly BarFrame[]) {
  return {
    bins: calculateVolumeDeltaProfileBins(bars),
  };
}

export const BUCKET_COUNT = 100;

export interface VolumeDeltaProfileBin {
  price: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  totalVolume: number;
  knownVolume: number; // portion of totalVolume from bars that reported a side split
}

export interface VolumeDeltaProfileBinResult {
  bins: VolumeDeltaProfileBin[];
  bucketHeight: number;
}

/**
 * Bin OHLC delta data into price levels.
 * Distributes each bar's volume across price buckets it spans (high-low range).
 */
export function calculateVolumeDeltaProfileBins(
  bars: readonly BarFrame[],
  bucketCount: number = BUCKET_COUNT,
): VolumeDeltaProfileBinResult {
  if (bars.length === 0) {
    return { bins: [], bucketHeight: 0 };
  }

  // Find price range
  const allPrices = bars.flatMap((bar) => [bar.high, bar.low]);
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const range = maxPrice - minPrice;

  if (!Number.isFinite(range) || range <= 0) {
    return { bins: [], bucketHeight: 0 };
  }

  const bucketHeight = range / bucketCount;
  const bins: VolumeDeltaProfileBin[] = Array.from(
    { length: bucketCount },
    (_, index) => ({
      price: minPrice + (index + 0.5) * bucketHeight,
      buyVolume: 0,
      sellVolume: 0,
      delta: 0,
      totalVolume: 0,
      knownVolume: 0,
    }),
  );

  // Distribute each bar across its price range
  for (const bar of bars) {
    const ohlc = calculateOhlcDeltaProfile([bar])[0];

    // Find which bin the close price falls into
    const closeBucketIndex = Math.max(
      0,
      Math.min(
        bucketCount - 1,
        Math.floor((bar.close - minPrice) / bucketHeight),
      ),
    );

    // Distribute volume: 50% to close bin, 25% to bins above and below
    const distributions = [
      { index: closeBucketIndex, ratio: 0.5 },
      { index: closeBucketIndex + 1, ratio: 0.25 },
      { index: closeBucketIndex - 1, ratio: 0.25 },
    ];

    for (const { index, ratio } of distributions) {
      if (index >= 0 && index < bucketCount) {
        bins[index].totalVolume += ohlc.totalVolume * ratio;
        bins[index].knownVolume += ohlc.deltaKnown ? ohlc.totalVolume * ratio : 0;
        bins[index].buyVolume += ohlc.buyVolume * ratio;
        bins[index].sellVolume += ohlc.sellVolume * ratio;
        bins[index].delta = bins[index].buyVolume - bins[index].sellVolume;
      }
    }
  }

  return { bins, bucketHeight };
}

export interface ValueAreaLevels {
  vah: number;
  val: number;
  poc: number;
}

/**
 * Calculate Value Area High and Value Area Low from profile bins.
 * VAH/VAL represents the price range containing a specified percentage of total volume.
 *
 * Algorithm:
 * 1. Find Point of Control (POC) - price level with highest volume
 * 2. Accumulate volume from POC outward (alternating up/down) until reaching target percentage
 * 3. Return highest (VAH) and lowest (VAL) prices in that range
 */
export function calculateValueAreaLevels(
  bins: readonly VolumeDeltaProfileBin[],
  bucketHeight: number,
  valueAreaPercent: number,
): ValueAreaLevels | null {
  if (bins.length === 0) return null;

  // Find POC (Point of Control) - the price level with highest volume
  let pocIndex = 0;
  let maxVolume = 0;

  for (let i = 0; i < bins.length; i++) {
    if (bins[i].totalVolume > maxVolume) {
      maxVolume = bins[i].totalVolume;
      pocIndex = i;
    }
  }

  // Calculate total volume
  const totalVolume = bins.reduce((sum, bin) => sum + bin.totalVolume, 0);
  if (totalVolume === 0) return null;

  // Target volume to accumulate
  const targetVolume = (totalVolume * valueAreaPercent) / 100;

  // Start from POC and expand outward
  let accumulatedVolume = bins[pocIndex].totalVolume;
  let lowIndex = pocIndex;
  let highIndex = pocIndex;

  // Expand range until we reach target volume
  while (accumulatedVolume < targetVolume) {
    const canExpandUp = highIndex < bins.length - 1;
    const canExpandDown = lowIndex > 0;

    if (!canExpandUp && !canExpandDown) break;

    // Expand towards the side with more volume
    const upVolume = canExpandUp ? bins[highIndex + 1].totalVolume : 0;
    const downVolume = canExpandDown ? bins[lowIndex - 1].totalVolume : 0;

    if (upVolume >= downVolume) {
      if (canExpandUp) {
        highIndex++;
        accumulatedVolume += bins[highIndex].totalVolume;
      } else if (canExpandDown) {
        lowIndex--;
        accumulatedVolume += bins[lowIndex].totalVolume;
      }
    } else {
      if (canExpandDown) {
        lowIndex--;
        accumulatedVolume += bins[lowIndex].totalVolume;
      } else if (canExpandUp) {
        highIndex++;
        accumulatedVolume += bins[highIndex].totalVolume;
      }
    }
  }

  return {
    vah: bins[highIndex].price + bucketHeight / 2,
    val: bins[lowIndex].price - bucketHeight / 2,
    poc: bins[pocIndex].price,
  };
}
