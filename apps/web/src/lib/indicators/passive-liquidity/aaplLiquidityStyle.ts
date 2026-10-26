import { INDEX_DEFAULTS, createIndexStyle, type IndexStyleParams } from "./indexLiquidityStyle";

export const AAPL_PARAMS: IndexStyleParams = Object.freeze({
  ...INDEX_DEFAULTS,
  name: "aapl",
  settings: Object.freeze({ clusterRows: 8, quietBands: 16, minBandSize: 800, showPulled: true }),
});

export const aaplLiquidityStyle = createIndexStyle(AAPL_PARAMS);
