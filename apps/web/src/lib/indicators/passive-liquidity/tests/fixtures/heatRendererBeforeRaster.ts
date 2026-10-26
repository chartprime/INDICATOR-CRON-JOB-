import type { IPrimitivePaneRenderer } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { HeatmapHost, Rgb } from "../../liquidityHeatmapHost";
import { cellOf } from "../../liquidityHeatRenderer";
import { createRunFinder, showsFate, type RunFinder } from "../../liquidityRunFinder";
import { CONNECTOR_ALPHA_SHARE, CONNECTOR_PX } from "../../liquidityRuns";

/** The solid cap that ends a consumed level where price ate it. */
const CONSUMED_CAP_PX = 2;
/**
 * A resting level's newest column is at least this wide. At 1 s columns on a
 * 1-minute chart a level's first column is a tenth of a pixel, so without this
 * a level that just appeared hides as a sliver for its first half minute.
 */
const LIVE_EDGE_MIN_PX = 3;

/** Paint a cell into RGBA data where it is brighter than what is already there. */
function fillCell(data: Uint8ClampedArray, width: number, x0: number, x1: number, y0: number, y1: number, rgb: Rgb, alpha: number): void {
  for (let y = y0; y < y1; y += 1) {
    let index = (y * width + x0) * 4;
    for (let x = x0; x < x1; x += 1, index += 4) {
      if (data[index + 3] < alpha) {
        data[index] = rgb.r;
        data[index + 1] = rgb.g;
        data[index + 2] = rgb.b;
        data[index + 3] = alpha;
      }
    }
  }
}

/** The darkness of the cap on a consumed level: the trader's opacity, full. */
function capAlphaOf(maxOpacity: number): number {
  return Math.round(Math.min(1, Math.max(0, maxOpacity)) * 255);
}

export type BeforeRasterHost = Pick<HeatmapHost, "grid" | "layout" | "settings" | "bidRgb" | "askRgb" | "imageBuffer" | "offscreen">;

export class HeatRendererBeforeRaster implements IPrimitivePaneRenderer {
  private readonly _host: BeforeRasterHost;
  private _drawn: { runs: RunFinder; key: string; canvas: HTMLCanvasElement | OffscreenCanvas } | null = null;

