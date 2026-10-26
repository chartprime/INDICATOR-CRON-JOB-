// ETH (spot and perpetual) heatmap settings. The drawing is the crypto one,
// shared with BTC and not to be changed here; only where ETH's settings start
// belongs in this file.
//
// Why its own file: the cluster size is in server rows, and a row is about
// $4 on BTC but about $0.13 on ETH, so the two rows that make a sensible $8

import { createCryptoStyle, type CryptoStyleParams } from "./cryptoLiquidityStyle";

export const ETH_PARAMS: CryptoStyleParams = Object.freeze({
  name: "eth",
  settings: Object.freeze({ clusterRows: 10, quietBands: 16, minBandSize: 10, showPulled: true }),
});

export const ethLiquidityStyle = createCryptoStyle(ETH_PARAMS);

export const ETH_PERP_PARAMS: CryptoStyleParams = Object.freeze({
  name: "eth-perp",
  settings: Object.freeze({ clusterRows: 5, quietBands: 16, minBandSize: 1_000, showPulled: true }),
});

export const ethPerpLiquidityStyle = createCryptoStyle(ETH_PERP_PARAMS);
