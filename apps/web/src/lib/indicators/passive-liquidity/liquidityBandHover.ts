// The tooltip's answer: the band under the cursor, the side that holds it and
// the run it belongs to, the very run the chart draws. It reports the size held
// at the moment under the cursor, the most the run ever held, its fate and its
// length. Nothing hidden by the settings answers.
//
// (The exported type is still called WallHover: it feeds the tooltip that
// ChartPanel.tsx renders, and that file is the client's. There are no walls in
// the picture any more, only bands and their runs.)

import { chartMsOf, wallMsOf } from "./chartTime";
import { liquidityIndexAtOrAfter, type HeatGrid, type LiquidityColumn } from "./liquidityGrid";
import type { HeatmapLayout } from "./liquidityHeatmapLayout";
import { createRunFinder, showsFate } from "./liquidityRunFinder";
import type { RunFate } from "./liquidityRuns";
import type { LiquiditySettings } from "./liquiditySettings";

/** What became of a band over its run, as far as the picture can tell. */
export type BandState = RunFate;

/** The band the cursor is over, for the chart's tooltip. */
export interface WallHover {
  side: "bid" | "ask";
  size: number; // held at the moment under the cursor
  peak: number; // the most it held over the run
  state: BandState;
  fill: number | null; // of the level's peak, the share that traded, from the server's ledger; null when no tracked wall matched
  ageMs: number; // the length of the run
  priceLo: number;
  priceHi: number;
  unit: string;
  /** The size line of the tooltip, from the market's style: "73.0 BTC" on crypto, nothing on indexes. */
  label: string;
  detail: string;
  /** The most the run held, in the same words; empty when the peak is the size or the style shows no numbers. */
  peakLabel: string;
  lane: number;
}

function columnAt(tiers: readonly { columns: readonly LiquidityColumn[]; columnMs: number }[], ms: number): LiquidityColumn | null {
  for (let i = tiers.length - 1; i >= 0; i -= 1) {
    const index = liquidityIndexAtOrAfter(tiers[i].columns, ms + 1) - 1;
    if (index >= 0 && ms < tiers[i].columns[index].ts + tiers[i].columnMs) return tiers[i].columns[index];
  }
  return null;
}

/** The band under a pane coordinate (media px), or null where the chart draws nothing. */
export function bandAt(grid: HeatGrid, layout: HeatmapLayout, settings: LiquiditySettings, x: number, y: number): WallHover | null {
  const latest = grid.latest;
  if (!latest) return null;
  const band = layout.bands.find((entry) => y >= entry.yTop && y <= entry.yBottom);
  if (!band) return null;
  // Right of the last column is the margin and the ladder: the ladder is the
  // book, not a level, so the hover stays quiet there.
  const ms = wallMsOf(chartMsOf(layout.originMs, layout.gaps) + (x - layout.originX) / layout.pxPerMs, layout.gaps);
  if (ms >= latest.ts + grid.columnMs) return null;
  const column = columnAt(layout.tiers, ms);
  if (!column) return null;

  const runs = createRunFinder(grid, layout, settings);
  const here = runs.sizesAt(column, band.row);
  const size = Math.max(here.bid, here.ask);
  // The same floors the chart paints by: each column's own yardstick.
  if (!(size >= runs.floorsAt(column, band.row, true).link)) return null;
  const side: "bid" | "ask" = here.bid >= here.ask ? "bid" : "ask";
  const run = runs.runsFor(band.row, side).find((entry) => ms >= entry.startTs && ms < entry.endTs);
  if (!run || !showsFate(settings, run.fate)) return null;

  const words = runs.style.hoverWords(size, run.peak, grid.baseAsset);
  const rows = runs.clusterRows;
  return {
    side,
    size,
    peak: run.peak,
    state: run.fate,
    fill: run.fill,
    ageMs: run.endTs - run.startTs,
    priceLo: band.row * rows * layout.rowWidth,
    priceHi: (band.row + 1) * rows * layout.rowWidth,
    unit: grid.baseAsset,
    label: words.label,
    detail: words.detail,
    peakLabel: words.peakLabel,
    lane: layout.lane,
  };
}
