import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
} from "lightweight-charts";
import type { BarFrame } from "../../../types/frames";
import {
  toCvdCandlestickData,
  toLineData,
  toTonedHistogramData,
} from "../../chart/chartData";
import { DeltaDivergencePrimitive } from "../delta-divergence/deltaDivergencePrimitive";
import { computeCvdCandles } from "../order-flow/cvdCandles";
import { computeCVDForBars, computeDeltaPerBar } from "../order-flow/orderFlow";
import {
  CVD_TONE_COLORS,
  cvdToneColorsFor,
  detectCumulativeCvdDivergences,
  detectCvdDivergences,
  rollingDeltaSeries,
  smaForSeries,
} from "./cvdDivergence";
import {
  normalizedCumulativePivotDistance,
  normalizedPivotDistance,
  type CvdDivergenceIndicatorSettings,
} from "./cvdDivergenceIndicator";
import { CvdDivergenceLabelsPrimitive } from "./cvdDivergenceLabelsPrimitive";

const CUMULATIVE_PRICE_SCALE_ID = "cvd-divergence-cumulative";
const TREND_AVERAGE_COLOR = "#f59e0b";
const INDICATOR_LINE_WIDTH = 2;

const CVD_UP_COLOR = "#16a34a";
const CVD_DOWN_COLOR = "#dc2626";
const LIGHT_CVD_ZERO_LINE = "rgba(10, 10, 10, 0.55)";
const LIGHT_CVD_LINE = "#111111";
const DARK_CVD_ZERO_LINE = "rgba(250, 250, 247, 0.32)";
const DARK_CVD_LINE = "#facc15";

export interface CvdDivergenceRendererOptions {
  chart: IChartApi;
  priceSeries: ISeriesApi<"Candlestick">;
  dark: boolean;
}

export class CvdDivergenceRenderer {
  private readonly _chart: IChartApi;
  private readonly _priceSeries: ISeriesApi<"Candlestick">;
  private readonly _dark: boolean;

  private _histogram: ISeriesApi<"Histogram"> | null = null;
  private _lines: DeltaDivergencePrimitive | null = null;
  private _labels: CvdDivergenceLabelsPrimitive | null = null;
  private _trendAverage: ISeriesApi<"Line"> | null = null;
  private _cumulativeLine: ISeriesApi<"Line"> | null = null;
  private _cumulativeCandle: ISeriesApi<"Candlestick"> | null = null;
  private _cumulativeLines: DeltaDivergencePrimitive | null = null;
  private _cumulativeHost: ISeriesApi<SeriesType> | null = null;
  private _cumulativeLabels: CvdDivergenceLabelsPrimitive | null = null;
  private _cumulativeTrendAverage: ISeriesApi<"Line"> | null = null;

  constructor(options: CvdDivergenceRendererOptions) {
    this._chart = options.chart;
    this._priceSeries = options.priceSeries;
    this._dark = options.dark;
  }

  get attached(): boolean {
    return this._histogram !== null;
  }

