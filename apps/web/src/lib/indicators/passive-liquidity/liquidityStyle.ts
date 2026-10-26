// How a market's heatmap is coloured and labelled. The columns, runs and
// fates are the same for every instrument; what differs is the reading the
// trader wants on top of them, and that is kept apart per market and, on the
// indexes, per instrument, so tuning one never touches another:
//
//   crypto    the Binance drawing, and any pair
//             without settings of its own        cryptoLiquidityStyle.ts
//   BTC       BTC spot and perp                  btcLiquidityStyle.ts
//   ES        /ES and /MES futures              esLiquidityStyle.ts
//   NQ        /NQ and /MNQ futures              nqLiquidityStyle.ts
//   index     other dxFeed futures, equities    indexLiquidityStyle.ts (the shared index machinery)
//
// The primitive asks the style for: the size that saturates a cell's colour,
// the darkness of a cell given its size and the column's floor, saturation
// and typical band, how brightness moves with the age of a run, how much of
// its row a band fills, and the words (ladder numbers, tooltip) for a size.
// Nothing here touches the run model.

import type { LiquidityColumn } from "./liquidityGrid";
import { futuresRoot, isIndexProvider } from "../../chart/l2Market";
import type { LiquiditySettings } from "./liquiditySettings";
import { cryptoLiquidityStyle } from "./cryptoLiquidityStyle";
import { aaplLiquidityStyle } from "./aaplLiquidityStyle";
import { btcLiquidityStyle, btcPerpLiquidityStyle } from "./btcLiquidityStyle";
import { ethLiquidityStyle, ethPerpLiquidityStyle } from "./ethLiquidityStyle";
import { indexLiquidityStyle } from "./indexLiquidityStyle";
import { esLiquidityStyle } from "./esLiquidityStyle";
import { tslaLiquidityStyle } from "./tslaLiquidityStyle";
import { nqLiquidityStyle } from "./nqLiquidityStyle";

export type LiquidityMarket = "crypto" | "index";

/** What the renderer knows when it works out a column's saturation. */
export interface SaturationContext {
  settings: LiquiditySettings;
  clusterRows: number;
  ladderMax: number; // the largest ladder size in view right now
  reference: number; // the live colour reference (the grid's running 95th percentile)
}

/** What the renderer knows when it colours one cell. All sizes are per band (clusterRows rows). */
export interface AlphaContext {
  settings: LiquiditySettings;
  paint: number; // the paint floor of this column and band: below it nothing is drawn
  saturation: number; // from saturationAt
  median: number; // the column's typical band: its median row size times the cluster
}

export interface HoverWords {
  label: string; // the size line of the tooltip; "" hides the line
  peakLabel: string; // appended as " · peak <peakLabel>" when not ""
  detail: string; // a second line under it; "" hides it
}

export interface LiquidityStyle {
  market: LiquidityMarket;
  /** A name for the tuning in use ("crypto", "es", "nq", "index"); the key each market's settings are kept under. */
  name: string;
  /**
   * What this market's heatmap starts from, and what "Reset to default"
   * returns to for it. A cluster of two rows suits BTC and is far too coarse
   * on ES; NQ wants three ticks a band and nothing under seven contracts.
   */
  defaultSettings: LiquiditySettings;
  /**
   * The size of one band of `clusterRows` rows, per side. Crypto sums the
   * rows: orders scatter over prices and add up. Indexes take the biggest row:
   * a level is a tick, and eight even rows of 25 must not read as 200 whatever
   * sits inside them. Every floor and threshold below is in these units.
   */
  bandSizes(
    column: LiquidityColumn,
    bandIndex: number,
    clusterRows: number,
  ): { bid: number; ask: number };
  /** The typical band of this column, in the units `bandSizes` produces: where the index colour ramp starts. */
  typicalBand(column: LiquidityColumn, context: SaturationContext): number;
  /**
   * The size a band of this column must hold to be a level at all, before the
   * quiet zone and the trader's minimum are applied. Crypto paints most of
   * what rests; an index book paints only what stands above its typical row.
   */
  paintFloor(column: LiquidityColumn, context: SaturationContext): number;
  /** The size that saturates the colour of a cell of this column. */
  saturationAt(column: LiquidityColumn, context: SaturationContext): number;
  /**
   * The size a band of this column is painted as a whole wall at: what an
   * absorption is measured against when the band shows less. Crypto paints
   * most of what rests and its floor is the wall; an index book shows a tenth
   * of what trades, and only its full-dark row is a wall.
   */
  wallSize(column: LiquidityColumn, context: SaturationContext): number;
  /** Alpha 0..255 of a cell holding `size`, given the column's floor, saturation and typical band. */
  alphaOf(size: number, context: AlphaContext): number;
  /** Brightness multiplier for a cell this far into its run; 1 leaves it alone. */
  ageFactor(ageMs: number): number;
  /** How much of its row a band fills at this share of the saturation: the vertical offset and size, in the row's pixels. */
  bandSpan(ratio: number, height: number): { offset: number; size: number };
  /** Whether the ladder beside the price axis carries numbers at all. */
  ladderNumbers: boolean;
  /** The number beside the axis for a ladder row; "" draws none. */
  ladderText(size: number, unit: string): string;
  /** What the tooltip says about a size and the most its run held. */
  hoverWords(size: number, peak: number, unit: string): HoverWords;
}


/**
 * The style for a frame's provider and wire symbol: a per-pair style on
 */
/** How a zoom lane's wider row reads this market: an index band is judged by its biggest tick, so the lane keeps the biggest tick; a crypto band sums its rows. */
export function laneFoldFor(provider: string | undefined, symbol: string | undefined = "", marketKind: string | undefined = ""): "sum" | "max" {
  return liquidityStyleFor(provider, symbol, marketKind).market === "index" ? "max" : "sum";
}

export function liquidityStyleFor(
  provider: string | undefined,
  symbol: string | undefined = "",
  marketKind: string | undefined = "",
): LiquidityStyle {
  if (!isIndexProvider(provider)) {
    const base = (symbol ?? "").split("-")[0];
    if (base === "BTC")
      return marketKind === "PERPETUAL"
        ? btcPerpLiquidityStyle
        : btcLiquidityStyle;
    if (base === "ETH")
      return marketKind === "PERPETUAL"
        ? ethPerpLiquidityStyle
        : ethLiquidityStyle;
    return cryptoLiquidityStyle;
  }
  if (symbol === "AAPL") return aaplLiquidityStyle;
  if (symbol === "TSLA") return tslaLiquidityStyle;
  const root = futuresRoot(symbol ?? "");
  if (root === "/ES" || root === "/MES") return esLiquidityStyle;
  if (root === "/NQ" || root === "/MNQ") return nqLiquidityStyle;
  return indexLiquidityStyle;
}
