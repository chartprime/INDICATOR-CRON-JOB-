/**
 * The trade rows the visible-range tick profile reads, in the shape it needs and
 * nothing more.
 *
 * The profile is drawn from the same data the Live Delta Profile is: the rows a
 * `DeltaSource` holds, which are executed trades by aggressor side -- the host's
 * own per-price records on a live chart, estimated from the candles on a
 * historical one. That is what lets the profile reach past the few hours the
 * heatmap columns keep: the host holds the trades, and the source says how far
 * back it has them.
 *
 * The source is taken structurally, through a type import and no value: this
 * indicator reads whatever satisfies it and owns no recording of its own.
 */

import type { DeltaSource } from "../live-delta-profile/candleDeltaSource";
import { rowIndexOf } from "../live-delta-profile/deltaProfileStore";

/** One price row's aggressive volume over the window the source covers. */
export interface TickFlowLevel {
  /** The source's absolute price row; its price is `row * rowWidth`. */
  row: number;
  buy: number;
  sell: number;
}

export interface TickFlowResult {
  levels: TickFlowLevel[];
  /**
   * The oldest instant the source holds, or null when it holds the whole window.
   *
   * The price domain is every visible bar regardless, so this is what says the
   * profile holds less than the range it is drawn over: a store answers the host
   * newest first, so a wide window reads as the whole range while only its
   * newest part is in.
   */
  coveredFromMs: number | null;
}

/**
 * The oldest instant the source still holds, or null when it holds the lot.
 *
 * A source with no holes in it -- the candles on a historical chart, or a store
 * the host has answered in full -- has nothing to report; a store the host is
 * still filling reports the start of its oldest piece, which is where its data
 * begins and moves back as the host answers more.
 */
function coveredFromMs(source: DeltaSource): number | null {
  if (source.complete) return null;
  let oldest = Infinity;
  for (const piece of source.pieces) {
    if (piece.from < oldest) oldest = piece.from;
  }
  return oldest === Infinity ? null : oldest;
}

/**
 * Every price row the source traded, oldest part of the window included, with
 * the oldest instant it reaches back to.
 *
 * The rows carry no timestamps -- a row is one price with its buys and its sells
 * over the whole window -- so the window is the source's own and cannot be
 * narrowed here; the profile is read over all of it.
 */
export function collectTickFlow(source: DeltaSource): TickFlowResult {
  const levels: TickFlowLevel[] = [];
  for (const row of source.rows()) {
    if (!(row.buy > 0) && !(row.sell > 0)) continue;
    levels.push({
      row: rowIndexOf(row.price, source.rowWidth),
      buy: row.buy,
      sell: row.sell,
    });
  }
  return { levels, coveredFromMs: coveredFromMs(source) };
}