  attach(settings: CvdDivergenceIndicatorSettings): void {
    if (this._histogram !== null) return;

    const histogram = this._chart.addSeries(
      HistogramSeries,
      {
        color: CVD_UP_COLOR,
        priceLineVisible: false,
        lastValueVisible: false,
      },
      this._chart.panes().length,
    );
    histogram.createPriceLine({
      price: 0,
      color: this._dark ? DARK_CVD_ZERO_LINE : LIGHT_CVD_ZERO_LINE,
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
    });
    this._histogram = histogram;

    const lines = newCvdSegments();
    lines.setBandsVisible(false);
    histogram.attachPrimitive(lines);
    this._lines = lines;

    const labels = new CvdDivergenceLabelsPrimitive();
    this._priceSeries.attachPrimitive(labels);
    this._labels = labels;

    const paneIndex = histogram.getPane().paneIndex();
    const cumulativeIsCandles = settings.cumulativeCvdDisplayMode === "candles";
    this._cumulativeLine = this._chart.addSeries(
      LineSeries,
      {
        color: this._dark ? DARK_CVD_LINE : LIGHT_CVD_LINE,
        lineWidth: INDICATOR_LINE_WIDTH,
        priceScaleId: CUMULATIVE_PRICE_SCALE_ID,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: !cumulativeIsCandles,
      },
      paneIndex,
    );
    this._cumulativeCandle = this._chart.addSeries(
      CandlestickSeries,
      {
        upColor: CVD_UP_COLOR,
        downColor: CVD_DOWN_COLOR,
        borderUpColor: CVD_UP_COLOR,
        borderDownColor: CVD_DOWN_COLOR,
        wickUpColor: CVD_UP_COLOR,
        wickDownColor: CVD_DOWN_COLOR,
        priceScaleId: CUMULATIVE_PRICE_SCALE_ID,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: settings.showCumulativeCvd && cumulativeIsCandles,
      },
      paneIndex,
    );

    const cumulativeLabels = new CvdDivergenceLabelsPrimitive("cumulative");
    this._priceSeries.attachPrimitive(cumulativeLabels);
    this._cumulativeLabels = cumulativeLabels;

    this._trendAverage = this._chart.addSeries(
      LineSeries,
      {
        color: TREND_AVERAGE_COLOR,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      },
      paneIndex,
    );
    this._cumulativeTrendAverage = this._chart.addSeries(
      LineSeries,
      {
        color: TREND_AVERAGE_COLOR,
        lineWidth: 1,
        priceScaleId: CUMULATIVE_PRICE_SCALE_ID,
        priceLineVisible: false,
        lastValueVisible: false,
      },
      paneIndex,
    );
  }

  detach(): void {
    this._detachCumulativeSegments();
    if (this._histogram !== null && this._lines !== null) {
      this._histogram.detachPrimitive(this._lines);
    }
    if (this._labels !== null) {
      this._priceSeries.detachPrimitive(this._labels);
    }
    if (this._cumulativeLabels !== null) {
      this._priceSeries.detachPrimitive(this._cumulativeLabels);
    }
    for (const series of [
      this._cumulativeLine,
      this._cumulativeCandle,
      this._trendAverage,
      this._cumulativeTrendAverage,
      this._histogram,
    ]) {
      if (series !== null) this._chart.removeSeries(series);
    }
    this._histogram = null;
    this._lines = null;
    this._labels = null;
    this._trendAverage = null;
    this._cumulativeLine = null;
    this._cumulativeCandle = null;
    this._cumulativeLines = null;
    this._cumulativeLabels = null;
    this._cumulativeTrendAverage = null;
  }

