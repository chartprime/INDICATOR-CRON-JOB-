import { INDEX_DEFAULTS, createIndexStyle, type IndexStyleParams } from "./indexLiquidityStyle";

export const TSLA_PARAMS: IndexStyleParams = Object.freeze({
  ...INDEX_DEFAULTS,
  name: "tsla",
  settings: Object.freeze({ clusterRows: 6, quietBands: 16, minBandSize: 2_000, showPulled: true }),
});

export const tslaLiquidityStyle = createIndexStyle(TSLA_PARAMS);
