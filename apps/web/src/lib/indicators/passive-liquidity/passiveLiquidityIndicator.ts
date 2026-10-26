import type { LegacyIndicatorDef } from "../../chart/indicatorTypes";

/**
 * The Passive Liquidity Heatmap's entry in the indicator registry.
 *
 * It is a `legacy` definition, not a runtime one: the indicator does not
 * produce a line per bar from the chart's own series. It draws the server's
 * resting-liquidity columns straight onto the pane through a lightweight-charts
 * primitive, keeps its own settings dialog, and answers its own tooltip, all of
 * which live in this folder and are wired up by ChartPanel and MainPanel. The
 * registry entry exists so the indicator has an id, a label and a category, and
 * so the menu and the favourites list know about it.
 */
export const passiveLiquidityIndicator: LegacyIndicatorDef = {
  kind: "legacy",
  id: "passiveLiquidity",
  label: "Passive Liquidity Heatmap",
  category: "l2",
};
