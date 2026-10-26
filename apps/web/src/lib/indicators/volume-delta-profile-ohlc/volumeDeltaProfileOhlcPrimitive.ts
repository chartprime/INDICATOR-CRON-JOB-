import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { BarFrame } from "../../../types/frames";
import {
  calculateVolumeDeltaProfileBins,
  calculateValueAreaLevels,
} from "./volumeDeltaProfileOhlc";
import {
  type VolumeDeltaProfileOhlcSettings,
  DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS,
} from "./volumeDeltaProfileOhlcSettings";

/**
 * Convert hex color to rgba with opacity.
 */
function withOpacity(hexColor: string, opacity: number): string {
  // Remove # if present
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

export class VolumeDeltaProfileOhlcPrimitive implements ISeriesPrimitive<Time> {
  private bars: readonly BarFrame[] = [];
  private attachedParams: SeriesAttachedParameter<Time> | null = null;
  private settings: VolumeDeltaProfileOhlcSettings =
    DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS;

  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) => {
      const attachedParams = this.attachedParams;
      if (!attachedParams || this.bars.length === 0) return;

      // Get visible time range from chart
      const visibleRange = attachedParams.chart.timeScale().getVisibleRange();
      if (!visibleRange) return;

      // Filter bars to only those in the visible range
      const visibleBars = this.bars.filter((bar) => {
        const barTime = (bar.ts_open / 1000) as any; // Convert ms to seconds (chart time)
        return barTime >= visibleRange.from && barTime <= visibleRange.to;
      });

      if (visibleBars.length === 0) return;

      // Calculate volume delta profile bins from visible bars
      const result = calculateVolumeDeltaProfileBins(
        visibleBars,
        this.settings.binCount,
      );
      const { bins, bucketHeight } = result;
      if (bins.length === 0) return;

      // Find max volume for scaling
      const maxVolume = Math.max(0, ...bins.map((b) => b.totalVolume));
      if (maxVolume <= 0) return;

      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.save();

        for (const bin of bins) {
          if (bin.totalVolume <= 0) continue;

          // Convert price to Y coordinate
          const y = attachedParams.series.priceToCoordinate(bin.price);
          if (y === null) continue;

          // Calculate pixel height based on bucket height
          const yTop = attachedParams.series.priceToCoordinate(
            bin.price + bucketHeight / 2,
          );
          const yBottom = attachedParams.series.priceToCoordinate(
            bin.price - bucketHeight / 2,
          );
          let barHeight = 1;
          if (yTop !== null && yBottom !== null) {
            barHeight = Math.max(1, Math.abs(yBottom - yTop));
          }

          // Calculate opacity based on volume ratio (longer/more volume = more intense)
          const volumeRatio = Math.min(1, bin.totalVolume / maxVolume);
          const opacity =
            this.settings.minOpacity +
            (this.settings.maxOpacity - this.settings.minOpacity) * volumeRatio;

          // Total width based on volume
          const totalWidth =
            (bin.totalVolume / maxVolume) * this.settings.profileWidth;
          const buyWidth =
            (bin.buyVolume / maxVolume) * this.settings.profileWidth;
          const sellWidth =
            (bin.sellVolume / maxVolume) * this.settings.profileWidth;

          // Draw sell volume (red, left)
          if (sellWidth > 0) {
            context.fillStyle = withOpacity(this.settings.sellColor, opacity);
            context.fillRect(
              mediaSize.width - totalWidth,
              y - barHeight / 2,
              sellWidth,
              barHeight,
            );
          }

          // Draw buy volume (green, right)
          if (buyWidth > 0) {
            context.fillStyle = withOpacity(this.settings.buyColor, opacity);
            context.fillRect(
              mediaSize.width - totalWidth + sellWidth,
              y - barHeight / 2,
              buyWidth,
              barHeight,
            );
          }

          // Border
          context.strokeStyle = withOpacity(
            this.settings.borderColor,
            opacity * 0.5,
          );
          context.lineWidth = 1;
          context.strokeRect(
            mediaSize.width - totalWidth,
            y - barHeight / 2,
            totalWidth,
            barHeight,
          );
        }

        // Draw POC line if enabled
        if (this.settings.pocVisible && bins.length > 0) {
          const pocBin = bins.reduce((max, bin) =>
            bin.totalVolume > max.totalVolume ? bin : max,
          );
          const pocY = attachedParams.series.priceToCoordinate(pocBin.price);
          if (pocY !== null) {
            setLineStyle(context, this.settings.pocLineStyle);
            context.strokeStyle = this.settings.pocColor;
            context.lineWidth = 2;
            context.beginPath();
            context.moveTo(0, pocY);
            context.lineTo(mediaSize.width - this.settings.profileWidth, pocY);
            context.stroke();
          }
        }

        // Draw VAH/VAL levels if enabled
        if (this.settings.vahValVisible && bins.length > 0) {
          const valueAreaLevels = calculateValueAreaLevels(
            bins,
            bucketHeight,
            this.settings.vahValPercent,
          );
          if (valueAreaLevels) {
            // The levels are a property of the whole visible range, so both run to
            // the pane's right edge rather than stopping at the profile's own
            // width: the silhouette stays unbroken wherever it is thick.
            //
            // VAH (Value Area High)
            const vahY = attachedParams.series.priceToCoordinate(
              valueAreaLevels.vah,
            );
            if (vahY !== null) {
              setLineStyle(context, this.settings.vahLineStyle);
              context.strokeStyle = this.settings.vahColor;
              context.lineWidth = this.settings.vahValLineWidth;
              context.globalAlpha = 0.7;
              context.beginPath();
              context.moveTo(0, vahY);
              context.lineTo(mediaSize.width, vahY);
              context.stroke();
            }

            // VAL (Value Area Low)
            const valY = attachedParams.series.priceToCoordinate(
              valueAreaLevels.val,
            );
            if (valY !== null) {
              setLineStyle(context, this.settings.valLineStyle);
              context.strokeStyle = this.settings.valColor;
              context.lineWidth = this.settings.vahValLineWidth;
              context.globalAlpha = 0.7;
              context.beginPath();
              context.moveTo(0, valY);
              context.lineTo(mediaSize.width, valY);
              context.stroke();
            }
          }
        }

        context.setLineDash([]);
        context.globalAlpha = 1;
        context.restore();
      });
    },
  };

  private readonly paneView: IPrimitivePaneView = {
    renderer: () => this.renderer,
  };

  attached(params: SeriesAttachedParameter<Time>): void {
    this.attachedParams = params;
  }

  detached(): void {
    this.attachedParams = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.paneView];
  }

  update(bars: readonly BarFrame[]): void {
    this.bars = bars;
    this.attachedParams?.requestUpdate();
  }

  updateSettings(settings: VolumeDeltaProfileOhlcSettings): void {
    this.settings = settings;
    this.attachedParams?.requestUpdate();
  }
}