  render(
    bars: readonly BarFrame[],
    settings: CvdDivergenceIndicatorSettings,
    shown: boolean,
    rawMinuteBars: readonly BarFrame[],
  ): void {
    const histogram = this._histogram;
    if (histogram === null) return;
    const lines = this._lines;
    const labels = this._labels;
    const trendAverage = this._trendAverage;
    const cumulativeLine = this._cumulativeLine;
    const cumulativeCandle = this._cumulativeCandle;
    const cumulativeLines = this._cumulativeLines;
    const cumulativeLabels = this._cumulativeLabels;
    const cumulativeTrendAverage = this._cumulativeTrendAverage;

    const { period, pivotPeriods, minPivotDistance, maxPivotDistance } =
      settings;

    let oscillatorAverage: (number | null)[] | undefined;
    if (shown) {
      const oscillator = rollingDeltaSeries(bars, period);
      oscillatorAverage = settings.oscillatorTrendFilterEnabled
        ? smaForSeries(oscillator, settings.oscillatorTrendFilterSmaLength)
        : undefined;
      if (trendAverage !== null) {
        trendAverage.setData(
          oscillatorAverage ? toLineData(bars, oscillatorAverage) : [],
        );
        trendAverage.applyOptions({ visible: oscillatorAverage !== undefined });
      }
      const toneColors = cvdToneColorsFor(oscillator);
      histogram.setData(
        toTonedHistogramData(
          bars,
          oscillator,
          (index) => toneColors[index],
          "none",
        ),
      );
      const divergences = detectCvdDivergences(
        bars,
        oscillator,
        pivotPeriods,
        normalizedPivotDistance({ minPivotDistance, maxPivotDistance }),
        {
          requireZeroSide: true,
          pivotSource: settings.pivotsOnPrice ? "price" : "cvd",
          trendAverage: oscillatorAverage,
          trendInverted: settings.oscillatorTrendFilterInverted,
        },
      );
      lines?.setDivergences(divergences);
      labels?.setDivergences(divergences, bars);
    } else {
      histogram.setData([]);
      trendAverage?.setData([]);
      lines?.setDivergences([]);
      labels?.setDivergences([], []);
    }
    labels?.setLabelsVisible(shown && settings.showLabels);

    const showCumulative = shown && settings.showCumulativeCvd;
    const cumulativeIsCandles = settings.cumulativeCvdDisplayMode === "candles";
    const cumulative = computeCVDForBars(bars, computeDeltaPerBar(bars));
    if (cumulativeLine !== null) {
      cumulativeLine.setData(
        showCumulative && !cumulativeIsCandles
          ? toLineData(bars, cumulative)
          : [],
      );
      cumulativeLine.applyOptions({
        visible: showCumulative && !cumulativeIsCandles,
      });
    }
    if (cumulativeCandle !== null) {
      cumulativeCandle.setData(
        showCumulative && cumulativeIsCandles && bars.length > 0
          ? toCvdCandlestickData(
              bars,
              computeCvdCandles(bars, rawMinuteBars, bars[0].interval_ms),
            )
          : [],
      );
      cumulativeCandle.applyOptions({
        visible: showCumulative && cumulativeIsCandles,
      });
    }

    const showCumulativeMarkers = shown && settings.showCumulativeDivergences;
    if (showCumulativeMarkers) this._syncCumulativeSegmentHost(settings);
    const cumulativeAverage =
      shown && settings.cumulativeTrendFilterEnabled
        ? smaForSeries(cumulative, settings.cumulativeTrendFilterSmaLength)
        : undefined;
    if (cumulativeTrendAverage !== null) {
      cumulativeTrendAverage.setData(
        cumulativeAverage && showCumulative
          ? toLineData(bars, cumulativeAverage)
          : [],
      );
      cumulativeTrendAverage.applyOptions({
        visible: cumulativeAverage !== undefined && showCumulative,
      });
    }
    const cumulativeDivergences = shown
      ? detectCumulativeCvdDivergences(
          bars,
          cumulative,
          pivotPeriods,
          normalizedCumulativePivotDistance(settings),
          cumulativeAverage,
          settings.cumulativeTrendFilterInverted,
          settings.pivotsOnPrice ? "price" : "cvd",
        )
      : [];
    cumulativeLines?.setDivergences(
      showCumulativeMarkers ? cumulativeDivergences : [],
    );
    cumulativeLabels?.setDivergences(
      showCumulativeMarkers ? cumulativeDivergences : [],
      bars,
    );
    cumulativeLabels?.setLabelsVisible(
      showCumulativeMarkers && settings.showLabels,
    );
    if (!showCumulativeMarkers) this._detachCumulativeSegments();
  }

  private _syncCumulativeSegmentHost(
    settings: CvdDivergenceIndicatorSettings,
  ): void {
    const host =
      settings.cumulativeCvdDisplayMode === "candles"
        ? this._cumulativeCandle
        : this._cumulativeLine;
    if (this._cumulativeHost === host && this._cumulativeLines !== null) {
      return;
    }
    this._detachCumulativeSegments();
    if (host === null) return;
    const lines = newCvdSegments();
    lines.setBandsVisible(false);
    host.attachPrimitive(lines);
    this._cumulativeLines = lines;
    this._cumulativeHost = host;
  }

  private _detachCumulativeSegments(): void {
    const host = this._cumulativeHost;
    const lines = this._cumulativeLines;
    if (host !== null && lines !== null) host.detachPrimitive(lines);
    this._cumulativeLines = null;
    this._cumulativeHost = null;
  }
}

function newCvdSegments(): DeltaDivergencePrimitive {
  const lines = new DeltaDivergencePrimitive("cvd");
  lines.setLinePalette({
    bullish: CVD_TONE_COLORS.intenseUp,
    bearish: CVD_TONE_COLORS.intenseDown,
  });
  return lines;
}
