// The size ladder against the price axis: for every band in view, a bar
// growing leftwards from the axis in proportion to the latest column's size,
// and the size beside the axis. The strip is the free margin before the last
// candle, capped by `ladderReach`, so the ladder never sits on price. Bars sit
// below the candles (their own pane view), numbers above.
//
// The ladder is the whole book, like a DOM: one entry per band, never merged,
// so a bar sits exactly where its level is on the chart, and the trader's
// minimum size filters the chart, never the ladder. Numbers are the market's
// business: crypto reads in coins, indexes in contracts, equities in shares.

import type { IPrimitivePaneRenderer } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { HeatmapHost } from "./liquidityHeatmapHost";
import { rgba } from "./liquidityHeatmapHost";
import type { LadderRow } from "./liquidityHeatmapLayout";
import { liquidityStyleFor } from "./liquidityStyle";

const LADDER_FONT_PX = 11;
/** Right-aligned numbers live in this strip against the axis. */
export const LADDER_LABEL_WIDTH_PX = 44;
const LADDER_LABEL_BG = "rgba(242, 239, 230, 0.85)";
export const LADDER_EDGE_GAP_PX = 3;
const LADDER_BAR_OPACITY = 0.3;

/**
 * The numbers beside the axis: one per band while a band is tall enough for a
 * number, otherwise one per stack of neighbouring bands of one side that is
 * tall enough together, carrying their summed size. So the ladder keeps its
 * numbers at every zoom; zoomed out they read the liquidity in a price range
 * rather than in one band. Rows of a side are taken in price order.
 */
export function ladderLabelGroups(rows: readonly LadderRow[], minPx: number): LadderRow[] {
  const out: LadderRow[] = [];
  for (const side of ["bid", "ask"] as const) {
    const sorted = rows.filter((row) => row.side === side).sort((a, b) => a.yTop - b.yTop);
    let group: LadderRow | null = null;
    for (const row of sorted) {
      if (group && group.yBottom - group.yTop < minPx) {
        group.yBottom = Math.max(group.yBottom, row.yBottom);
        group.size += row.size;
        continue;
      }
      group = { yTop: row.yTop, yBottom: row.yBottom, side, size: row.size };
      out.push(group);
    }
  }
  return out;
}

/** How far into the pane the ladder may reach: the trader's share of the width, inside the free margin. */
export function ladderReachPx(host: HeatmapHost, paneWidth: number, hpr: number): number {
  const { ladderReach } = host.settings;
  const freeRight = host.layout?.freeRight ?? 0;
  // The free margin caps it, but the label strip is not a floor: a narrow reach has to be able to stay narrow.
  return Math.max(8 * hpr, Math.min(Math.min(1, Math.max(0, ladderReach)) * paneWidth, Math.max(LADDER_LABEL_WIDTH_PX * hpr, freeRight * hpr)));
}

/** Ladder bars growing leftwards from the axis; drawn beneath the series. */
export class LiquidityLadderBarsRenderer implements IPrimitivePaneRenderer {
  private readonly _host: HeatmapHost;

  constructor(host: HeatmapHost) {
    this._host = host;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const host = this._host;
    const layout = host.layout;
    if (!layout || layout.ladder.length === 0 || !(layout.ladderMax > 0) || !host.settings.showLadder) return;
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const paneWidth = bitmapSize.width;
      const edgeGap = Math.round(LADDER_EDGE_GAP_PX * hpr);
      const reach = ladderReachPx(host, paneWidth, hpr);
      // Like a DOM: the largest level in the visible window fills the reach and
      // the rest sit under it in proportion. Scaling against the whole book was
      // tried and rejected: far walls dwarf everything near price. Width is
      // linear in size; the gamma lift is for the heat, where a faint cell
      // still has to be visible, and here it pushed every bar to full width.
      context.save();
      try {
        for (const row of layout.ladder) {
          const rgb = row.side === "bid" ? host.bidRgb : host.askRgb;
          const y0 = Math.round(row.yTop * vpr);
          const y1 = Math.max(y0 + 1, Math.round(row.yBottom * vpr));
          const gap = y1 - y0 >= 4 ? 1 : 0;
          const share = Math.min(1, row.size / layout.ladderMax);
          const barWidth = Math.max(4 * hpr, Math.round(share * reach));
          context.fillStyle = rgba(rgb, LADDER_BAR_OPACITY);
          context.fillRect(paneWidth - edgeGap - barWidth, y0 + gap, barWidth, Math.max(1, y1 - y0 - gap * 2));
        }
      } finally {
        context.restore();
      }
    });
  }
}

/** Ladder numbers against the axis; drawn above the series. */
export class LiquidityLadderLabelsRenderer implements IPrimitivePaneRenderer {
  private readonly _host: HeatmapHost;

  constructor(host: HeatmapHost) {
    this._host = host;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const host = this._host;
    const layout = host.layout;
    if (!layout || layout.ladder.length === 0 || !host.settings.showLadder) return;
    const grid = host.grid;
    const style = liquidityStyleFor(grid?.provider, grid?.symbol, grid?.marketKind);
    if (!style.ladderNumbers) return;
    const unit = grid?.baseAsset ?? "";
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const paneWidth = bitmapSize.width;
      const edgeGap = Math.round(LADDER_EDGE_GAP_PX * hpr);
      const fontPx = Math.round(LADDER_FONT_PX * vpr);
      context.save();
      try {
        context.font = `700 ${fontPx}px sans-serif`;
        context.textBaseline = "middle";
        context.textAlign = "right";
        for (const row of ladderLabelGroups(layout.ladder, fontPx / vpr)) {
          const text = style.ladderText(row.size, unit);
          if (text === "") continue;
          const rgb = row.side === "bid" ? host.bidRgb : host.askRgb;
          const yMid = ((row.yTop + row.yBottom) / 2) * vpr;
          const textWidth = context.measureText(text).width;
          context.fillStyle = LADDER_LABEL_BG;
          context.fillRect(paneWidth - edgeGap - textWidth - 2 * hpr, Math.round(yMid - fontPx / 2 - hpr), textWidth + 4 * hpr, fontPx + 2 * hpr);
          context.fillStyle = rgba(rgb, 1);
          context.fillText(text, paneWidth - edgeGap, yMid);
        }
      } finally {
        context.restore();
      }
    });
  }
}
