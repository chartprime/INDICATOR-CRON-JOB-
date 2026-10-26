import { INDEX_DEFAULTS, createIndexStyle, type IndexStyleParams } from "./indexLiquidityStyle";

export const NQ_PARAMS: IndexStyleParams = Object.freeze({
  ...INDEX_DEFAULTS,
  name: "nq",
  settings: Object.freeze({ clusterRows: 12, quietBands: 16, minBandSize: 20, showPulled: true }),
  saturationMultiple: 1.5,
  monsterMultiple: 4,
});

export const nqLiquidityStyle = createIndexStyle(NQ_PARAMS);
