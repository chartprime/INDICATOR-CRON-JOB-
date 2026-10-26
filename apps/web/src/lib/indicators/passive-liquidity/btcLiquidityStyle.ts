// BTC (spot and perpetual) heatmap settings. The drawing is the crypto one,
// shared with every other pair and not to be changed here; only where BTC's
// settings start belongs in this file.

import { createCryptoStyle, type CryptoStyleParams } from "./cryptoLiquidityStyle";

export const BTC_PARAMS: CryptoStyleParams = Object.freeze({
  name: "btc",
  settings: Object.freeze({ clusterRows: 3, quietBands: 100, minBandSize: 8, showPulled: true }),
});

export const btcLiquidityStyle = createCryptoStyle(BTC_PARAMS);

export const BTC_PERP_PARAMS: CryptoStyleParams = Object.freeze({
  name: "btc-perp",
  settings: Object.freeze({ clusterRows: 10, quietBands: 7, minBandSize: 100, showPulled: true }),
});

export const btcPerpLiquidityStyle = createCryptoStyle(BTC_PERP_PARAMS);
