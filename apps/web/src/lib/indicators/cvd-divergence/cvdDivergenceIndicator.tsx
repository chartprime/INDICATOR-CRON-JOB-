import type {
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import type { OrderFlowDisplayMode } from "../order-flow/cvdCandles";
import {
  DEFAULT_CVD_CUMULATIVE_MAX_PIVOT_DISTANCE,
  DEFAULT_CVD_MAX_PIVOT_DISTANCE,
  DEFAULT_CVD_MIN_PIVOT_DISTANCE,
  DEFAULT_CVD_PERIOD,
  DEFAULT_CVD_PIVOT_PERIODS,
  DEFAULT_CVD_SMA_LENGTH,
  MAX_CVD_PERIOD,
  MAX_CVD_PIVOT_DISTANCE,
  MAX_CVD_PIVOT_PERIODS,
  MAX_CVD_SMA_LENGTH,
  MIN_CVD_PERIOD,
  MIN_CVD_PIVOT_DISTANCE,
  MIN_CVD_PIVOT_PERIODS,
  MIN_CVD_SMA_LENGTH,
  type PivotDistanceRange,
} from "./cvdDivergence";
import { CvdTrendFilterField } from "./CvdTrendFilterField";

export interface CvdDivergenceIndicatorSettings {
  period: number;
  pivotPeriods: number;
  pivotsOnPrice: boolean;
  minPivotDistance: number;
  maxPivotDistance: number;
  showLabels: boolean;
  showCumulativeCvd: boolean;
  cumulativeCvdDisplayMode: OrderFlowDisplayMode;
  showCumulativeDivergences: boolean;
  cumulativeMinPivotDistance: number;
  cumulativeMaxPivotDistance: number;
  oscillatorTrendFilterEnabled: boolean;
  oscillatorTrendFilterSmaLength: number;
  oscillatorTrendFilterInverted: boolean;
  cumulativeTrendFilterEnabled: boolean;
  cumulativeTrendFilterSmaLength: number;
  cumulativeTrendFilterInverted: boolean;
}

export const DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS: CvdDivergenceIndicatorSettings =
  {
    period: DEFAULT_CVD_PERIOD,
    pivotPeriods: DEFAULT_CVD_PIVOT_PERIODS,
    pivotsOnPrice: false,
    minPivotDistance: DEFAULT_CVD_MIN_PIVOT_DISTANCE,
    maxPivotDistance: DEFAULT_CVD_MAX_PIVOT_DISTANCE,
    showLabels: true,
    showCumulativeCvd: false,
    cumulativeCvdDisplayMode: "line",
    showCumulativeDivergences: false,
    cumulativeMinPivotDistance: DEFAULT_CVD_MIN_PIVOT_DISTANCE,
    cumulativeMaxPivotDistance: DEFAULT_CVD_CUMULATIVE_MAX_PIVOT_DISTANCE,
    oscillatorTrendFilterEnabled: false,
    oscillatorTrendFilterSmaLength: DEFAULT_CVD_SMA_LENGTH,
    oscillatorTrendFilterInverted: false,
    cumulativeTrendFilterEnabled: false,
    cumulativeTrendFilterSmaLength: DEFAULT_CVD_SMA_LENGTH,
    cumulativeTrendFilterInverted: true,
  };

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

export function normalizedPivotDistance(
  settings: Pick<
    CvdDivergenceIndicatorSettings,
    "minPivotDistance" | "maxPivotDistance"
  >,
): PivotDistanceRange {
  const a = clamp(
    settings.minPivotDistance,
    MIN_CVD_PIVOT_DISTANCE,
    MAX_CVD_PIVOT_DISTANCE,
  );
  const b = clamp(
    settings.maxPivotDistance,
    MIN_CVD_PIVOT_DISTANCE,
    MAX_CVD_PIVOT_DISTANCE,
  );
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

export function normalizedCumulativePivotDistance(
  settings: Pick<
    CvdDivergenceIndicatorSettings,
    "cumulativeMinPivotDistance" | "cumulativeMaxPivotDistance"
  >,
): PivotDistanceRange {
  const a = clamp(
    settings.cumulativeMinPivotDistance,
    MIN_CVD_PIVOT_DISTANCE,
    MAX_CVD_PIVOT_DISTANCE,
  );
  const b = clamp(
    settings.cumulativeMaxPivotDistance,
    MIN_CVD_PIVOT_DISTANCE,
    MAX_CVD_PIVOT_DISTANCE,
  );
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

const CVD_DIVERGENCE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<CvdDivergenceIndicatorSettings>[] =
  [
    {
      kind: "slider",
      key: "period",
      clampOnRestore: true,
      label: "CVD period",
      tab: "inputs",
      min: MIN_CVD_PERIOD,
      max: MAX_CVD_PERIOD,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "slider",
      key: "pivotPeriods",
      label: "Divergence fractal periods",
      tab: "inputs",
      min: MIN_CVD_PIVOT_PERIODS,
      max: MAX_CVD_PIVOT_PERIODS,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "boolean",
      key: "pivotsOnPrice",
      label: "Detect pivots on price",
      tab: "inputs",
      affects: "recompute",
    },
    {
      kind: "slider",
      key: "minPivotDistance",
      clampOnRestore: true,
      label: "Min bars between pivots",
      tab: "inputs",
      min: MIN_CVD_PIVOT_DISTANCE,
      max: MAX_CVD_PIVOT_DISTANCE,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "slider",
      key: "maxPivotDistance",
      clampOnRestore: true,
      label: "Max bars between pivots",
      tab: "inputs",
      min: MIN_CVD_PIVOT_DISTANCE,
      max: MAX_CVD_PIVOT_DISTANCE,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "boolean",
      key: "showLabels",
      label: "Show divergence labels",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "boolean",
      key: "showCumulativeCvd",
      label: "Overlay cumulative CVD",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "radioGroup",
      key: "cumulativeCvdDisplayMode",
      label: "Cumulative CVD display",
      tab: "inputs",
      affects: "recompute",
      options: [
        {
          value: "line",
          label: "Line",
          hint: "The running total as one continuous line.",
        },
        {
          value: "candles",
          label: "Candles",
          hint: "Open, high, low and close of the running total within each chart bar, built from 1-minute flow. Needs 1-minute source bars; without them nothing is drawn.",
        },
      ],
    },
    {
      kind: "boolean",
      key: "showCumulativeDivergences",
      label: "Divergences on cumulative CVD",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "slider",
      key: "cumulativeMinPivotDistance",
      clampOnRestore: true,
      label: "Min bars between cum. CVD pivots",
      tab: "inputs",
      min: MIN_CVD_PIVOT_DISTANCE,
      max: MAX_CVD_PIVOT_DISTANCE,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "slider",
      key: "cumulativeMaxPivotDistance",
      clampOnRestore: true,
      label: "Max bars between cum. CVD pivots",
      tab: "inputs",
      min: MIN_CVD_PIVOT_DISTANCE,
      max: MAX_CVD_PIVOT_DISTANCE,
      step: 1,
      affects: "recompute",
    },
    {
      kind: "custom",
      affects: "recompute",
      render: (settings, onChange) => (
        <CvdTrendFilterField
          label="Filter oscillator"
          enabled={settings.oscillatorTrendFilterEnabled}
          smaLength={settings.oscillatorTrendFilterSmaLength}
          inverted={settings.oscillatorTrendFilterInverted}
          onEnabledChange={(value) =>
            onChange({ ...settings, oscillatorTrendFilterEnabled: value })
          }
          onSmaLengthChange={(value) =>
            onChange({ ...settings, oscillatorTrendFilterSmaLength: value })
          }
          onInvertedChange={(value) =>
            onChange({ ...settings, oscillatorTrendFilterInverted: value })
          }
        />
      ),
    },
    {
      kind: "custom",
      affects: "recompute",
      render: (settings, onChange) => (
        <CvdTrendFilterField
          label="Filter cumulative"
          enabled={settings.cumulativeTrendFilterEnabled}
          smaLength={settings.cumulativeTrendFilterSmaLength}
          inverted={settings.cumulativeTrendFilterInverted}
          onEnabledChange={(value) =>
            onChange({ ...settings, cumulativeTrendFilterEnabled: value })
          }
          onSmaLengthChange={(value) =>
            onChange({ ...settings, cumulativeTrendFilterSmaLength: value })
          }
          onInvertedChange={(value) =>
            onChange({ ...settings, cumulativeTrendFilterInverted: value })
          }
        />
      ),
    },
    ...(["oscillator", "cumulative"] as const).flatMap(
      (series): SettingsFieldSchema<CvdDivergenceIndicatorSettings>[] => [
        {
          kind: "boolean",
          key: `${series}TrendFilterEnabled`,
          label: "",
          visibleIf: () => false,
          affects: "recompute",
        },
        {
          kind: "slider",
          key: `${series}TrendFilterSmaLength`,
          clampOnRestore: true,
          label: "",
          min: MIN_CVD_SMA_LENGTH,
          max: MAX_CVD_SMA_LENGTH,
          step: 1,
          visibleIf: () => false,
          affects: "recompute",
        },
        {
          kind: "boolean",
          key: `${series}TrendFilterInverted`,
          label: "",
          visibleIf: () => false,
          affects: "recompute",
        },
      ],
    ),
    {
      kind: "staticHint",
      text: "By default pivots are found on the CVD series and compared with the price close at those bars. With Detect pivots on price, pivots are found on the price close instead and the CVD is only checked for direction between them: falling CVD against a higher price high is bearish, rising CVD against a lower price low is bullish. The CVD pivots are not required, and the above/below-zero requirement is dropped. Applies to both the oscillator and the cumulative CVD.",
    },
    {
      kind: "staticHint",
      text: "Each trend filter averages its series with a simple moving average and admits only divergences that agree with it. By default that means bullish while the series is above the average and bearish while below; the Inverse switch reads it the other way round, bullish below and bearish above. The test is applied at the bar that CONFIRMED the divergence, since that is the bar acted on. Bars whose average is still warming up are admitted rather than suppressed.",
    },
    {
      kind: "staticHint",
      text: "The oscillator is a rolling sum of per-bar taker delta (exchange-classified buy minus sell volume), so it restarts after a real hole in the data -- missing bars or an outage, never a scheduled market close -- and briefly has no value until the window refills. Divergences are marked DiV+ (bullish) and DiV- (bearish) on the price chart, at the bar that confirmed them -- so the newest one appears only once its own fractal is complete.",
    },
    {
      kind: "staticHint",
      text: "The cumulative CVD overlay is the same running total Aggressive Order Flow draws, borrowed for reference. It runs on its own price scale because its magnitude is far larger than the rolling oscillator's, so the two shapes are comparable even though the numbers are not.",
    },
  ];

export const cvdDivergenceIndicator: RuntimeIndicatorDef<
  Record<string, never>,
  CvdDivergenceIndicatorSettings
> = {
  kind: "runtime",
  id: "cvdDivergence",
  label: "CVD Divergence",
  category: "l1",
  defaultSettings: DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
  settingsSchema: CVD_DIVERGENCE_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  createState: () => ({}),
  onBar: () => {},
  readOutput: () => ({}),
};
