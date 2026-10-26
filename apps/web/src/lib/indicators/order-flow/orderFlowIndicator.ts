import type { RuntimeIndicatorDef, SettingsFieldSchema } from "../../chart/indicatorTypes";
import type { OrderFlowDisplayMode } from "./cvdCandles";

export interface OrderFlowIndicatorSettings {
  displayMode: OrderFlowDisplayMode;
}

export const DEFAULT_ORDER_FLOW_INDICATOR_SETTINGS: OrderFlowIndicatorSettings = {
  displayMode: "line",
};

const ORDER_FLOW_SETTINGS_SCHEMA: readonly SettingsFieldSchema<OrderFlowIndicatorSettings>[] = [
  {
    kind: "radioGroup",
    key: "displayMode",
    label: "CVD display",
    tab: "inputs",
    // Swapping line <-> candles swaps the underlying series type entirely
    // (ISeriesApi<"Line"> vs <"Candlestick">, built from a different
    // derivation -- computeCVDForBars vs computeCvdCandles), not just a
    // color/style change -- the "structural", not "cosmetic", reading of
    // TA.01's own affects distinction.
    affects: "recompute",
    options: [
      { value: "line", label: "Line", hint: "The cumulative total as one continuous line." },
      {
        value: "candles",
        label: "Candles",
        hint: "Open, high, low and close of the cumulative total within each candle, built from 1-minute flow. Shows where delta travelled inside the bar, not just where it ended.",
      },
    ],
  },
];

/**
 * TA.04 -- registers Aggressive Order Flow with the new authoring core to
 * extend SettingsFieldSchema's proof onto a second real settings modal
 * (displayMode + visibility; genuinely as clean a fit as Volume Profile's
 * own settings were). Rendering stays fully external and unchanged
 * (ChartPanel.tsx still owns cvdLineSeriesRef/cvdHistogramSeriesRef/
 * cvdCandleSeriesRef directly) for a concrete, checked reason: the
 * generic per-indicator series creation this SDK builds from `lines`
 * (indicatorRuntime.ts/ChartPanel.tsx) only ever creates `LineSeries` --
 * there is no histogram or candlestick series type in that path at all,
 * and CVD needs a line, a histogram, and a candlestick series
 * simultaneously. `lines: []` here, matching every other indicator in
 * this migration whose rendering could not move. onBar/readOutput are
 * inert -- CVD is computed directly from `bars`/`delta` in
 * ChartPanel.tsx's own recomputeIndicators, never from ctx.bar.
 *
 * One small, disclosed, named behavior drop: the bespoke modal's own
 * conditional hint ("On the 1-minute timeframe there is no finer data to
 * build a path from...") depends on `intervalMs`, which is chart state,
 * not part of this indicator's own settings object -- SettingsFieldSchema's
 * `visibleIf` only ever sees `settings`, with no path to external chart
 * context. Dropped rather than adding a way to inject arbitrary extra
 * context into a schema field, which nothing else needs.
 */
export const orderFlowIndicator: RuntimeIndicatorDef<Record<string, never>, OrderFlowIndicatorSettings> = {
  kind: "runtime",
  id: "orderFlow",
  label: "Aggressive Order Flow",
  category: "l1",
  defaultSettings: DEFAULT_ORDER_FLOW_INDICATOR_SETTINGS,
  settingsSchema: ORDER_FLOW_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  createState: () => ({}),
  onBar: () => {},
  readOutput: () => ({}),
};
