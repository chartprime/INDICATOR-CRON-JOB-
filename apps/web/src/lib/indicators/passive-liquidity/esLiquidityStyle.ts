import { INDEX_DEFAULTS, createIndexStyle, type IndexStyleParams } from "./indexLiquidityStyle";

export const ES_PARAMS: IndexStyleParams = Object.freeze({
  ...INDEX_DEFAULTS,
  name: "es",
  settings: Object.freeze({ clusterRows: 3, quietBands: 16, minBandSize: 50, showPulled: true }),
  saturationMultiple: 1.5,
  monsterMultiple: 2,
});

export const esLiquidityStyle = createIndexStyle(ES_PARAMS);