  constructor(host: BeforeRasterHost) {
    this._host = host;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const host = this._host;
    const layout = host.layout;
    const grid = layout?.grid ?? null;
    if (!layout || !grid || layout.bands.length === 0 || !layout.tiers.some((tier) => tier.to > tier.from) || !(layout.reference > 0)) return;
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
      const width = bitmapSize.width;
      const height = bitmapSize.height;
      if (width <= 0 || height <= 0) return;

      // The bands in view, in device pixels, and the vertical span they cover.
      const bands: { row: number; y0: number; y1: number }[] = [];
      let minY = height;
      let maxY = 0;
      for (const band of layout.bands) {
        let y0 = Math.round(band.yTop * verticalPixelRatio);
        let y1 = Math.round(band.yBottom * verticalPixelRatio);
        if (y1 <= y0) y1 = y0 + 1;
        y0 = Math.max(0, y0);
        y1 = Math.min(height, y1);
        if (y1 <= y0) continue;
        bands.push({ row: band.row, y0, y1 });
        if (y0 < minY) minY = y0;
        if (y1 > maxY) maxY = y1;
      }
      if (bands.length === 0) return;

      // The image spans every tier in view: the deep past and the recent minutes.
      const xOf = (ms: number) => Math.round((layout.originX + (ms - layout.originMs) * layout.pxPerMs) * horizontalPixelRatio);
      let firstMs = Infinity;
      let lastMs = -Infinity;
      for (const tier of layout.tiers) {
        if (tier.to <= tier.from) continue; // scanned for runs, nothing of it in view
        firstMs = Math.min(firstMs, tier.columns[tier.from].ts);
        lastMs = Math.max(lastMs, tier.columns[tier.to - 1].ts + tier.columnMs);
      }
      if (!Number.isFinite(firstMs)) return;
      const livePx = Math.max(1, Math.round(LIVE_EDGE_MIN_PX * horizontalPixelRatio));
      const minX = Math.max(0, xOf(firstMs));
      const maxX = Math.min(width, xOf(lastMs) + livePx);
      if (maxX <= minX) return;
      const imageWidth = maxX - minX;
      const settings = host.settings;
      const runs = createRunFinder(grid, layout, settings);
      const key = [
        width, height, horizontalPixelRatio, verticalPixelRatio, minX, maxX, minY, maxY,
        layout.originX, layout.originMs, layout.pxPerMs,
        host.bidRgb.r, host.bidRgb.g, host.bidRgb.b, host.askRgb.r, host.askRgb.g, host.askRgb.b,
        bands.map((band) => `${band.row}:${band.y0}:${band.y1}`).join(","),
        layout.tiers.map((tier) => `${tier.from}:${tier.to}`).join(","),
      ].join("|");
      const drawn = this._drawn;
      if (drawn !== null && drawn.runs === runs && drawn.key === key) {
        const canvas = host.offscreen(imageWidth, maxY - minY);
        if (canvas !== null && canvas.canvas === drawn.canvas) {
          context.drawImage(canvas.canvas, minX, minY);
          return;
        }
      }
      const image = host.imageBuffer(imageWidth, maxY - minY);
      if (!image) return;
      const data = image.data;
      const style = runs.style;
      const connector = Math.max(1, Math.round(CONNECTOR_PX * verticalPixelRatio));
      const cap = Math.max(2, Math.round(CONSUMED_CAP_PX * horizontalPixelRatio));
      const capAlpha = capAlphaOf(settings.maxOpacity);

      for (const band of bands) {
        // One run per side. A band where both sides rest (the spread sits inside
        // it) is split, bid below and ask above, so it never flips colour.
        for (const side of ["bid", "ask"] as const) {
          const segments = runs.runsFor(band.row, side);
          if (segments.length === 0) continue;
          const rgb = side === "bid" ? host.bidRgb : host.askRgb;
          let ri = 0;
          for (const tier of layout.tiers) {
            for (let c = tier.from; c < tier.to; c += 1) {
              const column = tier.columns[c];
              while (ri < segments.length && segments[ri].endTs <= column.ts) ri += 1;
              const run = segments[ri];
              if (!run || column.ts < run.startTs) continue;
              if (!showsFate(settings, run.fate)) continue;
              const sizes = runs.sizesAt(column, band.row);
              const size = sizes[side];
              const { paint: paintFloor, link: linkFloor } = runs.floorsAt(column, band.row, true);
              if (!(size >= linkFloor)) continue;
              const shared = sizes[side === "bid" ? "ask" : "bid"] >= linkFloor;
              const mid = Math.round((band.y0 + band.y1) / 2);
              const hy0 = shared ? (side === "bid" ? mid : band.y0) : band.y0;
              const hy1 = shared ? (side === "bid" ? band.y1 : mid) : band.y1;
              if (hy1 <= hy0) continue;

              let x0 = xOf(column.ts);
              let x1 = xOf(column.ts + tier.columnMs);
              if (x1 <= x0) x1 = x0 + 1;
              // A resting level's newest column gets a small head past the live edge.
              if (run.fate === "resting" && column.ts + tier.columnMs >= run.endTs) x1 = Math.max(x1, x0 + livePx);
              x0 = Math.max(minX, x0) - minX;
              x1 = Math.min(maxX, x1) - minX;
              if (x1 <= x0) continue;

              const cell = cellOf(run, size, paintFloor);
              const age = style.ageFactor(column.ts + tier.columnMs - run.startTs) * cell.fade;
              const saturation = style.saturationAt(column, runs.saturation);
              const median = style.typicalBand(column, runs.saturation);
              if (cell.full) {
                const alpha = Math.round(style.alphaOf(cell.size, { settings, paint: paintFloor, saturation, median }) * age);
                if (alpha > 0) {
                  const span = style.bandSpan(cell.size / saturation, hy1 - hy0);
                  const top = hy0 + span.offset;
                  fillCell(data, imageWidth, x0, x1, top - minY, top + span.size - minY, rgb, alpha);
                }
              } else {
                // Thinned for the moment but still there: a hairline keeps the level in one piece.
                const floorAlpha = style.alphaOf(paintFloor, { settings, paint: paintFloor, saturation, median });
                const alpha = Math.max(1, Math.round(floorAlpha * CONNECTOR_ALPHA_SHARE * age));
                const top = Math.round((hy0 + hy1) / 2) - Math.floor(connector / 2);
                fillCell(data, imageWidth, x0, x1, top - minY, top + connector - minY, rgb, alpha);
              }
              // Consumed: a solid cap on the last column marks where price ate it.
              if (run.fate === "consumed" && column.ts + tier.columnMs >= run.endTs) {
                fillCell(data, imageWidth, Math.max(0, x1 - cap), x1, hy0 - minY, hy1 - minY, rgb, capAlpha);
              }
            }
          }
        }
      }

      const canvas = host.offscreen(imageWidth, maxY - minY);
      if (!canvas) return;
      canvas.putImageData(image, 0, 0);
      this._drawn = { runs, key, canvas: canvas.canvas };
      context.drawImage(canvas.canvas, minX, minY);
    });
  }
}
