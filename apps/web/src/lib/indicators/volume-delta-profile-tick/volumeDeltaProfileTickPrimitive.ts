import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { BarFrame } from "../../../types/frames";
import { barCloseMs } from "../../chart/chartData";
import { STATUS_BADGE_SLOT, drawStatusBadge } from "../../chart/statusBadge";
import type { DeltaSource } from "../live-delta-profile/candleDeltaSource";
import {
  drawBinValue,
  formatLabelVolume,
} from "../volume-profile/profileLevelLabels";
import {
  calculateTickDeltaProfileBins,
  calculateValueAreaLevels,
  smoothTickProfileBins,
} from "./volumeDeltaProfileTick";
import { collectTickFlow } from "./volumeDeltaProfileTickSource";
import {
  type VolumeDeltaProfileTickSettings,
  DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
  normalizeVolumeDeltaProfileTickSettings,
} from "./volumeDeltaProfileTickSettings";
import type {
  ValueAreaLevels,
  VolumeDeltaProfileBin,
} from "../volume-delta-profile-ohlc/volumeDeltaProfileOhlc";

/**
 * Convert hex color to rgba with opacity.
 */
function withOpacity(hexColor: string, opacity: number): string {
  const hex = hexColor.startsWith("#") ? hexColor.slice(1) : hexColor;
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Set line dash pattern based on style.
 */
function setLineStyle(
  context: CanvasRenderingContext2D,
  style: "dotted" | "solid" | "dashed",
): void {
  switch (style) {
    case "dotted":
      context.setLineDash([2, 4]);
      break;
    case "dashed":
      context.setLineDash([8, 4]);
      break;
    case "solid":
      context.setLineDash([]);
      break;
  }
}

/** The value area is a guide, so its lines are drawn back from full strength. */
const VALUE_AREA_ALPHA = 0.7;

/**
 * Stroke one horizontal level line across [0, rightX] at `y`.
 *
 * Draw order is the caller's business: the value-area lines go down before the
 * bins, which then paint over them, while the POC goes down after.
 */
function drawLevelLine(
  context: CanvasRenderingContext2D,
  y: number,
  rightX: number,
  color: string,
  style: "dotted" | "solid" | "dashed",
  lineWidth: number,
  alpha: number,
): void {
  setLineStyle(context, style);
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.globalAlpha = alpha;
  context.beginPath();
  context.moveTo(0, y);
  context.lineTo(rightX, y);
  context.stroke();
}

/** A built profile in price space: everything a repaint needs but the pane. */
interface TickProfileFrame {
  bins: readonly VolumeDeltaProfileBin[];
  bucketHeight: number;
  maxVolume: number;
  pocPrice: number;
  valueAreaLevels: ValueAreaLevels | null;
  /**
   * The instant the profile's flow starts at when that is later than the window
   * it is drawn over, or null when the source reaches back through the whole
   * window. The price domain is every visible bar regardless, so this is what
   * says the profile holds less than the range it is drawn over.
   */
  truncatedFromMs: number | null;
}

/** A built profile, and a fingerprint of the inputs it was built from. */
interface CachedTickProfile {
  fingerprint: string;
  /** The source version the frame was built from. */
  version: number;
  builtAt: number;
  frame: TickProfileFrame;
}

/**
 * The least time between two rebuilds that only new trades ask for. The source's
 * version moves on every print, and a rebuild reads every row the source holds
 * (about 9 ms over a week of two-hour pieces), so rebuilding on every repaint
 * while trades stream would cost most of a frame on a busy book. A moved
 * window, price domain or setting still rebuilds at once.
 */
export const TICK_PROFILE_LIVE_REBUILD_MS = 250;

export const TICK_PROFILE_ESTIMATE_BADGE = "Volume Profile (Ticks) · estimated from candles";

/**
 * Visible-range volume profile built from real traded volume: the executed buys
 * and sells the Live Delta Profile reads, per price row, binned at the chart's
 * right edge. Each row is a total-volume bar with the sell portion nested inside
 * it.
 */
export class VolumeDeltaProfileTickPrimitive implements ISeriesPrimitive<Time> {
  private bars: readonly BarFrame[] = [];
  private source: DeltaSource | null = null;
  private attachedParams: SeriesAttachedParameter<Time> | null = null;
  private settings: VolumeDeltaProfileTickSettings =
    DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS;
  /** Bumped by `updateSettings`, so the settings join a profile's fingerprint. */
  private settingsRevision = 0;
  private profile: CachedTickProfile | null = null;
  private rightInset: ((paneWidth: number) => number) | null = null;
  /** The repaint owed once the live rebuild interval has passed. */
  private repaintTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the panel was last told, so a repaint does not repeat itself. */
  private reportedTruncatedFromMs: number | null | undefined = undefined;

  /**
   * Set by the panel: told the instant the profile starts at whenever it covers
   * less than its window, and null when it covers the window.
   */
  onTruncatedFromChange: ((fromMs: number | null) => void) | null = null;

  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) => {
      const attachedParams = this.attachedParams;
      if (
        !attachedParams ||
        this.bars.length === 0 ||
        this.source === null
      ) {
        return;
      }

      const visibleRange = attachedParams.chart.timeScale().getVisibleRange();
      if (!visibleRange) return;
      const fromSec = visibleRange.from as number;
      const toSec = visibleRange.to as number;

      // Filter bars to the visible range: they give the profile its price domain.
      const visibleBars = this.bars.filter((bar) => {
        const barTime = bar.ts_open / 1000;
        return barTime >= fromSec && barTime <= toSec;
      });
      if (visibleBars.length === 0) return;

      // The source's window is its own -- MainPanel keeps it on the candles in
      // view, open ended while the newest candle is on screen, so the developing
      // bar's prints are already in it. The bars only give the price domain, and
      // the last one's close says which window this is, for the repaint check.
      const toMs = barCloseMs(visibleBars[visibleBars.length - 1]);

      let minPrice = Infinity;
      let maxPrice = -Infinity;
      for (const bar of visibleBars) {
        if (bar.low < minPrice) minPrice = bar.low;
        if (bar.high > maxPrice) maxPrice = bar.high;
      }
      if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) return;

      const profile = this.profileFor(
        fromSec * 1000,
        toMs,
        minPrice,
        maxPrice,
      );
      if (profile === null) return;

      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        const { bins, bucketHeight, maxVolume, pocPrice, valueAreaLevels } =
          profile;
        const rightEdge =
          mediaSize.width -
          Math.max(0, this.rightInset?.(mediaSize.width) ?? 0);
        context.save();

        if (valueAreaLevels !== null) {
          const vahY = attachedParams.series.priceToCoordinate(
            valueAreaLevels.vah,
          );
          const valY = attachedParams.series.priceToCoordinate(
            valueAreaLevels.val,
          );
          // Both run to the profile's right edge, under the bins, so the
          // profile's silhouette stays unbroken wherever it is thick.
          if (vahY !== null) {
            drawLevelLine(
              context,
              vahY,
              rightEdge,
              this.settings.vahColor,
              this.settings.vahLineStyle,
              this.settings.vahValLineWidth,
              VALUE_AREA_ALPHA,
            );
          }
          if (valY !== null) {
            drawLevelLine(
              context,
              valY,
              rightEdge,
              this.settings.valColor,
              this.settings.valLineStyle,
              this.settings.vahValLineWidth,
              VALUE_AREA_ALPHA,
            );
          }
          // The bins inherit the canvas state, so undo the line styling first.
          context.setLineDash([]);
          context.globalAlpha = 1;
        }

        for (const bin of bins) {
          if (bin.totalVolume <= 0) continue;

          const yTopEdge = attachedParams.series.priceToCoordinate(
            bin.price + bucketHeight / 2,
          );
          const yBottomEdge = attachedParams.series.priceToCoordinate(
            bin.price - bucketHeight / 2,
          );
          if (yTopEdge === null || yBottomEdge === null) continue;
          // Snap both edges to whole pixels. Neighbouring bands share a boundary
          // price, so rounding it once for both leaves no antialiased seam and
          // no gap between the bars.
          const barTop = Math.round(Math.min(yTopEdge, yBottomEdge));
          const barHeight = Math.max(
            1,
            Math.round(Math.max(yTopEdge, yBottomEdge)) - barTop,
          );

          const volumeRatio = Math.min(1, bin.totalVolume / maxVolume);
          const opacity =
            this.settings.minOpacity +
            (this.settings.maxOpacity - this.settings.minOpacity) * volumeRatio;

          // Total volume bar, anchored at the right edge and growing left.
          const totalWidth =
            (bin.totalVolume / maxVolume) * this.settings.profileWidth;
          const xStart = rightEdge - totalWidth;

          context.fillStyle = withOpacity(this.settings.buyColor, opacity);
          context.fillRect(xStart, barTop, totalWidth, barHeight);

          // Sell volume nested inside the total bar, on the same scale, anchored
          // at the bar's left edge so it always sits within the total.
          const sellWidth =
            (bin.sellVolume / maxVolume) * this.settings.profileWidth;
          if (sellWidth > 0) {
            context.fillStyle = withOpacity(this.settings.sellColor, opacity);
            context.fillRect(
              xStart,
              barTop,
              Math.min(sellWidth, totalWidth),
              barHeight,
            );
          }

          if (this.settings.binVolumeVisible && totalWidth > 0) {
            // Ink is picked against whichever colour covers most of the bar.
            const dominantColor =
              sellWidth > totalWidth / 2
                ? this.settings.sellColor
                : this.settings.buyColor;
            drawBinValue(
              context,
              // The helper keeps its own padding, so the box is let out by a pixel
              // each way: text then fits any bar a font of at least 7px fits in.
              {
                x1: xStart,
                x2: rightEdge,
                yTop: barTop - 1,
                yBottom: barTop + barHeight + 1,
              },
              formatLabelVolume(bin.totalVolume),
              withOpacity(dominantColor, opacity),
              "right",
            );
          }

          // Bin border, drawn last so it rings the whole bar, buy and sell
          // portions alike. Its opacity is the user's own rather than the volume
          // ramp: the border is a grid line between bins, not a reading. Offsets
          // by half a pixel keep a one-pixel stroke crisp on pixel boundaries.
          if (
            this.settings.binBorderVisible &&
            this.settings.binBorderOpacity > 0 &&
            totalWidth > 0
          ) {
            context.strokeStyle = withOpacity(
              this.settings.binBorderColor,
              this.settings.binBorderOpacity,
            );
            context.lineWidth = 1;
            context.strokeRect(
              Math.round(xStart) + 0.5,
              barTop + 0.5,
              Math.max(0, Math.round(totalWidth) - 1),
              Math.max(0, barHeight - 1),
            );
          }
        }

        if (this.settings.pocVisible && bins.length > 0) {
          const pocY = attachedParams.series.priceToCoordinate(pocPrice);
          if (pocY !== null) {
            // Painted last so it stays readable over the profile, and stopping
            // where the profile starts rather than crossing it.
            drawLevelLine(
              context,
              pocY,
              rightEdge - this.settings.profileWidth,
              this.settings.pocColor,
              this.settings.pocLineStyle,
              this.settings.pocLineWidth,
              1,
            );
          }
        }

        context.setLineDash([]);
        context.globalAlpha = 1;
        // On a historical chart the rows are the candles' volume spread over
        // each candle's range, not executed trades: say so where it is drawn.
        if (this.source?.estimated === true) {
          drawStatusBadge(
            context,
            STATUS_BADGE_SLOT.volumeProfileTickEstimate,
            TICK_PROFILE_ESTIMATE_BADGE,
          );
        }
        context.restore();
      });
    },
  };

  private readonly paneView: IPrimitivePaneView = {
    renderer: () => this.renderer,
  };

  /**
   * What a built profile's shape is made of: the window the visible bars put on
   * screen, the price domain they give it, and the settings. `draw()` runs on
   * every repaint -- a crosshair move or a scroll frame included -- so the
   * profile is kept between paints and this, with the source's version, is
   * what decides whether it can be.
   */
  private fingerprint(
    fromMs: number,
    toMs: number,
    minPrice: number,
    maxPrice: number,
  ): string {
    return [
      fromMs,
      toMs,
      minPrice,
      maxPrice,
      this.settingsRevision,
    ].join(":");
  }

  /**
   * Build the profile for a window and price domain, or null when there is
   * nothing to show. This is the expensive half: it reads every row the source
   * holds, bins the flow and resolves the value area.
   */
  private buildProfile(
    fromMs: number,
    minPrice: number,
    maxPrice: number,
  ): TickProfileFrame | null {
    const source = this.source;
    if (source === null) return null;

    // The source's own trades over its window, binned into the visible price domain.
    const { levels, coveredFromMs } = collectTickFlow(source);
    const { bins, bucketHeight } = calculateTickDeltaProfileBins(
      levels,
      source.rowWidth,
      minPrice,
      maxPrice,
      this.settings.binCount,
      this.settings.fixedRowCount,
    );
    if (bins.length === 0) return null;

    // Blend neighbouring rows, the way Volume Profile's buckets are smoothed,
    // so the silhouette is not one sharp step per source row.
    smoothTickProfileBins(bins);

    const maxVolume = Math.max(0, ...bins.map((b) => b.totalVolume));
    if (maxVolume <= 0) return null;

    // The POC and the value area are read off the bars the trader sees, never off
    // the rows as they were before the blend: a narrow spike gives half its height
    // to its neighbours, so a broader, lower bulge can be drawn taller than it, and
    // a line placed on the pre-blend row would sit beside the bulge it names.
    const pocBin = bins.reduce((max, bin) =>
      bin.totalVolume > max.totalVolume ? bin : max,
    );
    const valueAreaLevels = this.settings.vahValVisible
      ? calculateValueAreaLevels(
          bins,
          bucketHeight,
          this.settings.vahValPercent,
        )
      : null;

    return {
      bins,
      bucketHeight,
      maxVolume,
      pocPrice: pocBin.price,
      valueAreaLevels,
      truncatedFromMs:
        coveredFromMs !== null && coveredFromMs > fromMs ? coveredFromMs : null,
    };
  }

  /** The cached profile for these inputs, or a fresh build when they moved. */
  private profileFor(
    fromMs: number,
    toMs: number,
    minPrice: number,
    maxPrice: number,
  ): TickProfileFrame | null {
    const fingerprint = this.fingerprint(fromMs, toMs, minPrice, maxPrice);
    const version = this.source?.version ?? -1;
    const now = Date.now();
    const cached = this.profile;
    if (cached !== null && cached.fingerprint === fingerprint) {
      // Only new trades since the build: keep it until the interval is up, and
      // owe one repaint then so the latest prints still land.
      const wait =
        cached.version === version
          ? 0
          : cached.builtAt + TICK_PROFILE_LIVE_REBUILD_MS - now;
      if (cached.version === version || wait > 0) {
        if (wait > 0) this.scheduleRepaint(wait);
        this.reportTruncatedFrom(cached.frame.truncatedFromMs);
        return cached.frame;
      }
    }
    const frame = this.buildProfile(fromMs, minPrice, maxPrice);
    this.profile =
      frame === null ? null : { fingerprint, version, builtAt: now, frame };
    this.reportTruncatedFrom(frame?.truncatedFromMs ?? null);
    return frame;
  }

  /** Say it once per change: the panel holds this as state, and a repaint is not a change. */
  private reportTruncatedFrom(fromMs: number | null): void {
    if (fromMs === this.reportedTruncatedFromMs) return;
    this.reportedTruncatedFromMs = fromMs;
    this.onTruncatedFromChange?.(fromMs);
  }

  attached(params: SeriesAttachedParameter<Time>): void {
    this.attachedParams = params;
  }

  detached(): void {
    this.attachedParams = null;
    if (this.repaintTimer !== null) clearTimeout(this.repaintTimer);
    this.repaintTimer = null;
  }

  private scheduleRepaint(delayMs: number): void {
    if (this.repaintTimer !== null) return;
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null;
      this.attachedParams?.requestUpdate();
    }, delayMs);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.paneView];
  }

  update(
    bars: readonly BarFrame[],
    source: DeltaSource | null,
  ): void {
    // A different source is a different profile, whatever its version says: the
    // store is replaced on a pair change, and on a historical chart the candles
    // take its place.
    if (source !== this.source) this.profile = null;
    this.bars = bars;
    this.source = source;
    // Hidden, so there is no profile to qualify.
    if (bars.length === 0) this.reportTruncatedFrom(null);
    this.attachedParams?.requestUpdate();
  }

  setRightInset(inset: ((paneWidth: number) => number) | null): void {
    this.rightInset = inset;
    this.attachedParams?.requestUpdate();
  }

  updateSettings(settings: VolumeDeltaProfileTickSettings): void {
    // Saved settings from an older build can lack the border keys, and a
    // missing colour would reach `withOpacity` as undefined.
    this.settings = normalizeVolumeDeltaProfileTickSettings(settings);
    this.settingsRevision += 1;
    this.attachedParams?.requestUpdate();
  }

  /** The source mutates in place; its version bump asks for a repaint. */
  refresh(): void {
    this.attachedParams?.requestUpdate();
  }
}
